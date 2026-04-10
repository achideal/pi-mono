# 第 10 章：Schema、校验与结构化参数

## 前置知识

本章建立在前几章的基础上。你需要理解：

- 工具调用的基本结构：`name`、`arguments`、`id`（第 4 章）
- 工具在 agent 循环中的执行流程（第 3 章）
- 消息格式中 `ToolCall` 和 `ToolResultMessage` 的角色（第 8 章）
- 流式输出中 `toolcall_delta` 和 `toolcall_end` 事件的含义（第 9 章）

如果这些概念还不清楚，建议先回顾对应章节。

## 本章聚焦的层次

本章聚焦于工具调用链条中一个容易被忽视但极其关键的环节——**参数的定义、校验与类型安全**。

在 pi-mono 的分层架构中，本章横跨 `packages/ai`（Schema 定义、校验函数）和 `packages/agent`（校验在循环中的集成），并涉及 `packages/coding-agent`（真实工具的 Schema 设计实践）。

## 为什么工具参数需要 Schema

上一章讲到，模型的输出本质上是一串 token——即使是工具调用，模型生成的也只是一段 JSON 字符串。问题在于：**模型生成的 JSON 不一定符合你的预期**。

举几个真实场景：

**场景一：类型错误**

你定义了一个工具，期望接收一个数字参数 `offset`：

```typescript
execute: async (toolCallId, params) => {
  const lines = content.split("\n").slice(params.offset);
  // ...
};
```

但模型返回的是 `{ "offset": "10" }`——一个字符串 `"10"` 而不是数字 `10`。在 JavaScript 中，`"10"` 作为 `slice` 的参数不会报错，但行为可能不符合预期。

**场景二：缺少必需字段**

你的工具需要 `path` 和 `content` 两个参数，但模型只返回了 `{ "path": "hello.txt" }`，漏掉了 `content`。如果不校验就直接执行，`params.content` 是 `undefined`，可能导致写入空文件或抛出运行时异常。

**场景三：多余字段**

模型返回了 `{ "path": "hello.txt", "content": "hello", "encoding": "utf-8" }`。你的工具不认识 `encoding` 参数。虽然多余字段通常无害，但如果你把整个 `params` 对象传给下游 API，多余字段可能导致意外行为。

**场景四：格式错误**

你期望 `startTime` 是 ISO 8601 格式的日期字符串（如 `"2024-01-15T10:00:00Z"`），但模型返回了 `"next Monday at 10am"`。

这些问题的根源是同一个：**模型不是程序员，它不会严格遵守类型约束**。它是一个概率生成器，会尽力匹配你描述的格式，但不保证 100% 正确。

Schema 的作用就是在工具执行之前，建立一道防线：

1. **定义**：明确告诉模型"这个工具接受什么参数、什么类型、什么格式"
2. **校验**：在执行之前检查模型返回的参数是否符合定义
3. **矫正**：在可能的情况下自动修复类型偏差（比如把字符串 `"10"` 转成数字 `10`）
4. **报错**：如果参数确实不对，生成清晰的错误信息返回给模型，让它重试

## TypeBox：pi-mono 的 Schema 选择

pi-mono 使用 [TypeBox](https://github.com/sinclairzx81/typebox) 作为 Schema 定义工具。TypeBox 是一个 TypeScript-first 的 JSON Schema 构建器，它的核心特点是：

**一份定义，两个用途**：

```typescript
import { Type, type Static } from "@sinclair/typebox";

// 定义 schema
const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from" }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read" }),
  ),
});

// 从 schema 自动推导 TypeScript 类型
type ReadParams = Static<typeof readSchema>;
// 等价于：
// type ReadParams = {
//   path: string;
//   offset?: number;
//   limit?: number;
// }
```

同一个 `readSchema` 对象同时是：

- **JSON Schema**：可以直接发送给 LLM API，告诉模型参数格式
- **TypeScript 类型源**：通过 `Static<typeof readSchema>` 推导出编译时类型
- **运行时校验器的输入**：可以交给 AJV 做运行时校验

这意味着你只需要写一次定义，就能同时获得：

- 模型看到的参数描述（JSON Schema）
- 代码中的类型检查（TypeScript 类型）
- 运行时的参数校验（AJV 校验）

三者始终保持同步，不会出现"Schema 说是 number，TypeScript 类型是 string，运行时不校验"这种不一致。

### 为什么不用 Zod

如果你熟悉 TypeScript 生态，可能会问：为什么不用 Zod？Zod 也能定义 schema 并推导类型。

关键区别在于**序列化能力**。TypeBox 生成的 schema 本身就是标准的 JSON Schema 对象，可以直接 `JSON.stringify` 后发送给 LLM API。Zod 的 schema 是 JavaScript 类对象，不能直接序列化为 JSON Schema——你需要额外的库（如 `zod-to-json-schema`）来转换。

在 pi-mono 的架构中，工具定义需要在多个层之间传递：

```
定义工具（coding-agent）
    ↓ 传递 schema
注册到 Agent（agent）
    ↓ 传递 schema
发送给 LLM API（ai → provider）
    ↓ 转换为 provider 格式
模型看到参数描述
```

TypeBox 的 schema 在整个链条中都是同一个 JSON 对象，不需要任何转换。这在 pi-mono 的代码中随处可见：

```typescript
// packages/ai/src/providers/openai-completions.ts
function convertTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any, // TypeBox 已经是 JSON Schema
    },
  }));
}
```

注释 `// TypeBox already generates JSON Schema` 在多个 provider 实现中反复出现。这不是巧合——这正是选择 TypeBox 的核心原因。

## Tool 接口中的 Schema

在 `packages/ai` 中，`Tool` 接口的定义非常简洁：

```typescript
// packages/ai/src/types.ts
import type { TSchema } from "@sinclair/typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

三个字段，各有明确职责：

- `name`：工具的唯一标识符，模型通过这个名字请求调用
- `description`：工具的功能描述，告诉模型什么时候该用这个工具
- `parameters`：参数的 JSON Schema，告诉模型参数的结构和类型

注意 `parameters` 的类型是泛型 `TParameters extends TSchema`。这意味着 TypeScript 编译器能追踪具体的 schema 类型，从而在 `execute` 函数中提供精确的参数类型推导。

在 `packages/agent` 中，`AgentTool` 扩展了 `Tool`，增加了执行能力：

```typescript
// packages/agent/src/types.ts
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>, // ← 类型安全的参数
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
```

关键在 `execute` 的 `params` 参数类型：`Static<TParameters>`。这是 TypeBox 的类型推导——如果你的 schema 是 `Type.Object({ path: Type.String() })`，那么 `params` 的类型就是 `{ path: string }`。编译器会在你写错字段名或用错类型时报错。

## Schema 如何变成模型看到的参数描述

当你定义了一个工具的 schema，它需要经过一系列转换才能到达模型。这个过程在不同 provider 中略有不同，但核心逻辑是一致的。

### TypeBox → JSON Schema

TypeBox 的 `Type.*` 函数生成的对象本身就是标准的 JSON Schema。例如：

```typescript
const schema = Type.Object({
  path: Type.String({ description: "File path" }),
  offset: Type.Optional(Type.Number({ description: "Start line" })),
});
```

生成的 JSON 对象等价于：

```json
{
  "type": "object",
  "properties": {
    "path": {
      "type": "string",
      "description": "File path"
    },
    "offset": {
      "type": "number",
      "description": "Start line"
    }
  },
  "required": ["path"]
}
```

`Type.Optional()` 的效果是把字段从 `required` 数组中移除，而不是改变字段的类型。

### JSON Schema → Provider 格式

每个 provider 对工具定义的格式要求不同，但都接受 JSON Schema 作为参数描述：

**OpenAI Chat Completions**：

```typescript
// packages/ai/src/providers/openai-completions.ts
function convertTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any, // 直接使用 JSON Schema
      strict: false,
    },
  }));
}
```

**Anthropic**：

```typescript
// packages/ai/src/providers/anthropic.ts
function convertTools(tools: Tool[]): Anthropic.Messages.Tool[] {
  return tools.map((tool) => {
    const jsonSchema = tool.parameters as any;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: "object",
        properties: jsonSchema.properties || {},
        required: jsonSchema.required || [],
      },
    };
  });
}
```

Anthropic 的格式稍有不同——它用 `input_schema` 而不是 `parameters`，而且需要显式提取 `properties` 和 `required`。但核心数据来源是同一个 TypeBox schema。

**Google Gemini**：

```typescript
// packages/ai/src/providers/google-shared.ts
export function convertTools(tools: Tool[], useParameters = false) {
  if (tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        ...(useParameters
          ? { parameters: tool.parameters }
          : { parametersJsonSchema: tool.parameters }),
      })),
    },
  ];
}
```

Google 有两种模式：`parametersJsonSchema`（支持完整 JSON Schema）和 `parameters`（OpenAPI 3.03 Schema，功能受限）。默认使用前者，只有在特定兼容场景下才回退到后者。

### description 字段的重要性

你可能注意到，TypeBox schema 中的 `description` 字段在每个例子中都出现了：

```typescript
Type.String({ description: "Path to the file to read" });
Type.Number({ description: "Line number to start reading from" });
```

这些 description 不是给人看的注释——它们会被包含在发送给模型的 JSON Schema 中。模型通过这些描述来理解每个参数的含义和用法。

一个好的 description 直接影响模型生成正确参数的概率。对比：

```typescript
// 差：模型不知道 offset 是从 0 开始还是从 1 开始
Type.Number({ description: "Offset" });

// 好：明确告诉模型语义
Type.Number({ description: "Line number to start reading from (1-indexed)" });
```

在 `packages/coding-agent` 的真实工具中，description 的写法非常讲究：

```typescript
// packages/coding-agent/src/core/tools/read.ts
const readSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute)",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read" }),
  ),
});
```

每个 description 都在回答模型最可能困惑的问题：路径是相对还是绝对？offset 从 0 还是 1 开始？limit 的单位是什么？

## 运行时校验：AJV

定义了 schema 之后，还需要在运行时校验模型返回的参数。pi-mono 使用 [AJV](https://ajv.js.org/)（Another JSON Schema Validator）来做这件事。

### 校验函数的实现

校验逻辑集中在 `packages/ai/src/utils/validation.ts` 中：

```typescript
// packages/ai/src/utils/validation.ts
import AjvModule from "ajv";
import addFormatsModule from "ajv-formats";

const Ajv = (AjvModule as any).default || AjvModule;
const addFormats = (addFormatsModule as any).default || addFormatsModule;

let ajv: any = null;
if (canUseRuntimeCodegen()) {
  try {
    ajv = new Ajv({
      allErrors: true, // 报告所有错误，不是遇到第一个就停
      strict: false, // 不严格模式，兼容 TypeBox 的扩展字段
      coerceTypes: true, // 自动类型矫正
    });
    addFormats(ajv); // 支持 format 校验（如 date-time、email）
  } catch (_e) {
    console.warn("AJV validation disabled due to CSP restrictions");
  }
}
```

三个关键配置：

- **`allErrors: true`**：收集所有校验错误，而不是遇到第一个就停止。这样模型能一次看到所有问题，而不是修一个报一个。
- **`strict: false`**：TypeBox 生成的 JSON Schema 可能包含 AJV 不认识的扩展字段（如 TypeBox 的内部元数据），关闭严格模式避免误报。
- **`coerceTypes: true`**：这是最重要的配置。它让 AJV 在校验时自动做类型转换——如果 schema 说是 `number`，但收到的是字符串 `"10"`，AJV 会自动转成数字 `10`。

### 类型矫正为什么重要

`coerceTypes: true` 解决了本章开头提到的"场景一"问题。模型经常把数字生成为字符串（因为 JSON 中数字和字符串的边界对模型来说并不总是清晰的）。

没有类型矫正时：

```
模型返回: { "offset": "10" }
schema 期望: offset: number
结果: 校验失败，返回错误给模型，模型重试
```

有类型矫正时：

```
模型返回: { "offset": "10" }
schema 期望: offset: number
结果: AJV 自动转换为 { "offset": 10 }，校验通过
```

类型矫正避免了不必要的重试，节省了 token 和时间。

### 校验流程

`validateToolArguments` 函数的完整流程：

```typescript
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
  // 1. 环境检查：如果无法使用运行时代码生成（如浏览器扩展），跳过校验
  if (!ajv || !canUseRuntimeCodegen()) {
    return toolCall.arguments;
  }

  // 2. 编译 schema（AJV 会缓存编译结果）
  const validate = ajv.compile(tool.parameters);

  // 3. 克隆参数（因为 AJV 会原地修改对象做类型矫正）
  const args = structuredClone(toolCall.arguments);

  // 4. 校验（同时做类型矫正）
  if (validate(args)) {
    return args; // 校验通过，返回可能被矫正过的参数
  }

  // 5. 校验失败，格式化错误信息
  const errors =
    validate.errors
      ?.map((err) => {
        const path = err.instancePath
          ? err.instancePath.substring(1)
          : err.params.missingProperty || "root";
        return `  - ${path}: ${err.message}`;
      })
      .join("\n") || "Unknown validation error";

  const errorMessage = `Validation failed for tool "${toolCall.name}":\n${errors}\n\nReceived arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`;

  throw new Error(errorMessage);
}
```

几个值得注意的设计细节：

**`structuredClone`**：AJV 在做类型矫正时会直接修改传入的对象。如果不克隆，原始的 `toolCall.arguments` 会被修改，可能影响日志记录或错误报告。

**错误信息格式**：校验失败时，错误信息包含两部分——具体哪些字段有什么问题，以及模型实际传了什么参数。这两部分信息都会返回给模型，帮助它理解错误并修正。

**环境降级**：在浏览器扩展等受限环境中（Chrome Manifest V3 禁止 `eval` 和 `new Function`），AJV 无法工作。此时校验被跳过，直接返回原始参数。这是一个务实的降级策略——宁可不校验也不能让整个系统崩溃。

### CSP 环境的处理

`canUseRuntimeCodegen` 函数检测当前环境是否支持运行时代码生成：

```typescript
const isBrowserExtension =
  typeof globalThis !== "undefined" &&
  (globalThis as any).chrome?.runtime?.id !== undefined;

function canUseRuntimeCodegen(): boolean {
  if (isBrowserExtension) {
    return false;
  }
  try {
    new Function("return true;");
    return true;
  } catch {
    return false;
  }
}
```

AJV 内部使用 `new Function()` 来编译 JSON Schema 为高效的校验函数。在 CSP（Content Security Policy）严格的环境中，`new Function()` 会被禁止。pi-mono 通过检测这个能力来决定是否启用校验。

这是一个典型的工程权衡：**校验是重要的，但不能因为校验而让系统在某些环境中完全不可用**。

## 校验在 Agent 循环中的位置

校验不是孤立发生的。它嵌入在 agent 循环的工具执行流程中，位于一个精确的位置。

### 完整的工具执行管线

当模型返回一个工具调用时，agent 循环会执行以下步骤：

```
模型返回 toolCall
    ↓
1. 查找工具（按 name 匹配）
    ↓ 找不到 → 返回错误给模型
2. prepareArguments（可选：参数预处理）
    ↓
3. validateToolArguments（AJV 校验 + 类型矫正）
    ↓ 校验失败 → 返回错误给模型
4. beforeToolCall（可选：拦截/审批）
    ↓ 被阻止 → 返回错误给模型
5. execute（真正执行工具）
    ↓ 执行失败 → 返回错误给模型
6. afterToolCall（可选：后处理）
    ↓
7. 返回结果给模型
```

校验位于第 3 步——在参数预处理之后、工具执行之前。这个位置的选择是有意的：

- 在 `prepareArguments` 之后：因为预处理可能修正了参数格式，校验应该针对修正后的参数
- 在 `beforeToolCall` 之前：因为拦截钩子需要看到已校验的参数，而不是原始的可能有错的参数
- 在 `execute` 之前：这是最后一道防线，确保传给工具的参数一定是合法的

### 代码中的实现

在 `packages/agent/src/agent-loop.ts` 中，`prepareToolCall` 函数串联了这个流程：

```typescript
// packages/agent/src/agent-loop.ts
async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  // 1. 查找工具
  const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
  if (!tool) {
    return {
      kind: "immediate",
      result: createErrorToolResult(`Tool ${toolCall.name} not found`),
      isError: true,
    };
  }

  try {
    // 2. 参数预处理
    const preparedToolCall = prepareToolCallArguments(tool, toolCall);
    // 3. Schema 校验
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    // 4. beforeToolCall 拦截
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          result: createErrorToolResult(
            beforeResult.reason || "Tool execution was blocked",
          ),
          isError: true,
        };
      }
    }
    // 校验通过，返回准备好的工具调用
    return { kind: "prepared", toolCall, tool, args: validatedArgs };
  } catch (error) {
    // 校验失败或其他错误
    return {
      kind: "immediate",
      result: createErrorToolResult(
        error instanceof Error ? error.message : String(error),
      ),
      isError: true,
    };
  }
}
```

注意错误处理的设计：校验失败不会导致 agent 崩溃。错误被捕获后，包装成 `ImmediateToolCallOutcome`，最终作为工具错误结果返回给模型。模型看到错误信息后，通常会修正参数重试。

这形成了一个**自修复循环**：

```
模型生成错误参数
    ↓
校验失败，错误信息返回给模型
    ↓
模型看到 "Validation failed for tool 'read_file':
  - offset: must be number
  Received arguments: { "path": "foo.txt", "offset": "abc" }"
    ↓
模型修正参数重试
    ↓
校验通过，工具执行
```

这个循环是 agent 鲁棒性的重要来源。模型不需要第一次就生成完美的参数——只要错误信息足够清晰，它通常能在一两次重试后修正。

## prepareArguments：校验前的参数预处理

有时候，模型生成的参数在语义上是正确的，但格式不完全匹配 schema。`prepareArguments` 提供了一个在校验之前修正参数的机会。

### 为什么需要预处理

考虑一个编辑工具，它的 schema 期望参数格式是：

```typescript
const editSchema = Type.Object({
  edits: Type.Array(
    Type.Object({
      oldText: Type.String(),
      newText: Type.String(),
    }),
  ),
});
```

但模型有时候会生成"扁平"格式：

```json
{
  "oldText": "foo",
  "newText": "bar"
}
```

而不是期望的嵌套格式：

```json
{
  "edits": [{ "oldText": "foo", "newText": "bar" }]
}
```

两种格式表达的意图完全相同，但后者才符合 schema。如果直接校验，前者会失败。

`prepareArguments` 可以在校验前做这种格式转换：

```typescript
const editTool: AgentTool = {
  name: "edit",
  parameters: editSchema,
  prepareArguments(args) {
    if (!args || typeof args !== "object") return args;
    const input = args as {
      edits?: Array<{ oldText: string; newText: string }>;
      oldText?: string;
      newText?: string;
    };
    // 如果模型用了扁平格式，转换为嵌套格式
    if (
      typeof input.oldText === "string" ||
      typeof input.newText === "string"
    ) {
      return {
        edits: [
          ...(input.edits ?? []),
          { oldText: input.oldText, newText: input.newText },
        ],
      };
    }
    return args;
  },
  execute: async (toolCallId, params) => {
    // params.edits 一定是数组格式
    // ...
  },
};
```

### 预处理的实现

在 agent-loop 中，预处理发生在校验之前：

```typescript
// packages/agent/src/agent-loop.ts
function prepareToolCallArguments(
  tool: AgentTool<any>,
  toolCall: AgentToolCall,
): AgentToolCall {
  if (!tool.prepareArguments) {
    return toolCall; // 没有预处理函数，直接返回
  }
  const preparedArguments = tool.prepareArguments(toolCall.arguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall; // 预处理没有修改参数，返回原始 toolCall
  }
  return {
    ...toolCall,
    arguments: preparedArguments as Record<string, any>,
  };
}
```

设计上的一个细节：如果 `prepareArguments` 返回的是同一个引用（`===` 比较），就不创建新的 toolCall 对象。这是一个性能优化——大多数情况下参数不需要预处理，避免不必要的对象创建。

### 预处理 vs 校验的职责边界

- **prepareArguments**：处理"格式对了但结构不完全匹配"的情况。它是一个**兼容层**，让工具能容忍模型的格式变体。
- **validateToolArguments**：处理"参数确实有错"的情况。它是一个**防护层**，确保传给 execute 的参数一定合法。

两者的执行顺序是固定的：先预处理，再校验。这意味着预处理的输出必须符合 schema——预处理不是绕过校验的后门。

## beforeToolCall 中的参数访问

校验通过后，`beforeToolCall` 钩子可以访问已校验的参数：

```typescript
const agent = new Agent({
  beforeToolCall: async ({ toolCall, args, context }) => {
    // args 是已经通过校验的参数
    if (toolCall.name === "bash" && typeof args === "object") {
      const command = (args as { command: string }).command;
      if (command.includes("rm -rf /")) {
        return { block: true, reason: "危险命令已被阻止" };
      }
    }
  },
});
```

注意 `args` 的类型是 `unknown`——因为 `beforeToolCall` 是一个通用钩子，它不知道具体是哪个工具的参数。调用方需要自己做类型断言。但可以确信的是：`args` 已经通过了 schema 校验，字段类型是正确的。

`beforeToolCall` 还有一个特殊行为：如果钩子直接修改了 `args` 对象的属性，修改后的值会被传给 `execute`，**而且不会重新校验**。这是有意的设计——钩子可能需要注入额外信息或修改参数值，这些修改不应该被 schema 校验阻止。

```typescript
beforeToolCall: async ({ args }) => {
  // 直接修改 args，修改后的值传给 execute，不重新校验
  const mutableArgs = args as { value: string | number };
  mutableArgs.value = 123;  // 即使 schema 说 value 是 string，这里也能改成 number
  return undefined;  // 不阻止执行
},
```

这是一个强大但需要谨慎使用的能力。

## Schema 如何影响模型行为

Schema 不仅仅是校验工具——它直接影响模型生成工具调用的质量。

### 模型看到的工具定义

当你定义了这样一个工具：

```typescript
const weatherTool: Tool = {
  name: "get_weather",
  description: "Get current weather for a location",
  parameters: Type.Object({
    location: Type.String({ description: "City name or coordinates" }),
    units: StringEnum(["celsius", "fahrenheit"], { default: "celsius" }),
  }),
};
```

模型在上下文中看到的（以 OpenAI 格式为例）大致是：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a location",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {
          "type": "string",
          "description": "City name or coordinates"
        },
        "units": {
          "type": "string",
          "enum": ["celsius", "fahrenheit"],
          "default": "celsius"
        }
      },
      "required": ["location", "units"]
    }
  }
}
```

模型会根据这个定义来生成参数。所以：

- **description 越清晰，模型生成的参数越准确**
- **类型约束越明确，模型越不容易犯错**
- **enum 值越具体，模型越不会编造不存在的选项**

### StringEnum：跨 provider 兼容的枚举

pi-mono 提供了一个 `StringEnum` 辅助函数，用于定义字符串枚举：

```typescript
// packages/ai/src/utils/typebox-helpers.ts
export function StringEnum<T extends readonly string[]>(
  values: T,
  options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> {
  return Type.Unsafe<T[number]>({
    type: "string",
    enum: values as any,
    ...(options?.description && { description: options.description }),
    ...(options?.default && { default: options.default }),
  });
}
```

为什么不直接用 TypeBox 的 `Type.Enum` 或 `Type.Union(Type.Literal(...))`？

因为 **Google 的 API 不支持 `anyOf`/`const` 模式**。TypeBox 的 `Type.Enum` 生成的 JSON Schema 使用 `anyOf` + `const` 模式：

```json
{
  "anyOf": [{ "const": "celsius" }, { "const": "fahrenheit" }]
}
```

而 Google Gemini API 只认识简单的 `enum` 数组：

```json
{
  "type": "string",
  "enum": ["celsius", "fahrenheit"]
}
```

`StringEnum` 直接生成后者，确保在所有 provider 上都能正常工作。这是一个典型的跨 provider 兼容性问题——看似简单的枚举定义，在不同 provider 间就有格式差异。

## 真实工具的 Schema 设计实践

让我们看看 `packages/coding-agent` 中真实工具的 schema 是怎么设计的。

### read_file 工具

```typescript
// packages/coding-agent/src/core/tools/read.ts
const readSchema = Type.Object({
  path: Type.String({
    description: "Path to the file to read (relative or absolute)",
  }),
  offset: Type.Optional(
    Type.Number({
      description: "Line number to start reading from (1-indexed)",
    }),
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum number of lines to read" }),
  ),
});
```

设计要点：

- `path` 是必需的——读文件必须知道路径
- `offset` 和 `limit` 是可选的——大多数情况下读整个文件，只有需要时才指定范围
- description 明确说明了 `offset` 是 1-indexed，避免模型传 0-indexed 的值
- 路径说明支持"relative or absolute"，给模型更大的灵活性

### 扩展工具的 Schema

在 `packages/coding-agent` 的扩展系统中，自定义工具的 schema 可以更复杂：

```typescript
// packages/coding-agent/docs/extensions.md 中的示例
const QuestionParams = Type.Object({
  question: Type.String({ description: "The question to ask the user" }),
  options: Type.Array(
    Type.Object({
      label: Type.String({ description: "Display label for the option" }),
      description: Type.Optional(
        Type.String({ description: "Optional description shown below label" }),
      ),
    }),
    { description: "Options for the user to choose from" },
  ),
});
```

这个 schema 定义了一个嵌套结构：顶层有 `question` 和 `options`，`options` 是一个对象数组，每个对象有 `label` 和可选的 `description`。TypeBox 能完整地表达这种嵌套结构，并且生成的 JSON Schema 能被所有 provider 正确理解。

## 校验失败时的错误反馈

校验失败时，错误信息的质量直接影响模型能否成功重试。

### 错误信息的结构

`validateToolArguments` 生成的错误信息包含三部分：

```
Validation failed for tool "read_file":
  - offset: must be number
  - path: must be string

Received arguments:
{
  "offset": "abc",
  "path": 123
}
```

1. **哪个工具**：`Validation failed for tool "read_file"`
2. **哪些字段有什么问题**：`- offset: must be number`
3. **模型实际传了什么**：完整的 JSON 参数

第三部分特别重要——模型需要看到自己传了什么，才能理解哪里出了错。

### 错误如何返回给模型

在 agent 循环中，校验错误被包装成工具错误结果：

```typescript
// 校验失败时
return {
  kind: "immediate",
  result: createErrorToolResult(error.message),
  isError: true,
};
```

这个错误结果最终变成一条 `ToolResultMessage`，`isError: true`，内容是错误信息。模型在下一轮推理时会看到这条消息，通常会修正参数重试。

### allErrors 的价值

AJV 配置了 `allErrors: true`，这意味着一次校验会报告所有错误。如果配置为 `false`（默认），AJV 遇到第一个错误就停止。

对比：

```
// allErrors: false（默认）
Validation failed for tool "edit":
  - oldText: must be string

// allErrors: true（pi-mono 的配置）
Validation failed for tool "edit":
  - oldText: must be string
  - newText: is required
  - path: must be string
```

一次报告所有错误，模型可以一次性修正所有问题，而不是修一个报一个，来回多轮。这在 token 成本和延迟上都有显著优势。

## 设计后果与权衡

### TypeBox vs 运行时校验的解耦

pi-mono 的设计中，TypeBox 和 AJV 是解耦的：

- TypeBox 负责**定义** schema（编译时）
- AJV 负责**校验** schema（运行时）
- 两者通过标准 JSON Schema 格式连接

这意味着如果将来要换掉 AJV（比如用更轻量的校验器），只需要改 `validation.ts` 一个文件，不影响任何工具定义。

### 校验的性能考量

AJV 会把 JSON Schema 编译成高效的校验函数，编译结果会被缓存。所以第一次校验某个 schema 时稍慢（需要编译），后续校验同一个 schema 时非常快。

在 agent 场景中，工具的 schema 在整个会话期间不会变化，所以编译只发生一次。校验本身的开销相比模型调用和工具执行来说可以忽略不计。

### 宽松校验 vs 严格校验

pi-mono 选择了宽松策略：

- `coerceTypes: true`：自动类型矫正
- `strict: false`：不拒绝未知的 schema 字段
- 环境不支持时跳过校验

这是一个务实的选择。在 agent 场景中，**让工具尽可能执行成功**比**严格拒绝不完美的参数**更重要。模型生成的参数大多数时候是"差不多对"的，类型矫正能把"差不多对"变成"完全对"。

严格校验的代价是更多的重试轮次，每次重试都消耗 token 和时间。宽松校验的代价是偶尔可能让不完全正确的参数通过——但这通常会在工具执行阶段被捕获。

### Schema 复杂度的权衡

Schema 越复杂，模型越难生成正确的参数。一个有 10 个必需字段、3 层嵌套的 schema，模型出错的概率远高于一个只有 2 个字段的简单 schema。

pi-mono 中真实工具的 schema 设计遵循几个原则：

1. **必需字段尽量少**：只有真正不可缺少的字段才设为必需
2. **可选字段给默认值**：让模型在不确定时可以省略
3. **嵌套尽量浅**：扁平结构比深层嵌套更容易被模型正确生成
4. **description 要具体**：模糊的描述导致模糊的参数

## 后续章节预告

本章讲解了 Schema 如何定义工具参数、AJV 如何在运行时校验、以及校验在 agent 循环中的位置和作用。

下一章（第 11 章：多模型切换与跨 provider handoff）会讨论另一个工程挑战：当你在运行时切换模型（比如从 Claude 切到 GPT-4o），消息格式、工具调用 ID、甚至 schema 的兼容性都需要处理。你会看到 `packages/ai` 中的 `transform-messages.ts` 是如何解决跨 provider 消息转换问题的。

## 小练习

1. **定义一个工具 Schema**：为一个"发送邮件"工具定义 TypeBox schema，包含收件人（必需，email 格式）、主题（必需，至少 1 个字符）、正文（必需）、抄送（可选，email 数组）、优先级（可选，枚举：low/normal/high）。思考每个字段的 description 应该怎么写。

   > **关键信息**：
   >
   > ```typescript
   > import { Type } from "@sinclair/typebox";
   > import { StringEnum } from "@mariozechner/pi-ai";
   >
   > const sendEmailSchema = Type.Object({
   >   to: Type.String({
   >     format: "email",
   >     description: "Recipient email address (e.g. user@example.com)",
   >   }),
   >   subject: Type.String({
   >     minLength: 1,
   >     description: "Email subject line, must not be empty",
   >   }),
   >   body: Type.String({
   >     description: "Email body content, supports plain text",
   >   }),
   >   cc: Type.Optional(
   >     Type.Array(Type.String({ format: "email" }), {
   >       description: "Optional list of CC recipient email addresses",
   >     }),
   >   ),
   >   priority: Type.Optional(
   >     StringEnum(["low", "normal", "high"], {
   >       default: "normal",
   >       description: "Email priority level, defaults to normal",
   >     }),
   >   ),
   > });
   > ```
   >
   > 设计要点：
   >
   > - 使用 `format: "email"` 让 AJV 校验邮箱格式（需要 `ajv-formats` 插件，pi-mono 已经加载）
   > - 使用 `minLength: 1` 防止空主题
   > - 使用 `StringEnum` 而不是 `Type.Enum` 确保 Google API 兼容
   > - 可选字段用 `Type.Optional` 包裹
   > - 每个 description 都回答"这个字段是什么、格式是什么、有什么约束"

2. **理解类型矫正**：假设你的 schema 定义了 `count: Type.Number()`，模型返回了 `{ "count": "42" }`。在 `coerceTypes: true` 和 `coerceTypes: false` 两种配置下，分别会发生什么？如果模型返回的是 `{ "count": "not a number" }`，两种配置下又会发生什么？

   > **关键信息**：
   >
   > | 输入值                        | `coerceTypes: true`                 | `coerceTypes: false`             |
   > | ----------------------------- | ----------------------------------- | -------------------------------- |
   > | `{ "count": "42" }`           | 校验通过，`count` 被矫正为数字 `42` | 校验失败：`count must be number` |
   > | `{ "count": "not a number" }` | 校验失败：`count must be number`    | 校验失败：`count must be number` |
   >
   > `coerceTypes: true` 只能做"合理的"类型转换——字符串 `"42"` 可以转成数字 `42`，但字符串 `"not a number"` 无法转成有效数字，所以仍然校验失败。AJV 的类型矫正规则包括：字符串→数字（如果字符串是有效数字）、字符串→布尔（`"true"`/`"false"`）、数字→字符串等。它不会做"猜测性"的转换。
   >
   > 这就是为什么 pi-mono 选择 `coerceTypes: true`——它能修复大多数"模型把数字写成字符串"的常见错误，同时不会掩盖真正的参数错误。

3. **看代码**：阅读 `packages/agent/src/agent-loop.ts` 中的 `prepareToolCall` 函数，追踪从 `toolCall.arguments`（模型原始输出）到 `validatedArgs`（传给 execute 的参数）的完整转换链。特别注意：如果 `prepareArguments` 和 `validateToolArguments` 都修改了参数，最终传给 `execute` 的是哪个版本？

   > **关键信息**：完整的参数转换链是：
   >
   > ```
   > toolCall.arguments（模型原始输出）
   >     ↓ prepareToolCallArguments(tool, toolCall)
   > preparedToolCall.arguments（预处理后的参数）
   >     ↓ validateToolArguments(tool, preparedToolCall)
   > validatedArgs（校验 + 类型矫正后的参数）
   >     ↓ 传给 beforeToolCall 的 args
   > validatedArgs（可能被 beforeToolCall 原地修改）
   >     ↓ 传给 tool.execute 的 params
   > ```
   >
   > 关键观察：
   >
   > - `prepareArguments` 的输出被包装成新的 `toolCall` 对象（`preparedToolCall`），然后传给 `validateToolArguments`
   > - `validateToolArguments` 内部会 `structuredClone` 参数再校验，所以返回的 `validatedArgs` 是一个全新的对象
   > - `beforeToolCall` 接收的 `args` 就是 `validatedArgs`，如果钩子直接修改了这个对象的属性，修改会传递到 `execute`（因为是同一个引用）
   > - 最终传给 `execute` 的是 `validatedArgs`（可能被 `beforeToolCall` 修改过的版本）
   >
   > 所以答案是：传给 `execute` 的是经过 `prepareArguments` → `validateToolArguments`（含 `structuredClone` + AJV 类型矫正）→ 可能被 `beforeToolCall` 原地修改后的最终版本。整个链条中，每一步都可能修改参数，但修改是有序的、可追踪的。

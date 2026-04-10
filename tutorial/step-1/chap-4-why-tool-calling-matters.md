# 第 4 章：为什么工具调用是分水岭

## 前置知识

本章建立在前三章的基础上。你需要理解：

- LLM 是一个基于 token 的文本生成器，本身不能执行任何外部动作（第 1 章）
- Agent 是模型 + 循环 + 工具 + 状态的组合，通过动态决策驱动外部动作（第 2 章）
- Agent 的最小闭环是"用户消息 → 模型响应 → 工具调用 → 工具结果 → 继续推理"（第 3 章）

如果这些概念还不清楚，建议先回顾前面的章节。

## 本章聚焦的层次

本章聚焦于 agent 系统中最关键的转折点——**工具调用**（tool calling）。我们要搞清楚：工具调用的完整结构是什么、它在代码中是怎样定义和执行的、为什么它是把 LLM 从"会说"变成"会做"的分水岭。

在 pi-mono 的分层架构中，本章横跨 `packages/ai`（工具的类型定义和参数校验）和 `packages/agent`（工具的执行流程），并以 `packages/coding-agent`（具体工具实现）为例展示真实工具的样子。

## 从"会说"到"会做"

第 1 章讲过，LLM 只是一个文本生成器。你问它"当前目录有哪些文件"，它只能猜测或编造一个答案。它没有文件系统访问能力，没有网络能力，没有执行命令的能力。

第 2 章讲过，agent 通过循环和工具让模型"做事"。但我们还没有深入讨论工具调用本身的结构。

工具调用是整个 agent 系统的关键转折点，因为它解决了一个根本问题：

> **如何让一个只能输出文本的系统，驱动真实世界的动作？**

答案是：不让模型直接执行动作，而是让模型**请求**执行动作。模型输出一段结构化的"请求"（tool call），外围系统解析这个请求并真正执行，然后把结果喂回模型。

这个看似简单的机制，是 agent 和聊天助手之间最本质的区别。

## 工具调用的三层结构

一次完整的工具调用涉及三个层面的结构：

### 1. Tool Schema：告诉模型"你能做什么"

在调用模型之前，你需要告诉模型有哪些工具可用。这通过 **tool schema** 实现——一个描述工具名称、功能和参数的结构化定义。

在 pi-mono 中，最底层的工具定义是 `packages/ai` 中的 `Tool` 接口：

```typescript
// packages/ai/src/types.ts
import type { TSchema } from "@sinclair/typebox";

export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
```

三个字段：

- **name**：工具的唯一标识符，模型通过这个名字来请求调用
- **description**：自然语言描述，告诉模型这个工具能做什么、什么时候该用
- **parameters**：参数的 JSON Schema，定义工具接受什么输入

这个 schema 会被序列化后发送给 LLM。模型在生成回复时，如果判断需要调用工具，就会输出一个符合 schema 的工具调用请求。

### 2. Tool Call：模型说"我想做这件事"

当模型决定调用工具时，它会在输出中生成一个 `ToolCall` 结构：

```typescript
// packages/ai/src/types.ts
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
}
```

四个字段：

- **type**：固定为 `"toolCall"`，用于区分文本、思考等其他内容类型
- **id**：这次工具调用的唯一标识符，用于将结果和请求配对
- **name**：要调用的工具名称，必须是 schema 中定义过的
- **arguments**：工具参数，一个 JSON 对象

第 1 章讲过，LLM 并不真的"调用"工具——它只是生成了一段表达调用意图的结构化输出。各 provider 的 API 层会把这段输出从普通文本中分离出来，pi-mono 的 provider 代码再把它翻译成统一的 `toolcall_start` → `toolcall_delta` → `toolcall_end` 事件。

一个实际的 ToolCall 可能长这样：

```typescript
{
  type: "toolCall",
  id: "call_abc123",
  name: "read",
  arguments: {
    path: "src/config.ts",
    offset: 1,
    limit: 50
  }
}
```

### 3. Tool Result：告诉模型"结果是这样的"

工具执行完成后，结果通过 `ToolResultMessage` 喂回模型：

```typescript
// packages/ai/src/types.ts
export interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

关键字段：

- **toolCallId**：和 `ToolCall.id` 配对，告诉模型"这是你之前那个请求的结果"
- **content**：返回给模型的内容，可以是文本或图片
- **isError**：标记这次执行是否失败
- **details**：结构化的详情数据，用于日志或 UI，**不会**发送给模型

`toolCallId` 的配对机制至关重要。模型可能在一次回复中请求多个工具调用，每个调用都有独立的 `id`。工具结果通过 `toolCallId` 和对应的请求关联，模型才能知道哪个结果对应哪个请求。

## 完整的数据流

把三层结构串起来，一次工具调用的完整数据流是：

```
1. 构建上下文
   Context = {
     systemPrompt: "...",
     messages: [...历史消息...],
     tools: [                          ← Tool Schema
       { name: "read", description: "...", parameters: {...} },
       { name: "edit", description: "...", parameters: {...} },
       { name: "bash", description: "...", parameters: {...} },
     ]
   }

2. 发送给 LLM
   stream(model, context) → 事件流

3. 模型输出包含工具调用
   AssistantMessage.content = [
     { type: "text", text: "我来读取这个文件" },
     { type: "toolCall",                    ← Tool Call
       id: "call_abc",
       name: "read",
       arguments: { path: "config.ts" }
     }
   ]

4. Agent runtime 执行工具
   tool.execute("call_abc", { path: "config.ts" })
   → { content: [{ type: "text", text: "文件内容..." }], details: {...} }

5. 构造工具结果消息
   ToolResultMessage = {                    ← Tool Result
     role: "toolResult",
     toolCallId: "call_abc",
     toolName: "read",
     content: [{ type: "text", text: "文件内容..." }],
     isError: false,
   }

6. 把结果加入上下文，再次调用模型
   messages.push(assistantMessage)
   messages.push(toolResultMessage)
   stream(model, { ...context, messages }) → 下一轮事件流
```

这个流程会反复执行，直到模型不再请求工具调用（`stopReason` 为 `"stop"` 而不是 `"toolUse"`）。

## 在 pi-mono 中，工具是怎样定义的

pi-mono 有两层工具抽象：

### 底层：AgentTool

`packages/agent` 定义了 `AgentTool`，在 `Tool` 的基础上增加了执行能力：

```typescript
// packages/agent/src/types.ts
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  /** 人类可读的标签，用于 UI 显示 */
  label: string;
  /** 可选的参数预处理 */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** 执行工具调用 */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
```

相比 `Tool`，`AgentTool` 多了四样东西：

1. **label**：人类可读的标签，用于 UI 显示（比如"Read File"）
2. **prepareArguments**：可选的参数预处理函数，在 schema 验证之前对原始参数做兼容性处理
3. **execute**：真正执行工具的函数
4. **onUpdate**：流式进度回调，让工具可以在执行过程中报告中间状态

`Tool` 只是一个"描述"——告诉模型有什么工具。`AgentTool` 是一个"可执行的描述"——既告诉模型有什么工具，又知道怎么执行。

### 产品层：ToolDefinition

`packages/coding-agent` 在 `AgentTool` 之上又定义了 `ToolDefinition`，增加了产品级功能：

```typescript
// packages/coding-agent/src/core/extensions/types.ts
export interface ToolDefinition<TParams extends TSchema, TDetails, TState> {
  name: string;
  label: string;
  description: string;
  /** 系统提示词中的工具摘要 */
  promptSnippet?: string;
  /** 系统提示词中的使用指南 */
  promptGuidelines?: string[];
  parameters: TParams;
  prepareArguments?: (args: unknown) => Static<TParams>;
  /** 执行工具，额外接收 ExtensionContext */
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;
  /** 自定义工具调用的 UI 渲染 */
  renderCall?: (...) => Component;
  /** 自定义工具结果的 UI 渲染 */
  renderResult?: (...) => Component;
}
```

相比 `AgentTool`，`ToolDefinition` 多了：

- **promptSnippet / promptGuidelines**：自动注入系统提示词的内容，让模型更好地理解工具
- **ExtensionContext**：执行时可以访问会话状态、设置等上下文
- **renderCall / renderResult**：自定义 UI 渲染，控制工具调用和结果在终端中的显示方式

三层工具抽象的关系是：

```
Tool（packages/ai）
  ↓ 继承
AgentTool（packages/agent）
  ↓ 适配
ToolDefinition（packages/coding-agent）
```

`ToolDefinition` 通过 `wrapToolDefinition` 函数转换为 `AgentTool`：

```typescript
// packages/coding-agent/src/core/tools/tool-definition-wrapper.ts
export function wrapToolDefinition<TDetails>(
  definition: ToolDefinition<any, TDetails>,
  ctxFactory?: () => ExtensionContext,
): AgentTool<any, TDetails> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    prepareArguments: definition.prepareArguments,
    execute: (toolCallId, params, signal, onUpdate) =>
      definition.execute(
        toolCallId,
        params,
        signal,
        onUpdate,
        ctxFactory?.() as ExtensionContext,
      ),
  };
}
```

这种分层设计让每一层只关心自己的职责：

- `Tool`：给模型看的描述
- `AgentTool`：给 agent runtime 用的可执行工具
- `ToolDefinition`：给产品层用的完整工具定义（包含 UI、提示词、上下文）

## 一个真实工具的解剖：read

让我们以 `packages/coding-agent` 中的 `read` 工具为例，看看一个真实工具的完整结构。

### Schema 定义

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
    Type.Number({
      description: "Maximum number of lines to read",
    }),
  ),
});
```

`readSchema` 使用 TypeBox（一个 TypeScript-first 的 JSON Schema 构建库）定义了三个参数：

- `path`：必填，文件路径
- `offset`：可选，从第几行开始读
- `limit`：可选，最多读多少行

TypeBox 的好处是：schema 定义和 TypeScript 类型是同一份代码。`Static<typeof readSchema>` 自动推导出 `{ path: string; offset?: number; limit?: number }`，不需要手动维护类型定义。

### Description：告诉模型怎么用

```typescript
description: `Read the contents of a file. Supports text files and images
(jpg, png, gif, webp). Images are sent as attachments. For text files,
output is truncated to ${DEFAULT_MAX_LINES} lines or
${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit
for large files. When you need the full file, continue with offset until
complete.`,
```

注意这段描述不只是说"读文件"。它还告诉模型：

- 支持哪些文件类型
- 输出有截断限制
- 大文件应该用 offset/limit 分段读取
- 怎样读取完整文件

这些信息直接影响模型的行为。如果描述写得不好，模型可能不知道用 offset 参数，导致大文件只能读到前面一部分。

### promptSnippet 和 promptGuidelines

```typescript
promptSnippet: "Read file contents",
promptGuidelines: [
  "Use read to examine files instead of cat or sed."
],
```

这些内容会被自动注入到系统提示词中：

- `promptSnippet` 出现在"Available tools"列表中，让模型快速了解工具用途
- `promptGuidelines` 出现在"Guidelines"部分，引导模型的使用习惯

比如 `"Use read to examine files instead of cat or sed."` 这条指南，防止模型用 bash 工具执行 `cat` 命令来读文件——那样做虽然也能工作，但 `read` 工具有截断保护、图片支持等优势。

### Execute：真正做事的代码

`read` 工具的 `execute` 函数做了以下事情：

1. **路径解析**：把相对路径转换为绝对路径
2. **权限检查**：确认文件存在且可读
3. **类型判断**：检测是图片还是文本文件
4. **图片处理**：如果是图片，读取并可选地缩放，返回 base64 编码的图片内容
5. **文本处理**：如果是文本，应用 offset/limit，执行截断保护
6. **中断支持**：通过 `AbortSignal` 支持随时取消

执行结果的结构是：

```typescript
{
  content: [{ type: "text", text: "文件内容..." }],  // 返回给模型
  details: { truncation: { ... } }                    // 用于 UI 显示
}
```

`content` 会进入上下文，占用 token。`details` 不进入上下文，可以包含更丰富的元数据。

### 截断保护：工具设计的关键

`read` 工具有一个重要的设计决策：**输出截断**。

```
output is truncated to 2000 lines or 256KB (whichever is hit first)
```

为什么要截断？因为如果模型请求读取一个 10MB 的日志文件，不截断的话：

1. 工具结果会占用大量上下文窗口，可能直接撑爆
2. 即使没撑爆，模型处理这么多内容的效果也会很差
3. Token 费用会暴涨

截断后，工具会在结果末尾附加提示：

```
[Showing lines 1-2000 of 15000 (256KB limit). Use offset=2001 to continue.]
```

这让模型知道文件没读完，可以用 offset 参数继续读取。这是一个典型的"工具设计影响 agent 行为"的例子——通过工具的输出格式，引导模型做出正确的后续决策。

## 另一个真实工具的解剖：edit

`edit` 工具展示了工具设计中的另一组重要考量。

### Schema 定义

```typescript
const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description:
        "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
    }),
    newText: Type.String({
      description: "Replacement text for this targeted edit.",
    }),
  },
  { additionalProperties: false },
);

const editSchema = Type.Object(
  {
    path: Type.String({
      description: "Path to the file to edit (relative or absolute)",
    }),
    edits: Type.Array(replaceEditSchema, {
      description:
        "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits.",
    }),
  },
  { additionalProperties: false },
);
```

注意几个设计要点：

1. **精确匹配**：`oldText` 必须和文件中的内容完全一致，不是模糊匹配
2. **唯一性约束**：`oldText` 必须在文件中唯一，避免歧义
3. **非增量**：所有 edit 都是基于原始文件匹配，不是基于前一个 edit 的结果
4. **`additionalProperties: false`**：禁止模型传入未定义的参数

这些约束通过 description 传达给模型。模型在生成工具调用时，会尽量遵守这些规则。但模型不是 100% 可靠的——它可能生成不唯一的 `oldText`，或者传入重叠的 edit。这就是为什么需要参数验证和错误处理。

### prepareArguments：兼容性处理

```typescript
prepareArguments: prepareEditArguments,
```

`prepareEditArguments` 函数处理一个常见问题：模型可能用旧格式传参。

```typescript
function prepareEditArguments(input: unknown): EditToolInput {
  const args = input as LegacyEditToolInput;
  // 如果模型用了旧的 oldText/newText 顶层字段，转换为 edits[] 格式
  if (typeof args.oldText === "string" || typeof args.newText === "string") {
    const edits = Array.isArray(args.edits) ? [...args.edits] : [];
    edits.push({ oldText: args.oldText, newText: args.newText });
    return { ...rest, edits };
  }
  return input as EditToolInput;
}
```

这是一个重要的工程实践：**工具应该对模型的输出格式有一定的容错能力**。模型可能不完全遵循 schema，特别是在 schema 发生变更后。`prepareArguments` 提供了一个在验证之前修正参数的机会。

## 参数验证：不信任模型的输出

模型生成的工具调用参数可能不符合 schema。pi-mono 使用 AJV（一个高性能的 JSON Schema 验证库）来验证参数：

```typescript
// packages/ai/src/utils/validation.ts
export function validateToolArguments(tool: Tool, toolCall: ToolCall): any {
  if (!ajv || !canUseRuntimeCodegen()) {
    return toolCall.arguments; // 降级：跳过验证
  }

  const validate = ajv.compile(tool.parameters);
  const args = structuredClone(toolCall.arguments);

  if (validate(args)) {
    return args; // 验证通过，返回（可能被类型强转的）参数
  }

  // 验证失败，生成详细错误信息
  const errors = validate.errors
    ?.map((err) => {
      const path = err.instancePath
        ? err.instancePath.substring(1)
        : err.params.missingProperty || "root";
      return `  - ${path}: ${err.message}`;
    })
    .join("\n");

  throw new Error(
    `Validation failed for tool "${toolCall.name}":\n${errors}\n\n` +
      `Received arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`,
  );
}
```

几个关键设计决策：

**1. 类型强转（coerceTypes: true）**

AJV 配置了 `coerceTypes: true`，这意味着如果 schema 要求 `number` 但模型传了 `"42"`（字符串），AJV 会自动转换为 `42`。这很重要，因为模型生成的 JSON 参数有时会把数字写成字符串。

**2. 结构化克隆（structuredClone）**

验证前先克隆参数，因为 AJV 的类型强转会直接修改输入对象。克隆确保原始参数不被污染。

**3. 详细的错误信息**

验证失败时，错误信息包含具体哪个字段出了什么问题，以及模型实际传了什么参数。这个错误信息会作为工具结果返回给模型，模型看到后通常会修正参数重试。

**4. 优雅降级**

在浏览器扩展等限制 `eval` 的环境中，AJV 无法工作（它依赖运行时代码生成）。这时验证会被跳过，直接返回原始参数。这是一个务实的工程决策——宁可跳过验证也不要让整个系统崩溃。

## 工具执行的完整流程

在 `packages/agent/src/agent-loop.ts` 中，工具执行经过五个阶段：

### 阶段 1：查找工具

```typescript
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
  return {
    kind: "immediate",
    result: createErrorToolResult(`Tool ${toolCall.name} not found`),
    isError: true,
  };
}
```

如果模型请求了一个不存在的工具（比如拼错了名字），直接返回错误。模型会看到这个错误并尝试修正。

### 阶段 2：参数预处理和验证

```typescript
const preparedToolCall = prepareToolCallArguments(tool, toolCall);
const validatedArgs = validateToolArguments(tool, preparedToolCall);
```

先通过 `prepareArguments` 做兼容性处理，再通过 `validateToolArguments` 做 schema 验证。如果验证失败，抛出的错误会被捕获并转换为错误结果返回给模型。

### 阶段 3：beforeToolCall 拦截

```typescript
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
```

`beforeToolCall` 是一个关键的控制点。它在工具执行之前被调用，可以：

- **阻止执行**：返回 `{ block: true }` 阻止危险操作
- **审计记录**：记录所有工具调用用于安全审计
- **用户确认**：在 coding-agent 中，某些操作（如写文件、执行命令）需要用户手动批准

这是"不该全靠 prompt"的典型例子。你可以在 system prompt 中告诉模型"不要执行 rm -rf"，但模型可能忽略这个指令。`beforeToolCall` 提供了程序级别的硬控制。

### 阶段 4：执行

```typescript
const result = await prepared.tool.execute(
  prepared.toolCall.id,
  prepared.args,
  signal,
  (partialResult) => {
    emit({
      type: "tool_execution_update",
      toolCallId: prepared.toolCall.id,
      toolName: prepared.toolCall.name,
      args: prepared.toolCall.arguments,
      partialResult,
    });
  },
);
```

工具的 `execute` 函数被调用。执行过程中可以通过 `onUpdate` 回调流式报告进度，agent 会发出 `tool_execution_update` 事件，UI 可以据此显示进度。

如果执行抛出异常，会被捕获并转换为错误结果：

```typescript
catch (error) {
  return {
    result: createErrorToolResult(
      error instanceof Error ? error.message : String(error)
    ),
    isError: true,
  };
}
```

注意：工具执行失败**不会**导致 agent 崩溃。错误被优雅地转换为工具结果，模型会看到错误信息并决定下一步——可能重试、换一种方式、或者告诉用户出了什么问题。

### 阶段 5：afterToolCall 后处理

```typescript
if (config.afterToolCall) {
  const afterResult = await config.afterToolCall(
    {
      assistantMessage,
      toolCall: prepared.toolCall,
      args: prepared.args,
      result,
      isError,
      context: currentContext,
    },
    signal,
  );
  if (afterResult) {
    result = {
      content: afterResult.content ?? result.content,
      details: afterResult.details ?? result.details,
    };
    isError = afterResult.isError ?? isError;
  }
}
```

`afterToolCall` 在工具执行完成后被调用，可以：

- **截断过长的结果**：防止工具结果撑爆上下文
- **修改错误标记**：把某些"技术上失败但逻辑上成功"的结果标记为成功
- **注入额外信息**：在结果中添加上下文相关的提示

## 并行 vs 串行执行

模型可能在一次回复中请求多个工具调用。比如模型说"我需要同时读取三个文件"，然后输出三个 `read` 工具调用。

pi-mono 支持两种执行模式：

### 并行执行（默认）

```typescript
// packages/agent/src/agent-loop.ts
async function executeToolCallsParallel(...) {
  const runnableCalls: PreparedToolCall[] = [];

  // 第一步：顺序做参数验证和 beforeToolCall 检查
  for (const toolCall of toolCalls) {
    const preparation = await prepareToolCall(...);
    if (preparation.kind === "immediate") {
      results.push(await emitToolCallOutcome(...));
    } else {
      runnableCalls.push(preparation);
    }
  }

  // 第二步：并发执行所有通过检查的工具
  const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executePreparedToolCall(prepared, signal, emit),
  }));

  // 第三步：按原始顺序收集结果
  for (const running of runningCalls) {
    const executed = await running.execution;
    results.push(await finalizeExecutedToolCall(...));
  }
}
```

注意并行执行的三个阶段：

1. **顺序预检**：参数验证和 `beforeToolCall` 是顺序执行的。这是因为 `beforeToolCall` 可能需要用户交互（比如确认对话框），并行弹出多个确认框会让用户困惑。
2. **并发执行**：所有通过预检的工具同时开始执行。三个 `read` 调用会同时发起文件读取，而不是等一个读完再读下一个。
3. **顺序收集**：结果按原始顺序返回给模型。即使第三个工具先执行完，它的结果也排在第三个位置。这保证了模型看到的结果顺序和它请求的顺序一致。

### 串行执行

```typescript
async function executeToolCallsSequential(...) {
  for (const toolCall of toolCalls) {
    // 每个工具完整走完 prepare → execute → finalize 后才开始下一个
    const preparation = await prepareToolCall(...);
    if (preparation.kind === "immediate") {
      results.push(await emitToolCallOutcome(...));
    } else {
      const executed = await executePreparedToolCall(...);
      results.push(await finalizeExecutedToolCall(...));
    }
  }
}
```

串行执行更简单，但更慢。它适用于工具之间有依赖关系的场景——比如先创建目录，再在目录中创建文件。

选择哪种模式通过配置指定：

```typescript
const agent = new Agent({
  toolExecution: "parallel", // 或 "sequential"
});
```

## 工具调用 ID 的跨 provider 兼容问题

第 1 章提到过，不同 provider 的工具调用 ID 格式不兼容。这个问题在实际工程中会造成真实的 bug。

举个例子：

- **Anthropic** 生成的 ID 格式是 `toolu_01ABC...`，要求匹配 `^[a-zA-Z0-9_-]+$`，最长 64 字符
- **OpenAI Responses API** 生成的 ID 可以超过 450 个字符，包含 `|` 等特殊字符

如果用户在对话中途从 Anthropic 切换到 OpenAI，历史消息中的 Anthropic 工具调用 ID 需要被 OpenAI 理解。反过来也一样。

pi-mono 在 `packages/ai` 中有专门的 ID 归一化逻辑来处理这个问题。这是一个典型的"看起来简单但实际很复杂"的工程细节。

## 工具设计的原则

从 pi-mono 的工具实现中，可以总结出几条工具设计原则：

### 1. Description 是工具最重要的部分

模型完全依赖 description 来决定何时使用工具、怎么使用。一个好的 description 应该：

- 说清楚工具能做什么
- 说清楚工具的限制（比如截断行为）
- 给出使用建议（比如"大文件用 offset/limit"）
- 避免歧义

### 2. 参数 schema 要尽量简单

模型生成 JSON 参数时容易出错。参数越复杂，出错概率越高。pi-mono 的工具参数通常只有 2-4 个字段，类型以 `string` 和 `number` 为主。

### 3. 工具结果要可操作

好的工具结果不只是返回数据，还要告诉模型"接下来可以做什么"。比如 `read` 工具在截断时会说 `"Use offset=2001 to continue."`，这直接引导模型的下一步行为。

### 4. 错误处理要对模型友好

工具执行失败时，错误信息应该是模型能理解的自然语言，而不是堆栈跟踪。模型看到 `"File not found: config.ts"` 可以决定换一个路径重试；看到一堆 `at Object.<anonymous> (/usr/lib/...)` 则无从下手。

### 5. 不要信任模型的参数

即使 schema 定义得很严格，模型也可能传入不符合预期的参数。`prepareArguments` 提供兼容性处理，`validateToolArguments` 提供强制校验，`execute` 内部还应该有自己的防御性检查。

### 6. 控制工具结果的大小

工具结果会进入上下文，占用 token。一个返回 10MB 文件内容的工具会直接撑爆上下文窗口。所有返回大量数据的工具都应该有截断机制。

## 设计后果与权衡

### 为什么工具调用用 JSON 而不是自然语言

模型可以用自然语言表达"我想读取 config.ts 文件"，为什么要用结构化的 JSON？

因为自然语言有歧义。"读取 config.ts 文件"可能意味着：

- 读取当前目录的 config.ts
- 读取 src/config.ts
- 读取所有名为 config.ts 的文件

JSON schema 强制模型给出明确的参数值，消除歧义。而且 JSON 可以被程序可靠地解析，自然语言不行。

### 为什么 content 和 details 分开

`AgentToolResult` 把返回给模型的 `content` 和用于 UI/日志的 `details` 分开：

```typescript
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[]; // 给模型看
  details: T; // 给 UI/日志看
}
```

这是因为两者的需求不同：

- `content` 要尽量精简（节省 token），只包含模型需要的信息
- `details` 可以包含丰富的结构化数据（diff 内容、截断信息、执行时间等），用于 UI 渲染和调试

如果把所有信息都塞进 `content`，要么浪费 token，要么 UI 信息不够丰富。分开后两边都能做到最优。

### 为什么 beforeToolCall 是顺序的而不是并行的

即使在并行执行模式下，`beforeToolCall` 也是顺序调用的。这是因为 `beforeToolCall` 最常见的用途是用户确认——弹出一个对话框问用户"是否允许执行这个操作"。如果并行弹出多个确认框，用户体验会很差。

顺序预检 + 并行执行的组合，在安全性和性能之间取得了平衡。

## 后续章节预告

本章深入讨论了工具调用的结构、定义、执行和设计原则。工具调用让模型从"会说"变成"会做"，是 agent 系统的关键转折点。

下一章（第 5 章：上下文为什么总是不够用）会讨论另一个核心问题：当工具结果、历史消息、系统提示词不断累积，上下文窗口很快就会被撑满。怎么管理这个有限的资源，直接决定了 agent 的表现上限。

## 小练习

1. **设计一个工具 schema**：假设你要为 agent 添加一个"搜索代码"工具，设计它的 `name`、`description` 和 `parameters`。思考：description 中应该包含哪些使用建议？参数应该有哪些？

   > **关键信息**：可以参考 pi-mono 中已有的 `grep` 工具。一个好的代码搜索工具 schema 可能是：
   >
   > ```typescript
   > const grepSchema = Type.Object({
   >   pattern: Type.String({
   >     description: "Search pattern (regular expression or literal string)",
   >   }),
   >   path: Type.Optional(
   >     Type.String({
   >       description:
   >         "Directory or file to search in (default: current directory)",
   >     }),
   >   ),
   >   include: Type.Optional(
   >     Type.String({
   >       description: "File glob pattern to include (e.g., '*.ts')",
   >     }),
   >   ),
   > });
   > ```
   >
   > Description 应该包含：支持正则还是纯文本、默认搜索范围、结果截断行为、大量匹配时的建议（比如"如果结果太多，用 include 缩小范围"）。参数要简单——`pattern` 必填，`path` 和 `include` 可选，给模型灵活性但不增加复杂度。

2. **追踪工具执行流程**：阅读 `packages/agent/src/agent-loop.ts` 中的 `prepareToolCall` 函数，画出从"收到工具调用"到"返回工具结果"的完整流程图，标注每个可能的分支（工具不存在、验证失败、被 beforeToolCall 阻止、执行成功、执行失败）。

   > **关键信息**：完整流程如下：
   >
   > ```
   > 收到 ToolCall
   > │
   > ├─ 查找工具 → 未找到 → 返回错误结果 "Tool xxx not found"
   > │
   > ├─ prepareArguments → 参数预处理（兼容性修正）
   > │
   > ├─ validateToolArguments → 验证失败 → 返回错误结果（含详细错误信息）
   > │
   > ├─ beforeToolCall → 返回 { block: true } → 返回错误结果（含 reason）
   > │
   > ├─ tool.execute()
   > │  ├─ 成功 → { result, isError: false }
   > │  └─ 抛出异常 → { result: 错误信息, isError: true }
   > │
   > ├─ afterToolCall → 可选地修改 content/details/isError
   > │
   > └─ 构造 ToolResultMessage，发出 tool_execution_end 事件
   > ```
   >
   > 关键观察：每个分支都不会导致 agent 崩溃。所有错误都被转换为 `ToolResultMessage` 返回给模型，让模型决定如何处理。这是 agent 系统的核心设计原则——**错误是正常的工作流程，不是异常**。

3. **对比 content 和 details**：阅读 `read` 工具的 `execute` 函数，找出哪些信息放在 `content` 中（返回给模型），哪些放在 `details` 中（用于 UI）。思考：为什么截断信息（`truncation`）放在 `details` 而不是 `content` 中？

   > **关键信息**：
   >
   > **content 中的信息**（模型会看到）：
   >
   > - 文件的文本内容（可能被截断）
   > - 截断提示文本，如 `"[Showing lines 1-2000 of 15000. Use offset=2001 to continue.]"`
   > - 图片的 base64 数据和 MIME 类型
   > - 图片的尺寸说明
   >
   > **details 中的信息**（仅 UI 使用）：
   >
   > - `truncation` 对象：包含 `truncated`（是否截断）、`outputLines`（输出行数）、`totalLines`（总行数）、`truncatedBy`（按行还是按字节截断）、`maxBytes`、`maxLines`、`firstLineExceedsLimit` 等结构化数据
   >
   > 截断的**结构化元数据**放在 `details` 中，因为 UI 需要这些数据来渲染不同样式的截断提示（比如用黄色警告文字显示 `"[Truncated: showing 2000 of 15000 lines]"`）。而模型只需要知道"文件没读完，用 offset=2001 继续"——这个信息已经以自然语言的形式包含在 `content` 的文本末尾了。把结构化的截断元数据也塞进 `content` 只会浪费 token，模型并不需要知道 `maxBytes` 是 262144 这样的细节。

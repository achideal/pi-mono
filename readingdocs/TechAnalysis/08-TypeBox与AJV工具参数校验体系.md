# 08 · TypeBox + AJV 工具参数校验体系

> 位置：`packages/ai/src/utils/validation.ts`、`packages/ai/src/utils/typebox-helpers.ts`、`packages/ai/src/types.ts`（`Tool<TParameters extends TSchema>`）
>
> 提炼点：**用一个既是"TypeScript 类型"又是"JSON Schema"的 schema 库（TypeBox），搭配运行时 JSON Schema 校验器（AJV），做到"工具参数 =类型定义 = 运行时校验 = 跨进程传输的 JSON"四位一体，且对 CSP 严格的 Chrome 扩展环境做了可运行的降级方案。**

---

## 1. 问题：LLM 吐的 tool_call 参数完全不可信

LLM 生成 `arguments` 的**字面形态**是 JSON 字符串，解析后是 `Record<string, any>`。它可能：

- 丢字段（required 字段没给）
- 多字段（给了 schema 不认识的键）
- 类型错（number 给成 string）
- 枚举错（"celcius" 代替 "celsius"）
- 格式错（`date-time` 格式不对）
- 长度/范围越界

如果不校验直接交给 tool.execute，轻则报错、重则注入危险。
但同时，pi-ai 必须把这个 schema：

1. **生成给 LLM**：每家 Provider 需要的 tool 定义都带 JSON Schema。
2. **传给 Agent**：Agent 层要根据 schema 验证 args。
3. **给 TypeScript**：tool.execute 的 params 参数要有精确静态类型，写工具不能靠 `any`。
4. **可以序列化**：跨 workers、跨 RPC、跨 Extension 传递时必须是 JSON。

一个写法满足所有这些要求，需要 schema 既是**值（JSON Schema）**又是**类型（TS type）**——而且是同一份定义。

---

## 2. TypeBox 为什么是这个场景的最佳选项

[`@sinclair/typebox`](https://github.com/sinclairzx81/typebox) 的设计哲学：**运行时对象本身就是 JSON Schema，同时有 TypeScript 类型由 `Static<T>` 推导出来**。

举例：

```ts
import { Type, type Static } from "@sinclair/typebox";

const WeatherSchema = Type.Object({
  location: Type.String({ description: "City name or coordinates" }),
  units: StringEnum(["celsius", "fahrenheit"], { default: "celsius" }),
});

// 运行时值：一个合法的 JSON Schema
// {
//   type: "object",
//   properties: {
//     location: { type: "string", description: "..." },
//     units: { type: "string", enum: ["celsius", "fahrenheit"], default: "celsius" }
//   },
//   required: ["location", "units"]
// }

// 静态类型：
type Weather = Static<typeof WeatherSchema>;
// { location: string; units: "celsius" | "fahrenheit" }
```

同一个 `WeatherSchema` 用作：

- **运行时**：直接喂给 AJV 编译。
- **类型**：Tool `execute` 的 params 就是 `Static<typeof WeatherSchema>`。
- **协议载荷**：`JSON.stringify(WeatherSchema)` 就是发给 OpenAI / Anthropic 的 `parameters` 字段。

pi-ai 的 `Tool` / `AgentTool` 接口：

```ts
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;   // 就是 TypeBox schema，泛型卡死
}

export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,
    params: Static<TParameters>,   // 静态类型由 schema 精确推导
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
```

`execute` 的 `params` 类型**完全由 schema 自动推导**，工具作者无需重复声明 TypeScript interface，也不存在类型和 schema 漂移的可能。

---

## 3. `StringEnum` 辅助：跨 Provider 兼容的小修补

```ts
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

为什么不直接用 TypeBox 的 `Type.Union(Type.Literal(...))`？

因为那会生成 `anyOf: [{ const: "a" }, { const: "b" }]` 结构。Google Generative AI 的 schema 解析**不支持 anyOf/const**，会直接 400。用 `{ type: "string", enum: [...] }` 这种最老派的 JSON Schema 写法**所有 Provider 都支持**。

`Type.Unsafe<T[number]>` 是 TypeBox 提供的"escape hatch"：允许你手写不完全合法的 schema 对象，但仍然得到正确的 TS 类型推导。这是**在无法修改上游类型库时让类型和 JSON 同时正确的常用手法**。

---

## 4. `validateToolArguments` 的实际校验流

看 `validation.ts` 核心：

```ts
const ajv = new Ajv({
  allErrors: true,          // 一次报所有错，不是遇到第一个就停
  strict: false,            // TypeBox 有一些非标关键字（比如 description），不要 strict 抛
  coerceTypes: true,        // "42" -> 42 允许
});
addFormats(ajv);            // 启用 date-time / email / uri 等 format 校验

export function validateToolArguments(tool, toolCall): any {
  if (!ajv || !canUseRuntimeCodegen()) return toolCall.arguments;

  const validate = ajv.compile(tool.parameters);
  const args = structuredClone(toolCall.arguments);
  if (validate(args)) return args;

  const errors = validate.errors?.map((err) => {
    const path = err.instancePath ? err.instancePath.substring(1) : err.params.missingProperty || "root";
    return `  - ${path}: ${err.message}`;
  }).join("\n") || "Unknown validation error";

  throw new Error(
    `Validation failed for tool "${toolCall.name}":\n${errors}\n\n` +
    `Received arguments:\n${JSON.stringify(toolCall.arguments, null, 2)}`
  );
}
```

四个细节尤其值得学：

### 4.1 `coerceTypes: true` 让 LLM 的小错不致命

LLM 经常吐 `{ "count": "5" }` 明明 schema 要 number。`coerceTypes` 会原地把 string 转 number，返回被 normalize 过的 args。这是"宽进严出"的典型，显著减少"fieldName is wrong type"的重试次数。

### 4.2 `structuredClone(toolCall.arguments)` 保证校验不污染上游

AJV 为了 coerce 会 mutate 输入。如果把 `toolCall.arguments` 原对象传进去，下次你再看这条 tool_call 时内容已经变了——
严重破坏"消息不可变"的直觉。先 clone 再让 AJV 改，校验成功返回改过的副本，失败抛错，原对象永远不变。

### 4.3 错误信息带**路径 + 原值**

```
Validation failed for tool "book_meeting":
  - startTime: must match format "date-time"
  - attendees/0: must match format "email"

Received arguments:
{ "startTime": "tomorrow 3pm", ... }
```

第 7 篇讲过：这些错误文本被上层 agent-loop 捕获后**作为 tool_result 返回给 LLM**，LLM 就能看到具体哪个字段错、想要什么格式，然后自己重试。没有比这更高效的"教会模型自愈"的方式。

### 4.4 `allErrors: true`

一次校验报**所有**错误，不是第一次就停。LLM 一次看到所有问题一次改完，省去多轮往返。

---

## 5. CSP 严格环境下的优雅降级

这部分是这套工程里特别体贴的设计：

```ts
const isBrowserExtension = typeof globalThis !== "undefined" && (globalThis as any).chrome?.runtime?.id !== undefined;

function canUseRuntimeCodegen(): boolean {
  if (isBrowserExtension) return false;
  try { new Function("return true;"); return true; } catch { return false; }
}

let ajv: any = null;
if (canUseRuntimeCodegen()) {
  try { ajv = new Ajv({ ... }); addFormats(ajv); }
  catch (_e) { console.warn("AJV validation disabled due to CSP restrictions"); }
}
```

背景：Manifest V3 的 Chrome Extension 默认禁用 `eval` / `new Function`。AJV 编译 schema 是靠 **动态生成 JS 字符串然后 `new Function`** 的，在 Manifest V3 里会抛异常。

如果不特判，**这个 SDK 在 Chrome 扩展里直接加载就炸**。

这里做了两层防御：

1. **显式检测扩展环境**：`chrome.runtime.id` 只有扩展内部能访问。
2. **探测 `new Function`**：能执行就启用，不能就放弃。

降级策略是"跳过校验直接返回 `toolCall.arguments`"，工具作者拿到的是未校验的原始参数。选择 degrade 而不是 throw 是对 SDK 体验负责的决策——浏览器扩展里的 tool 通常足够可控，让 SDK 可用比严格校验重要。

### 5.1 对比：ajv-standalone 其实能绕过 CSP

有更复杂的选项：用 `ajv/dist/2020.js` 的 standalone 编译模式，提前把 schema 编译成 JS 源码在构建期打包。但这需要工具作者配合改 build。对于一个"多环境都能跑"的 SDK 来说，**运行时探测 + 优雅降级**是成本更低的选择。

---

## 6. validateToolCall / validateToolArguments 两个导出

```ts
export function validateToolCall(tools: Tool[], toolCall: ToolCall): any {
  const tool = tools.find((t) => t.name === toolCall.name);
  if (!tool) throw new Error(`Tool "${toolCall.name}" not found`);
  return validateToolArguments(tool, toolCall);
}

export function validateToolArguments(tool: Tool, toolCall: ToolCall): any { ... }
```

- `validateToolCall`：高层接口，按名字找 tool。调用者手里只有一个 tools 数组时用它。
- `validateToolArguments`：低层接口，tool 已经找到时用。

agent-loop 里用的是 `validateToolArguments`（tool 已经从 context 取出来了，避免再找一次）。用户代码里写自己的循环则用 `validateToolCall` 更直接。一个库把同一个能力按"已知 vs 未知前置条件"拆两层导出，上手体验好很多。

---

## 7. 可以直接带走的套路

1. **用"既是 TS 类型又是 JSON Schema"的 schema 库**，避免类型/运行时/协议三份定义。
2. **StringEnum 之类的跨 Provider 兼容层做成独立 helper**，不污染主类型。
3. **`coerceTypes: true` + `structuredClone`**：宽容 LLM 的小错 + 不污染原对象。
4. **错误信息人类可读 + 送回 LLM**：模型会自我修正。
5. **Chrome MV3 环境显式 detect + 优雅降级**：库要在最严格的目标环境里至少能工作。
6. **把"校验"和"按名字找 tool"做成两层导出**：上下游都顺手。

无论你做的是 HTTP RPC、CLI subcommand 参数解析、Webhook payload 校验，这个 "TypeBox + AJV + coerce + 多环境兼容" 的模式都是即插即用的。记住最重要的一条：**把 schema 当作唯一真相源**，不要再维护一套 TS 接口定义。


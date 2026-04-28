# ai/ — LLM 调用的归一化层（L1）

> **一句话**：把 "调 LLM" 这件事抽象成一个函数类型 `StreamFn`，并提供 OpenAI 两种协议（Chat Completions / Responses）的实现。

## 这一层负责什么

1. **定义归一化的消息/工具/事件类型**（`types.ts`）
   - `Message` / `ToolCall` / `ToolSchema` / `StreamEvent` —— 完全 provider-agnostic
2. **把 provider 抽象成函数类型** `StreamFn`（`types.ts`）
3. **提供两个 provider 实现**：
   - `streamChatCompletions`（`chat-completions.ts`）
   - `streamResponses`（`responses.ts`）
4. **共享 SSE 解析**（`sse.ts`）—— 两个 provider 都用这个底层工具

## 暴露的公共接口

```ts
// 类型
export type { Message, ToolCall, ToolSchema, StreamEvent, StopReason, StreamFn, StreamOptions, ... }

// 两个 provider
export const streamChatCompletions: StreamFn;
export const streamResponses: StreamFn;

// 简单工厂
export type ProviderKind = "chat-completions" | "responses";
export function pickProvider(kind: ProviderKind): StreamFn;
```

## 依赖什么能力

- **仅依赖运行时 `fetch`**（Node 18+ / 浏览器原生）
- **不依赖任何 mini-pi 其他模块** —— 本层是叶子能力
- 不依赖任何第三方 SDK（不用 `openai` 包），刻意展示"调 LLM 就是调一个 HTTP SSE 接口"

## 设计理念

### 1. Provider 是"函数类型"，不是"接口对象"

```ts
export type StreamFn = (messages, tools, options) => AsyncIterable<StreamEvent>;
```

对比常见的"策略接口"写法：

```ts
// ❌ 不必要的复杂度
interface Provider {
   stream(messages, tools, options): AsyncIterable<StreamEvent>;
}
```

**为什么选函数类型？**

- 函数类型的 DI 更轻量：传一个函数就是注入；不需要 `new ProviderImpl()`
- 函数类型对**闭包/mock/适配**更友好：测试里一个 async generator 就能当 provider
- 只有一个方法的接口用"对象"包一层，是**过度设计**

这在 pi-mono 里也是同样思路（`packages/ai/src/stream.ts` 的 `streamSimple` 也是顶层函数）。

### 2. 归一化类型在这一层定义，不是在 agent 层

为什么 `Message` / `ToolCall` / `StreamEvent` 声明在 `ai/`？

- 这些类型是 **LLM 调用的契约**，不是 agent 的契约
- agent 层直接 `import { Message } from "../ai"` 来消费
- 如果声明在 agent 层，会形成"上层定义契约、下层实现契约"的倒置依赖

这符合**依赖倒置原则（DIP）**：**抽象由下层提供，上层消费抽象**。

### 3. 流式事件 = 协议差异的抹平点

两种协议的差异：

| | Chat Completions | Responses |
|---|---|---|
| 文本增量 | `choice.delta.content` | `response.output_text.delta.delta` |
| 工具参数 | `tool_calls[i].function.arguments`（字符串增量） | `response.function_call_arguments.delta.delta` |
| 结束标志 | `finish_reason` | `response.completed` / `response.failed` |
| 请求字段 | `messages` | `input`（结构更扁平） |

**协议细节全被封装在两个文件里**，对外都只暴露同一种 `StreamEvent` 流。上层（agent-loop）完全感知不到用的是哪种协议。

### 4. 错误处理走"事件"而非"throw"

```ts
// 所有失败路径都用 done 事件表达
yield { type: "done", stopReason: "error", error: "..." };
yield { type: "done", stopReason: "aborted" };
```

为什么不 throw？

- 异步迭代器的异常传播语义复杂，`try/catch` + `for-await-of` 容易出微妙 bug
- 把失败表达成"流的一个终态事件"，让上层统一用一套 reducer 处理
- 这和 pi-mono 的 `AssistantMessage.stopReason` 字段是同一思路

### 5. 不做"不必要的抽象"

- **没有注册表**（Map<name, StreamFn>），因为只有 2 个 provider
- **没有中间件 / 拦截器**，因为 agent-loop 的 `beforeToolCall` / `transformContext` 已经是拦截点
- **没有 retry / backoff**，因为 retry 是"可靠性"关注点，应该在**更上层**统一做（参考 pi-mono 的 transport）

## 文件地图

| 文件 | 作用 |
|---|---|
| `types.ts` | 归一化类型契约（`Message` / `ToolCall` / `StreamFn` 等） |
| `sse.ts` | SSE 行级解析（共享工具） |
| `chat-completions.ts` | OpenAI Chat Completions 适配器 |
| `responses.ts` | OpenAI Responses 适配器 |
| `provider-factory.ts` | 简单工厂 `pickProvider(kind)` |
| `index.ts` | 公共导出面 |

## 与 pi-mono 的对照

| mini-pi | pi-mono | 差异 |
|---|---|---|
| `types.ts` | `packages/ai/src/types.ts` | pi-mono 支持 thinking / image / audio，mini-pi 只做 text + tool_call |
| `chat-completions.ts` | `packages/ai/src/providers/openai-completions.ts` | 本质一致，pi-mono 多了 retry / token 统计 / 多 provider 兼容 |
| `responses.ts` | `packages/ai/src/providers/openai-responses.ts` | 同上 |
| `provider-factory.ts` | `packages/ai/src/api-registry.ts` | pi-mono 用 registry + lazy load（真正需要插件化）；mini-pi 用 switch |

## 下一层

→ [../agent/README.md](../agent/README.md) 看如何用这里定义的 `StreamFn` 驱动 agent-loop。

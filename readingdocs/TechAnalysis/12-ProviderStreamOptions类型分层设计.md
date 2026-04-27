# 12 · ProviderStreamOptions 类型分层：既要全局一致又要厂商特化

> 位置：`packages/ai/src/types.ts` 的 `StreamOptions` / `SimpleStreamOptions` / `ProviderStreamOptions` / `StreamFunction`、`providers/simple-options.ts` 的 `buildBaseOptions`、每家 provider 的 `XxxOptions` 接口
>
> 提炼点：**把"所有 Provider 都懂的参数"和"只有某一家懂的参数"**用三层类型**层层分离**——全局统一 + 提供者自然扩展 + 不放弃类型安全。**

---

## 1. 困境：每家 LLM 都有自己的怪字段

想象你需要让同一个 `stream(model, ctx, options)` 接口同时兼容：

- OpenAI Responses 的 `reasoningEffort` / `reasoningSummary` / `store` / `previous_response_id`
- Anthropic 的 `thinkingEnabled` / `thinkingBudgetTokens`
- Google 的 `thinking: { enabled, budgetTokens }` 对象
- Bedrock 的 `awsCredentials`、`region`
- OpenAI Codex 的 `transport: "sse" | "websocket"`、`websocketSessionId`

如果把所有这些字段**一股脑塞在一个 `StreamOptions` 里**，一是类型膨胀到无法维护，二是用户会在 OpenAI 上误填 `thinkingEnabled` 然后一脸困惑。

但反过来，某些字段是**所有 Provider 都应该支持**的：`temperature` / `maxTokens` / `signal` / `apiKey` / `headers`…… 这些要统一。

pi-ai 用三层类型解决这个矛盾。

---

## 2. 三层结构

```ts
// 第 1 层：所有 Provider 都懂的"共同底座"
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  transport?: Transport;
  cacheRetention?: CacheRetention;
  sessionId?: string;
  onPayload?: (payload, model) => unknown | undefined | Promise<unknown | undefined>;
  headers?: Record<string, string>;
  maxRetryDelayMs?: number;
  metadata?: Record<string, unknown>;
}

// 第 2 层：统一用户接口——StreamOptions + 简化的 reasoning
export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: ThinkingLevel;           // "minimal" | "low" | "medium" | "high" | "xhigh"
  thinkingBudgets?: ThinkingBudgets;
}

// 第 3 层：提供给通用门面 stream()/complete() 的"逃生舱"
export type ProviderStreamOptions = StreamOptions & Record<string, unknown>;
```

对应三种使用场景：

| 层 | 面向谁 | 语义 |
| --- | --- | --- |
| `StreamOptions` | Provider 实现者 | 必须支持这些字段的所有字段 |
| `SimpleStreamOptions` | 大部分 SDK 用户 | 推理只用 level 字符串，库自己换算成厂商字段 |
| `ProviderStreamOptions` | 直接用 `stream()` 且想传厂商独有字段的用户 | 允许任何键，交给 Provider 自己挑 |

另外每家 Provider 在自己的文件里导出特化选项：

```ts
// providers/anthropic.ts
export interface AnthropicOptions extends StreamOptions {
  thinkingEnabled?: boolean;
  thinkingBudgetTokens?: number;
  // ...
}

// providers/openai-responses.ts
export interface OpenAIResponsesOptions extends StreamOptions {
  reasoningEffort?: "minimal" | "low" | "medium" | "high";
  reasoningSummary?: "auto" | "concise" | "detailed";
  // ...
}
```

用户如果**明确知道自己用哪家**，调用 `streamAnthropic(model, ctx, { thinkingEnabled: true })`——得到强类型。
用户如果只是想切换 Provider 灵活试，调用 `stream(model, ctx, { ... })`——得到宽松的 `ProviderStreamOptions`。

---

## 3. `stream()` 门面：强类型 + 逃生舱

看 `stream.ts` 的签名：

```ts
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  return resolveApiProvider(model.api).stream(model, context, options as StreamOptions);
}
```

**参数是 `ProviderStreamOptions`（宽），内部转成 `StreamOptions` 喂给 Provider**。每家 Provider 自己挑自己认识的字段。多余字段被它们静默忽略。

这是一种经典的"开放写入 + 严格读取"的类型策略。类似：

- HTTP 里服务端接任何 header，自己只解它懂的。
- 通用数据管道（Kafka / MQ / JSON blob）容忍未知字段而不 break。

它最大的好处：**新 Provider 引入新字段不会破坏旧用户代码**。

而想要强类型的用户，直接导出厂商专用函数：

```ts
import { streamAnthropic, type AnthropicOptions } from "@mariozechner/pi-ai";
const options: AnthropicOptions = { thinkingEnabled: true, thinkingBudgetTokens: 2048 };
await streamAnthropic(claude, ctx, options);
```

同一个代码库给**同一件事提供两种严格度**。用户根据需要选择。

---

## 4. `Model<TApi>` 的泛型 compat 字段：类型依赖注入

`Model` 接口里有一段非常精巧的类型：

```ts
export interface Model<TApi extends Api> {
  ...
  compat?: TApi extends "openai-completions"
    ? OpenAICompletionsCompat
    : TApi extends "openai-responses"
      ? OpenAIResponsesCompat
      : never;
}
```

这是一个 **基于泛型参数的条件类型**，意思是：

- `Model<"openai-completions">` 的 `compat` 字段类型是 `OpenAICompletionsCompat`。
- `Model<"openai-responses">` 的是 `OpenAIResponsesCompat`。
- 其他 API 的 `compat` 类型是 `never`——**你根本不能设置它**。

这种做法比"`compat?: any`"高级得多：

- 用户在 `Model<"anthropic-messages">` 上写 `compat: {...}` 直接 TS 报错。
- 只有在可以有 compat 的 API 上才允许，字段类型各自精确。

本质是把"是否允许某字段"这条业务规则编码到类型层。用户错写 → 编译器拦截。

---

## 5. `SimpleStreamOptions` 的存在意义

对比两种写法：

```ts
// 低层：要知道每家具体字段
await streamAnthropic(sonnet, ctx, { thinkingEnabled: true, thinkingBudgetTokens: 8192 });
await streamOpenAIResponses(gpt5, ctx, { reasoningEffort: "medium" });
await streamGoogle(gemini, ctx, { thinking: { enabled: true, budgetTokens: 8192 } });

// 高层：统一只给"reasoning 档位"
await streamSimple(anyModel, ctx, { reasoning: "medium" });
```

`streamSimple` 的每个 Provider 实现里都有对应的 `streamSimpleXxx`，其中用 `buildBaseOptions` + `adjustMaxTokensForThinking` 把 `reasoning: "medium"` 翻译成具体字段：

```ts
// providers/simple-options.ts
export function adjustMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: ThinkingBudgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
  const budgets = { ...defaultBudgets, ...customBudgets };

  const minOutputTokens = 1024;
  const level = clampReasoning(reasoningLevel)!;
  let thinkingBudget = budgets[level]!;
  const maxTokens = Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);
  if (maxTokens <= thinkingBudget) thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  return { maxTokens, thinkingBudget };
}
```

几条设计值得学：

### 5.1 `clampReasoning("xhigh")` 在非 OpenAI 上降级为 "high"

```ts
export function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, "xhigh"> | undefined {
  return effort === "xhigh" ? "high" : effort;
}
```

OpenAI 某些 gpt-5.x 支持"xhigh"档位，别家没有。SimpleStreamOptions 的统一接口必须让用户即便填"xhigh"也能在 Claude 上工作，于是这里做了静默降级。返回类型 `Exclude<ThinkingLevel, "xhigh">` 把"降级后不可能再是 xhigh"直接写进类型。

### 5.2 ThinkingBudgets 可自定义

```ts
const budgets = { ...defaultBudgets, ...customBudgets };
```

用户如果在 Agent 上设了 `thinkingBudgets = { medium: 4096 }`，就会覆盖默认的 8192。这让你能为某个模型精调 reasoning token 预算。

### 5.3 `buildBaseOptions` 只复制白名单里的字段

```ts
return {
  temperature: options?.temperature,
  maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
  signal: options?.signal,
  apiKey: apiKey || options?.apiKey,
  cacheRetention: options?.cacheRetention,
  sessionId: options?.sessionId,
  headers: options?.headers,
  onPayload: options?.onPayload,
  maxRetryDelayMs: options?.maxRetryDelayMs,
  metadata: options?.metadata,
};
```

不是 `{ ...options }`，而是**显式列出**。好处：

- 用户不会意外地把 `reasoning: "high"` 漏到 Provider 的底层 StreamOptions 里（会导致某些 Provider 的 onPayload 校验出 unknown field 被报错）。
- 读代码的人一眼就知道"共同底座"到底有哪些字段，对 readability 是直接的增益。
- 添加新字段是白名单刻意维护，不会因为"写了一个 options.foo 就突然多了一条协议"。

---

## 6. `StreamFunction<TApi, TOptions>` 的双泛型

```ts
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;
```

这让：

- `streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions>` 严格强类型。
- `streamAnthropic: StreamFunction<Api, StreamOptions>`（擦除后）能被 registry 存储。

两个泛型各司其职：

- `TApi` 约束 `model` 参数，防止模型 / 协议错配。
- `TOptions` 约束 `options` 参数，防止字段错配。

写 Provider 的时候可以一眼看出："我只接受这类 model，这类 options"。

---

## 7. 可以带走的设计原则

1. **共同字段 vs. 特化字段分 interface**，不要让大接口膨胀成 "any soup"。
2. **顶层 API 接收宽（`ProviderStreamOptions`），Provider 消费窄（`StreamOptions` 子类）**：开放写入 + 严格读取。
3. **同一能力提供强类型 + 宽类型两种入口**：让用户自选严格度。
4. **基于泛型参数的条件类型（`Model<TApi extends ...> { compat: ... }`）** 把"字段仅对部分子类型有效"的业务规则编码到编译器。
5. **高层抽象（`reasoning: ThinkingLevel`）在库内翻译成底层字段**，应用不用懂每家细节。
6. **`buildBaseOptions` 用显式复制白名单，不用 spread**：防字段逃逸、读代码更清晰。
7. **`Exclude<T, "x">` 在类型层表达降级后不可能的值**：编译期捕获逻辑错误。

这是"多租户/多厂商接入"场景里最通用的一组类型技巧。你在做支付网关聚合、云服务抽象、传感器统一接口时，完全可以照着这四层（底座 / 简化接口 / 逃生舱 / 厂商特化）套用。


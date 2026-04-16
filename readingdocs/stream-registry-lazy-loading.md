# stream.ts / api-registry.ts / register-builtins.ts 三文件串讲

本文面向正在学习 `packages/ai` 源码的读者，目标是把以下三个文件从外到内完整讲透：

- `packages/ai/src/stream.ts` — 对外门面
- `packages/ai/src/api-registry.ts` — Provider 注册表
- `packages/ai/src/providers/register-builtins.ts` — 内置 Provider 注册 + 懒加载

配套阅读：

- [ApiProvider / ApiProviderInternal 类型分层讲解](./api-provider-vs-api-provider-internal.md) — 如果你已经理解调用链，但还不明白为什么要有两层 provider 类型、为什么 `Map` 里要做泛型擦除、以及 `wrapStream` 到底在补什么安全边界，请继续读这篇。

---

## 目录

1. [全景：三个文件的角色与关系](#1-全景三个文件的角色与关系)
2. [api-registry.ts — 注册表（数据层）](#2-api-registryts--注册表数据层)
3. [register-builtins.ts — 填充注册表 + 懒加载（策略层）](#3-register-builtinsts--填充注册表--懒加载策略层)
4. [stream.ts — 对外门面（接口层）](#4-streamts--对外门面接口层)
5. [完整调用链：从 stream() 到 HTTP 请求](#5-完整调用链从-stream-到-http-请求)
6. [副作用导入详解：import "./providers/register-builtins.js"](#6-副作用导入详解import-providersregister-builtinsjs)
7. [设计模式总结](#7-设计模式总结)

---

## 1. 全景：三个文件的角色与关系

```
┌─────────────────────────────────────────────────────────────────────┐
│                          外部调用者                                  │
│              import { stream } from "packages/ai"                   │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
               ┌───────────────────────────────┐
               │      stream.ts  (门面层)       │  对外暴露 4 个函数
               │  stream / complete             │  唯一入口，不知道任何
               │  streamSimple / completeSimple │  具体 provider 的存在
               └──────────────┬────────────────┘
                              │ getApiProvider(model.api)
                              ▼
               ┌───────────────────────────────┐
               │   api-registry.ts (注册表层)   │  一个 Map<string, provider>
               │   registerApiProvider()        │  纯数据结构，不含业务逻辑
               │   getApiProvider()             │
               └──────────────┬────────────────┘
                              │ 被谁填充？
                              ▼
               ┌───────────────────────────────┐
               │  register-builtins.ts (注册层) │  填充注册表 + 懒加载壳
               │  registerBuiltInApiProviders() │  10 个内置 provider
               │  createLazyStream()            │  动态 import 真正实现
               └───────────────────────────────┘
                              │ 真正调用时才触发
                              ▼
               ┌───────────────────────────────┐
               │  anthropic.ts / google.ts ...  │  真正的 HTTP 调用
               │  各 provider 实现文件           │
               └───────────────────────────────┘
```

一句话总结：`stream.ts` 是门面，`api-registry.ts` 是路由表，`register-builtins.ts` 往路由表里填内容并负责延迟加载。

---

## 2. api-registry.ts — 注册表（数据层）

### 2.1 核心数据结构

整个系统的核心就是一个 Map：

```typescript
// api-registry.ts 第 40 行
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();
```

key 是 API 协议字符串（如 `"anthropic-messages"`），value 是一个包装过的 provider 对象。

### 2.2 两层类型设计

文件定义了两套接口，外部用一套，内部用一套。

**外部接口**（给注册者用的，带泛型，类型安全）：

```typescript
// api-registry.ts 第 23-27 行
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
    api: TApi;
    stream: StreamFunction<TApi, TOptions>;          // 带泛型：知道具体是哪个 API
    streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
```

**内部接口**（Map 里实际存的，泛型被擦除）：

```typescript
// api-registry.ts 第 29-33 行
interface ApiProviderInternal {
    api: Api;
    stream: ApiStreamFunction;       // 泛型擦除为 Api + StreamOptions
    streamSimple: ApiStreamSimpleFunction;
}
```

为什么需要两套？因为 Map 只能存一种类型。你不能把 `StreamFunction<"anthropic-messages", AnthropicOptions>` 和 `StreamFunction<"openai-responses", OpenAIResponsesOptions>` 放进同一个 Map 的 value 类型里。所以内部统一擦除为 `ApiStreamFunction`。

如果你对这里还有两个疑问：

1. 为什么同样都写 `Api`，却不代表"必须是同一个具体 api"？
2. 为什么 `ApiProvider<"openai-completions">` 不能直接当成 `ApiProvider<Api>` 放进 registry？

那么建议继续看配套文档：[ApiProvider / ApiProviderInternal 类型分层讲解](./api-provider-vs-api-provider-internal.md)。那篇会单独把 `Api` vs `TApi`、`Map<string, V>` 的限制、函数参数放宽为什么会变得不安全、以及 `wrapStream` 的运行时校验怎么补上这条安全边界，完整拆开讲。

### 2.3 wrapStream — 泛型擦除时的安全防线

```typescript
// api-registry.ts 第 42-52 行
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
    api: TApi,
    stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
    return (model, context, options) => {
        if (model.api !== api) {
            throw new Error(`Mismatched api: ${model.api} expected ${api}`);
        }
        return stream(model as Model<TApi>, context, options as TOptions);
    };
}
```

泛型擦除后，TypeScript 编译器不再帮你检查"Anthropic 的 stream 收到了 OpenAI 的 model"这种错误。`wrapStream` 用一个**运行时检查** `model.api !== api` 来补偿这个类型安全的缺失。这是一道防线：如果路由逻辑出了 bug，错误会在这里被捕获，而不是悄悄传到 Anthropic SDK 里产生一个莫名其妙的 HTTP 错误。

`wrapStreamSimple` 同理。

### 2.4 registerApiProvider — 写入

```typescript
// api-registry.ts 第 66-78 行
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
    provider: ApiProvider<TApi, TOptions>,
    sourceId?: string,
): void {
    apiProviderRegistry.set(provider.api, {
        provider: {
            api: provider.api,
            stream: wrapStream(provider.api, provider.stream),
            streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
        },
        sourceId,
    });
}
```

做了三件事：

1. 把带泛型的 `stream` 通过 `wrapStream` 转为内部的 `ApiStreamFunction`（泛型擦除 + 加运行时校验）
2. 附带一个可选的 `sourceId`（用于批量反注册，比如插件卸载时）
3. 写入 Map，key 是 `provider.api` 字符串

注意 `set` 的语义：**同一个 api 字符串，后注册的会覆盖前面的**。这使得第三方可以替换内置 provider。

### 2.5 getApiProvider — 读取

```typescript
// api-registry.ts 第 80-82 行
export function getApiProvider(api: Api): ApiProviderInternal | undefined {
    return apiProviderRegistry.get(api)?.provider;
}
```

纯查表，O(1)。

### 2.6 其他管理函数

```typescript
export function getApiProviders(): ApiProviderInternal[]     // 列出所有已注册 provider
export function unregisterApiProviders(sourceId: string)     // 按 sourceId 批量删除
export function clearApiProviders(): void                    // 清空全部
```

- `unregisterApiProviders` 是为**插件系统**设计的：一个插件注册了多个 provider，卸载时传入 sourceId 就能精确清理，不影响其他插件。
- `clearApiProviders` 用于 `resetApiProviders()`（register-builtins.ts 第 428 行），可以在测试中重置到干净状态。

---

## 3. register-builtins.ts — 填充注册表 + 懒加载（策略层）

这个文件是三个文件中最长最复杂的（433 行），但逻辑结构非常规整。它做**两件大事**：为每个 provider 构造懒加载壳，然后批量注册。

### 3.1 Part A：类型声明（第 1-93 行）

**静态 import 的只有类型**：

```typescript
import { clearApiProviders, registerApiProvider } from "../api-registry.js";
import type { ... } from "../types.js";
import type { BedrockOptions } from "./amazon-bedrock.js";
import type { AnthropicOptions } from "./anthropic.js";
// ... 更多 import type ...
```

`import type` 在运行时完全不存在，不会触发任何模块加载。这是整个懒加载策略的基石——**编译时知道类型，运行时什么都不加载**。

然后定义了一个统一的懒加载模块接口：

```typescript
// register-builtins.ts 第 24-35 行
interface LazyProviderModule<TApi, TOptions, TSimpleOptions> {
    stream: (model, context, options?) => AsyncIterable<AssistantMessageEvent>;
    streamSimple: (model, context, options?) => AsyncIterable<AssistantMessageEvent>;
}
```

以及每个 provider 自己的模块接口（如 `AnthropicProviderModule`），描述了动态 import 后模块上的具体导出函数名。

### 3.2 Part B：Promise 缓存变量（第 95-129 行）

```typescript
const importNodeOnlyProvider = (specifier: string): Promise<unknown> => import(specifier);

let anthropicProviderModulePromise: Promise<...> | undefined;
let azureOpenAIResponsesProviderModulePromise: Promise<...> | undefined;
// ... 每个 provider 一个
```

每个变量初始值为 `undefined`。第一次加载时变成一个 `Promise`，之后复用。这就是**单例缓存**。

`importNodeOnlyProvider` 单独抽出来是为了 Bedrock——它依赖 Node.js 原生模块（AWS SDK），在浏览器环境中不可用。把 `import()` 包装一下可以在 bundler 中被特殊处理。

### 3.3 Part C：懒加载核心机制（第 138-210 行）

#### forwardStream — 管道

```typescript
// register-builtins.ts 第 138-145 行
function forwardStream(
    target: AssistantMessageEventStream,
    source: AsyncIterable<AssistantMessageEvent>,
): void {
    (async () => {
        for await (const event of source) {
            target.push(event);
        }
        target.end();
    })();
}
```

从 source（真正 provider 产生的 `AsyncIterable`）逐事件推给 target（外部壳 stream）。启动一个"后台" async IIFE，不 await，让它自己跑。

#### createLazyStream — 核心工厂

```typescript
// register-builtins.ts 第 168-187 行
function createLazyStream<TApi, TOptions, TSimpleOptions>(
    loadModule: () => Promise<LazyProviderModule<TApi, TOptions, TSimpleOptions>>,
): StreamFunction<TApi, TOptions> {
    return (model, context, options) => {
        const outer = new AssistantMessageEventStream();  // ① 立刻创建空壳

        loadModule()                                       // ② 异步加载 provider
            .then((module) => {
                const inner = module.stream(model, context, options);  // ③ 真正调用
                forwardStream(outer, inner);                           // ④ 管道转发
            })
            .catch((error) => {                                       // ⑤ 加载失败
                const message = createLazyLoadErrorMessage(model, error);
                outer.push({ type: "error", reason: "error", error: message });
                outer.end(message);
            });

        return outer;  // ⑥ 立刻返回空壳给调用者
    };
}
```

时序上发生了什么：

```
调用时刻 T0:
  ├─ 同步：new AssistantMessageEventStream()  →  return outer
  │         调用者拿到 outer，开始 for-await 监听（此时还没有事件）
  │
  └─ 微任务队列：loadModule() 的 Promise 开始执行

时刻 T1（毫秒级～秒级）:
  ├─ import("./anthropic.js") resolve
  │   → module.stream(model, context, options) 开始 HTTP 调用
  │   → forwardStream 开始逐事件 push 到 outer
  │
  └─ 调用者的 for-await 循环开始收到事件

时刻 T2:
  └─ source 迭代完毕 → target.end() → 调用者的循环结束
```

关键洞察：**调用者感知不到这个"壳"的存在**。对它来说，返回的就是一个普通的 `AssistantMessageEventStream`，它不关心事件是立刻来的还是等模块加载完才来的。

`createLazySimpleStream`（第 189-210 行）和 `createLazyStream` 几乎一样，只是调用 `module.streamSimple` 而不是 `module.stream`。

#### createLazyLoadErrorMessage — 加载失败时的统一错误消息

```typescript
// register-builtins.ts 第 147-166 行
function createLazyLoadErrorMessage<TApi extends Api>(model: Model<TApi>, error: unknown): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
                 cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
    };
}
```

如果动态 import 失败（比如文件不存在），不会 throw，而是构造一个 `stopReason: "error"` 的 `AssistantMessage`，通过 stream 的 error 事件传递给调用者。这遵循了 `StreamFunction` 的合约：一旦返回了 stream，所有错误都必须通过 stream 事件传递，不能 throw。

### 3.4 Part D：每个 provider 的加载函数（第 212-343 行）

以 Anthropic 为例：

```typescript
// register-builtins.ts 第 212-223 行
function loadAnthropicProviderModule(): Promise<
    LazyProviderModule<"anthropic-messages", AnthropicOptions, SimpleStreamOptions>
> {
    anthropicProviderModulePromise ||= import("./anthropic.js").then((module) => {
        const provider = module as AnthropicProviderModule;
        return {
            stream: provider.streamAnthropic,
            streamSimple: provider.streamSimpleAnthropic,
        };
    });
    return anthropicProviderModulePromise;
}
```

逐行：

1. `||=` — 如果 `anthropicProviderModulePromise` 已经是一个 Promise，直接复用，不再 import。**第二次调用不会重新加载模块**
2. `import("./anthropic.js")` — 动态 import，返回 Promise
3. `.then(module => ...)` — 从模块的导出中提取 `streamAnthropic` 和 `streamSimpleAnthropic`，包装成统一的 `{ stream, streamSimple }` 结构
4. 返回缓存的 Promise

#### Bedrock 的特殊分支

```typescript
// register-builtins.ts 第 329-343 行
function loadBedrockProviderModule(): Promise<...> {
    if (bedrockProviderModuleOverride) {
        return Promise.resolve(bedrockProviderModuleOverride);  // 被手动替换过
    }
    bedrockProviderModulePromise ||= importNodeOnlyProvider("./amazon-bedrock.js").then(...);
    return bedrockProviderModulePromise;
}
```

`bedrockProviderModuleOverride` 允许调用者通过 `setBedrockProviderModule()` 注入一个替代实现（比如在浏览器环境里用 polyfill），绕过 Node.js 的 `import()`。

### 3.5 Part E：创建懒加载壳并注册（第 345-433 行）

**先创建壳函数**：

```typescript
// register-builtins.ts 第 345-364 行
export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
export const streamSimpleAnthropic = createLazySimpleStream(loadAnthropicProviderModule);
// ... 每个 provider 两个
const streamBedrockLazy = createLazyStream(loadBedrockProviderModule);
const streamSimpleBedrockLazy = createLazySimpleStream(loadBedrockProviderModule);
```

这些 `export const` 是给**直接使用者**的——如果有人不想走注册表路由，可以直接 `import { streamAnthropic } from "register-builtins"` 来用。

**再批量注册到 registry**：

```typescript
// register-builtins.ts 第 366-426 行
export function registerBuiltInApiProviders(): void {
    registerApiProvider({
        api: "anthropic-messages",
        stream: streamAnthropic,
        streamSimple: streamSimpleAnthropic,
    });
    registerApiProvider({
        api: "openai-completions",
        stream: streamOpenAICompletions,
        streamSimple: streamSimpleOpenAICompletions,
    });
    // ... 共 10 个 provider
}
```

**模块顶层立刻执行**：

```typescript
// register-builtins.ts 第 433 行
registerBuiltInApiProviders();
```

这一行是整个系统的启动触发器。当 `stream.ts` 第 1 行 `import "./providers/register-builtins.js"` 执行时，这行代码就会跑，10 个 provider 就被注入到 `api-registry.ts` 的 Map 里了。

#### resetApiProviders — 测试用重置

```typescript
// register-builtins.ts 第 428-431 行
export function resetApiProviders(): void {
    clearApiProviders();            // 清空 Map
    registerBuiltInApiProviders();  // 重新注册所有内置 provider
}
```

---

## 4. stream.ts — 对外门面（接口层）

整个文件只有 59 行，是三个文件中最薄的一层。

### 4.1 副作用导入

```typescript
// stream.ts 第 1 行
import "./providers/register-builtins.js";
```

确保 `register-builtins.ts` 的模块顶层代码执行，即 `registerBuiltInApiProviders()` 被调用。必须是文件的第一行——如果有人先调用了 `stream()`，而注册表还是空的，就会报错。

（详细分析见[第 6 节](#6-副作用导入详解import-providersregister-builtinsjs)）

### 4.2 路由函数

```typescript
// stream.ts 第 17-23 行
function resolveApiProvider(api: Api) {
    const provider = getApiProvider(api);   // 查 Map
    if (!provider) {
        throw new Error(`No API provider registered for api: ${api}`);
    }
    return provider;
}
```

### 4.3 四个对外入口

| 函数 | 用途 | 返回值 |
|---|---|---|
| `stream(model, ctx, opts?)` | 流式调用，provider 特有 options | `AssistantMessageEventStream` |
| `complete(model, ctx, opts?)` | 等待流完成，返回完整消息 | `Promise<AssistantMessage>` |
| `streamSimple(model, ctx, opts?)` | 流式调用，统一简化 options | `AssistantMessageEventStream` |
| `completeSimple(model, ctx, opts?)` | 等待完成，简化 options | `Promise<AssistantMessage>` |

#### stream vs streamSimple

- `stream` 接受 `ProviderStreamOptions`（= `StreamOptions & Record<string, unknown>`），允许传 Anthropic 特有的参数、Google 特有的参数等等，provider 自己解析
- `streamSimple` 接受 `SimpleStreamOptions`（= `StreamOptions` + `reasoning` + `thinkingBudgets`），只暴露统一抽象。每个 provider 的 `streamSimple` 实现负责把 `reasoning: "high"` 翻译成自家 API 的参数

#### complete / completeSimple

就是 `stream` / `streamSimple` 的封装：

```typescript
// stream.ts 第 34-41 行
export async function complete(...) {
    const s = stream(model, context, options);
    return s.result();   // 消费整个 stream，返回最终的 AssistantMessage
}
```

---

## 5. 完整调用链：从 stream() 到 HTTP 请求

以 `stream(claudeModel, context, { cacheRetention: "long" })` 为例，`claudeModel.api === "anthropic-messages"`：

```
1. stream.ts: stream(claudeModel, ctx, opts)
   │
2. stream.ts: resolveApiProvider("anthropic-messages")
   │
3. api-registry.ts: apiProviderRegistry.get("anthropic-messages")
   │  返回 { provider: { api, stream: wrappedFn, streamSimple: ... } }
   │
4. api-registry.ts: wrappedFn(claudeModel, ctx, opts)
   │  wrapStream 运行时校验: claudeModel.api === "anthropic-messages" ✓
   │  调用内部 stream 函数（即 register-builtins 中的 streamAnthropic）
   │
5. register-builtins.ts: streamAnthropic(claudeModel, ctx, opts)
   │  这是 createLazyStream(loadAnthropicProviderModule) 生成的函数
   │  ├─ 同步: new AssistantMessageEventStream() → return outer
   │  └─ 异步: loadAnthropicProviderModule()
   │
6. register-builtins.ts: loadAnthropicProviderModule()
   │  anthropicProviderModulePromise ||= import("./anthropic.js")
   │  （第一次调用触发 import，之后复用 Promise）
   │
7. anthropic.js 模块加载完毕
   │  provider.streamAnthropic(claudeModel, ctx, opts) 开始执行
   │  → 构造 HTTP 请求 → 发送到 api.anthropic.com
   │  → 返回 AsyncIterable<AssistantMessageEvent>（inner stream）
   │
8. register-builtins.ts: forwardStream(outer, inner)
   │  for await (event of inner) { outer.push(event); }
   │  inner 完成 → outer.end()
   │
9. stream.ts 的调用者:
   for await (const event of outer) {
     // 收到 text / thinking / tool_call / usage / stop 事件
   }
```

### 函数包装层数（从外到内）

```
stream.ts:stream()                           — 入口，查路由
  → api-registry.ts:wrappedFn()              — 运行时类型校验
    → register-builtins.ts:streamAnthropic() — createLazyStream 生成的壳
      → loadAnthropicProviderModule()        — 动态 import + 缓存
        → anthropic.ts:streamAnthropic()     — 真正的 HTTP 调用
```

共 5 层。看起来多，但每一层都有明确职责：路由 → 校验 → 懒加载 → 缓存 → 实现。且中间 3 层都是极薄的函数调用，没有额外开销。

---

## 6. 副作用导入详解：import "./providers/register-builtins.js"

### 6.1 这是什么

```typescript
// stream.ts 第 1 行
import "./providers/register-builtins.js";
```

这是一个**纯副作用导入**（side-effect-only import）。没有 `import { xxx }`，所以在 `stream.ts` 中**没有任何新的变量、函数或类型**可以直接使用。

### 6.2 它做了什么

它的唯一作用是：**执行 `register-builtins.ts` 这个模块文件**，触发其中的顶层代码。

具体来说，`register-builtins.ts` 的最后一行是：

```typescript
// register-builtins.ts 第 433 行
registerBuiltInApiProviders();
```

这个函数对每一个内置 LLM provider 调用 `registerApiProvider()`，将它们写入 `api-registry.ts` 中的模块级 Map。

### 6.3 在 stream.ts 内可以使用什么外部变量

**零个**。没有任何导出绑定被引入到 `stream.ts` 的作用域中。

### 6.4 为什么不能去掉

如果去掉，`apiProviderRegistry` 就是空的，`stream.ts` 中的 `resolveApiProvider()` 会抛出 `"No API provider registered for api: ..."` 错误。

### 6.5 为什么放在第一行

确保在任何 `stream()` / `streamSimple()` 调用之前，所有 provider 已注册完毕。ES Module 的 import 语句按顺序执行，第 1 行的副作用导入会在第 3 行的 `import { getApiProvider }` 之前完成。

---

## 7. 设计模式总结

| 模式 | 体现在哪里 |
|---|---|
| **策略模式** | registry Map 存储可替换的策略实现，`model.api` 选择策略 |
| **门面模式** | `stream.ts` 对外只暴露 4 个函数，隐藏了注册表、懒加载等全部内部机制 |
| **工厂模式** | `createLazyStream` 是一个工厂函数，批量生产结构相同的懒加载壳 |
| **单例/缓存** | 每个 `xxxProviderModulePromise` 用 `\|\|=` 确保只 import 一次 |
| **代理模式** | `outer` stream 是 `inner` stream 的代理，在 inner 就绪前充当占位符 |
| **关注点分离** | 注册表不知道懒加载，懒加载不知道路由，路由不知道 HTTP 细节 |

### 为什么注册表这么简单就够了

因为这个架构把复杂性分层隔离了。注册表只做一件事：**字符串 → 函数的映射**。

所有 provider 共享同一个接口：`(model, context, options) => AssistantMessageEventStream`。只要接口统一，注册表就不需要知道 Anthropic 和 OpenAI 的任何区别。它不做序列化、不做认证、不做消息转换——这些全在各 provider 内部解决。

越简单的注册表越好——它意味着**添加新 provider 不需要修改路由逻辑**，只需要 `registerApiProvider({ api: "xxx", stream, streamSimple })`，路由自然就通了。

### 添加一个新 LLM provider 需要提供什么

只需要提供一个 `ApiProvider` 对象，包含三样东西：

1. `api` — 一个字符串标识符（如 `"my-new-api"`）
2. `stream` — 接受 provider 特有 options 的流式调用函数
3. `streamSimple` — 接受统一 `SimpleStreamOptions` 的流式调用函数

两个函数都必须满足 `StreamFunction` 的合约：
- 返回 `AssistantMessageEventStream`
- 不能 throw，所有错误都必须编码在 stream 事件中
- 错误终止必须产出 `stopReason: "error"` 或 `"aborted"` 的 `AssistantMessage`

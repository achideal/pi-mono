# 02 · ApiProvider 注册表 + 懒加载动态 import 架构

> 位置：`packages/ai/src/api-registry.ts`、`packages/ai/src/providers/register-builtins.ts`、`packages/ai/src/stream.ts`
>
> 提炼点：**用"中心注册表 + 按需 import() + 外壳 Stream 对象"，实现十几个 LLM Provider 既能被统一调用、又不会在启动时全部加载。**

---

## 1. 问题是"Provider 膨胀"带来的冷启动负担

pi-ai 支持的 Provider 数量越来越多（OpenAI/Azure/Anthropic/Google/GoogleCli/Vertex/Mistral/Groq/Cerebras/xAI/OpenRouter/Bedrock/Mini Max/…）。每个 Provider：

- 依赖不同 SDK 和转换逻辑（Bedrock 需要 `@aws-sdk/*`，一百多 KB）。
- 有自己的鉴权方式、OAuth 流程、headers、consts。
- 大部分场景下，一次请求只会用到其中**一个**。

天真的写法——`import * from "./providers/*"`——会把所有 Provider 的代码和依赖都载入内存，不仅启动慢，还让浏览器场景（比如 Bedrock 依赖 Node-only 的 AWS SDK）直接无法 bundle。

pi-ai 用三层结构把这个问题优雅地解决了。

---

## 2. 中心注册表：把"协议名"映射到"一组函数"

`packages/ai/src/api-registry.ts` 提供了非常轻量的注册表：

```ts
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
  provider: ApiProvider<TApi, TOptions>,
  sourceId?: string,
): void { ... }

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
  return apiProviderRegistry.get(api)?.provider;
}
```

几个要点：

### 2.1 用 `api` 字段（不是 `provider`）做 key

`api` 是**协议**（`"anthropic-messages"`、`"openai-completions"`），不是**厂商**（`"anthropic"`、`"xai"`）。

这是一个看似细微但影响巨大的抽象：

- xAI、Groq、Cerebras、OpenRouter、Vercel AI Gateway、很多自托管服务**全部用 `openai-completions` 协议**。
- 注册一次 `openai-completions` 的 stream 实现，上面一堆厂商都复用。
- 新增"又一个 OpenAI 兼容服务"时，完全不用改 `providers/` 目录，只要在 `models.generated.ts` 里加条模型记录就行。

### 2.2 `wrapStream` 做类型擦除 + 运行时校验

```ts
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

为什么需要这个包装？

- **类型层**：每个 Provider 的 `stream` 签名是强类型的（`Model<"anthropic-messages">`），但注册表只能存"擦除后的通用类型"。wrap 完成类型边界的桥接。
- **运行时**：防止程序员用 `anthropic` 模型调用了 `openai-completions` 的 stream。不命中的话早失败胜过错误的请求飞上天。

### 2.3 `sourceId` + `unregisterApiProviders`

注册接口支持"来源 id"，这让**Extension 层**（第 17 篇会讲）可以注册自己的 Provider，并在热更新时精准反注册自己那批：

```ts
export function unregisterApiProviders(sourceId: string): void {
  for (const [api, entry] of apiProviderRegistry.entries()) {
    if (entry.sourceId === sourceId) apiProviderRegistry.delete(api);
  }
}
```

这为"第三方扩展新增 Provider"留了稳定的扩展口，核心包不需要每次都重新发版。

---

## 3. 懒加载：所有 Provider 模块都靠 `import()` 拉取

真正精彩的部分在 `packages/ai/src/providers/register-builtins.ts`：

```ts
function loadAnthropicProviderModule(): Promise<LazyProviderModule<...>> {
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

### 3.1 Memoized 动态 import

每个 Provider 有一个 `let xxxProviderModulePromise: Promise<...> | undefined`。
第一次访问：`||=` 触发 `import()`，产出一个 Promise 缓存下来。
第二次访问：直接返回同一个 Promise。

这等价于 JS 层的"**单例懒加载**"，没有一行锁代码，多次并发调用也不会重复 import。

### 3.2 createLazyStream 把 Promise 包装成同步返回的 EventStream

外部 API 要求同步返回 `AssistantMessageEventStream`，不允许先 await。怎么做？

```ts
function createLazyStream(loadModule): StreamFunction {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();

    loadModule()
      .then((module) => {
        const inner = module.stream(model, context, options);
        forwardStream(outer, inner);   // 把内部事件转发到外壳
      })
      .catch((error) => {
        const message = createLazyLoadErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      });

    return outer;   // 立刻返回，不等 import
  };
}
```

精妙之处：

1. **函数保持同步返回**，外部 API 签名不变。
2. 真正的流是懒加载后才开始的。调用者不管懒不懒，只管 `for await` 就行。
3. **懒加载失败也被当作一个正常的 error 事件**（带 stopReason: "error" 的 AssistantMessage）。调用方不需要区分"加载失败"和"API 请求失败"，两种错误的处理路径完全一致。这是对事件协议一致性的极致延伸。

### 3.3 `forwardStream` 只做搬运

```ts
function forwardStream(target, source): void {
  (async () => {
    for await (const event of source) target.push(event);
    target.end();
  })();
}
```

没有额外逻辑、没有状态，就是管道。它的存在让"两层 stream"的包装成本接近于零。

---

## 4. Bedrock：对浏览器不友好的 Provider 如何特殊处理

Bedrock 用的是 `@aws-sdk/client-bedrock-runtime`，这东西**不能 bundle 到浏览器**。

看看 `register-builtins.ts` 怎么处理：

```ts
const importNodeOnlyProvider = (specifier: string): Promise<unknown> => import(specifier);

function loadBedrockProviderModule(): Promise<LazyProviderModule<...>> {
  if (bedrockProviderModuleOverride) return Promise.resolve(bedrockProviderModuleOverride);
  bedrockProviderModulePromise ||= importNodeOnlyProvider("./amazon-bedrock.js").then((module) => {
    const provider = module as BedrockProviderModule;
    return { stream: provider.streamBedrock, streamSimple: provider.streamSimpleBedrock };
  });
  return bedrockProviderModulePromise;
}
```

以及 `export function setBedrockProviderModule(module)`：

- 用一个间接函数 `importNodeOnlyProvider` 包住 `import()`，**bundler 可以通过它的签名判断为 Node-only**，不会错误地把 AWS SDK 打进浏览器包。
- `bedrockProviderModuleOverride` 让测试 / SDK 使用者可以在 Node 环境 **注入一个已经加载好的 Bedrock 模块**，避免在严格 ESM 环境里再次 resolve。
- 即使浏览器用户模型列表里出现 Bedrock 模型，运行时也只会走到 lazy load 才失败，**不影响包的基本可用性**。

这一块是 **"分层 + 懒加载"设计最大的收益之一**：不同环境可装配的 Provider 自然分离。

---

## 5. 与用户 API 的无感衔接

`stream.ts` 里一层非常薄的门面：

```ts
import "./providers/register-builtins.js";
import { getApiProvider } from "./api-registry.js";

function resolveApiProvider(api: Api) {
  const provider = getApiProvider(api);
  if (!provider) throw new Error(`No API provider registered for api: ${api}`);
  return provider;
}

export function stream<TApi extends Api>(model, context, options) {
  return resolveApiProvider(model.api).stream(model, context, options);
}
```

- `import "./providers/register-builtins.js"` **只是为了触发副作用**（注册）。模块最底部有一行 `registerBuiltInApiProviders();` 作为顶层调用。
- 用户只接触 `stream(model, ctx)`，从不需要知道"注册表"存在。

这是一个教科书级别的"注册表 + 门面"组合：用户 API 简单到只暴露一个函数，内部却挂了十几个 Provider，而且都是按需加载。

---

## 6. 可以直接学走的套路

1. **按"协议"分类，不按"厂商"分类**。让 N 家兼容实现共享一条路径。
2. **注册表 + `sourceId`**：核心和第三方扩展共用同一个扩展点。
3. **`||=` 缓存 Promise = 无锁单例懒加载**。
4. **把异步加载包装成同步返回的外壳流**：失败也走正常 error 事件。
5. **Node-only 依赖用间接 import 包装**：bundler 能识别、浏览器能活下来。
6. **顶层副作用触发内置注册**：调用方 0 配置。

这种模式在所有"多插件、多实现、启动敏感"的系统里都适用。比如数据库驱动、日志后端、telemetry exporter，甚至自家业务的策略引擎。只要改掉 `ApiProvider` 里的字段就能套用。


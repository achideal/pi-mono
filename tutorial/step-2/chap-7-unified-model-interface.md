# 第 7 章：统一模型接口为什么重要

## 前置知识

本章是第二阶段（理解底层 LLM 接口层）的起点。你需要理解前六章的核心概念：

- LLM 是基于 token 的文本生成器，有明确的能力边界（第 1 章）
- Agent = 模型 + 循环 + 工具 + 状态（第 2 章）
- Agent 的最小闭环是"用户消息 → 模型响应 → 工具调用 → 工具结果 → 继续推理"（第 3 章）
- 工具调用让模型从"会说"变成"会做"（第 4 章）
- 上下文窗口是 agent 的核心资源，需要精心管理（第 5 章）
- 记忆、会话、状态是三个不同层次的概念（第 6 章）

如果这些概念还不清楚，建议先回顾对应章节。

## 本章聚焦的层次

本章深入 `packages/ai` 的内部架构，回答一个工程问题：**为什么需要一个统一的模型接口层，它是怎么设计的？**

前六章中，我们多次提到"调用模型"，但一直把它当作黑盒。从本章开始，我们打开这个黑盒，看看 `packages/ai` 内部是怎么把"和不同模型厂商说话"这件事变成一个干净的接口的。

这不是一个"锦上添花"的工程问题。如果没有统一接口，agent 层的每一行代码都会被 provider 差异污染。

## 问题：为什么不能直接用 SDK

假设你要做一个 agent，支持 OpenAI 和 Anthropic 两个模型。最直觉的做法是直接用它们的官方 SDK：

```typescript
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";

async function chat(provider: string, prompt: string) {
  if (provider === "openai") {
    const openai = new OpenAI();
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: prompt }],
    });
    return response.choices[0].message.content;
  } else if (provider === "anthropic") {
    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    });
    return response.content[0].type === "text" ? response.content[0].text : "";
  }
}
```

看起来还行？但这只是最简单的场景——纯文本、单轮、无工具。一旦加入真实 agent 需要的功能，问题就爆炸了。

### 差异维度一：消息格式

第 1 章已经详细列举过各 provider 的消息格式差异。这里再强调一个关键点：**连 system prompt 的传递方式都不统一**。

- OpenAI：放在 `messages` 数组中，`role: "system"` 或 `role: "developer"`
- Anthropic：放在请求体的顶层 `system` 字段
- Google：放在 `systemInstruction` 字段

这意味着，如果你在 agent 层直接构造 API 请求，光是"设置 system prompt"这一个操作，就需要三套代码。

### 差异维度二：工具调用协议

模型"请求调用工具"的方式在各 provider 间差异显著：

- OpenAI Chat Completions：工具调用在 `delta.tool_calls` 数组中，参数是 JSON 字符串，流式时分片到达
- Anthropic：工具调用是 `type: "tool_use"` 的内容块，参数是 JSON 对象（不是字符串）
- Google Gemini：工具调用是 `functionCall` part，早期版本没有 `id` 字段，需要自己生成

连工具调用 ID 的格式都不兼容。OpenAI Responses API 生成的 ID 可以超过 450 个字符并包含 `|` 等特殊字符，而 Anthropic 要求 ID 必须匹配 `^[a-zA-Z0-9_-]+$` 且不超过 64 字符。

### 差异维度三：流式事件结构

每个 provider 的流式输出格式完全不同：

- OpenAI Chat Completions：`ChatCompletionChunk` 对象流
- OpenAI Responses：`ResponseStreamEvent` 事件流，粒度更细
- Anthropic：`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_stop` 的事件序列
- Google Gemini：SSE 格式的 `GenerateContentResponse` 流

### 差异维度四：认证方式

- OpenAI：`Authorization: Bearer sk-...` header
- Anthropic：`x-api-key` header（不是 `Authorization`）
- Google：API key 通过 URL 参数传递，或使用 OAuth2
- Amazon Bedrock：AWS Signature V4 签名认证

### 差异维度五：Token 计量

各 provider 返回 token 使用量的字段名和语义都不同：

- OpenAI Chat Completions：`usage.prompt_tokens`、`usage.completion_tokens`
- Anthropic：`usage.input_tokens`、`usage.output_tokens`、`usage.cache_read_input_tokens`
- Google Gemini：`usageMetadata.promptTokenCount`、`usageMetadata.candidatesTokenCount`
- Mistral：`usage.promptTokens`、`usage.completionTokens`（驼峰命名）

### 如果不统一会怎样

如果应用层直接对接每个 provider 的 SDK，代码会变成这样：

```typescript
// agent-loop.ts（假想的没有统一接口的版本）
async function callModel(provider: string, messages: any[], tools: any[]) {
  if (provider === "openai") {
    // 构造 OpenAI 格式的消息
    // 构造 OpenAI 格式的工具定义
    // 处理 OpenAI 格式的流式事件
    // 解析 OpenAI 格式的 token 使用量
  } else if (provider === "anthropic") {
    // 构造 Anthropic 格式的消息（合并连续 user 消息）
    // 构造 Anthropic 格式的工具定义
    // 处理 Anthropic 格式的流式事件
    // 解析 Anthropic 格式的 token 使用量
  } else if (provider === "google") {
    // ...又一套完全不同的逻辑
  }
  // 每加一个 provider，所有调用点都要改
}
```

这不只是代码冗余的问题。更严重的是：

1. **agent 层和 provider 层耦合**：agent 循环的逻辑被 provider 差异污染，难以理解和维护
2. **新 provider 的接入成本高**：每加一个 provider，需要修改 agent 层的多个文件
3. **测试困难**：你无法独立测试 agent 逻辑，因为它和 provider 逻辑纠缠在一起
4. **运行时切换模型变得复杂**：用户想从 Claude 切换到 GPT-4o，需要重建整个调用链

## 解决方案：三层抽象

pi-mono 的 `packages/ai` 通过三层抽象解决这个问题：

```
应用层（packages/agent, packages/coding-agent）
    ↓ 调用统一接口：stream(model, context, options)
统一接口层（packages/ai/src/stream.ts）
    ↓ 根据 model.api 路由到对应 provider
Provider 实现层（packages/ai/src/providers/*.ts）
    ↓ 翻译成各 provider 的原生 API 调用
各模型厂商 API（OpenAI, Anthropic, Google, ...）
```

### 第一层：统一调用接口

应用层只需要知道三个东西：`Model`、`Context`、`stream`。

```typescript
// packages/ai/src/stream.ts
import { getApiProvider } from "./api-registry.js";

function resolveApiProvider(api: Api) {
  const provider = getApiProvider(api);
  if (!provider) {
    throw new Error(`No API provider registered for api: ${api}`);
  }
  return provider;
}

export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  const provider = resolveApiProvider(model.api);
  return provider.stream(model, context, options as StreamOptions);
}

export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  const s = stream(model, context, options);
  return s.result();
}
```

整个文件只有 60 行。`stream` 函数做的事情极其简单：根据 `model.api` 找到对应的 provider 实现，然后委托给它。`complete` 只是 `stream` 的便捷封装——启动流，等待最终结果。

这意味着 agent 层的代码可以这样写：

```typescript
// agent 层不需要知道底层用的是哪个 provider
const model = getModel("anthropic", "claude-sonnet-4-20250514");
const s = stream(model, { systemPrompt: "...", messages: [...], tools: [...] });
for await (const event of s) {
  // 处理统一格式的事件
}
```

换一个模型？只改一行：

```typescript
const model = getModel("openai", "gpt-4o");
// 其余代码完全不变
```

### 第二层：API Provider 注册表

`stream` 函数怎么知道该用哪个 provider 实现？答案是 **API Provider 注册表**。

```typescript
// packages/ai/src/api-registry.ts
export interface ApiProvider<TApi extends Api, TOptions extends StreamOptions> {
  api: TApi;
  stream: StreamFunction<TApi, TOptions>;
  streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}

const apiProviderRegistry = new Map<string, RegisteredApiProvider>();

export function registerApiProvider<
  TApi extends Api,
  TOptions extends StreamOptions,
>(provider: ApiProvider<TApi, TOptions>, sourceId?: string): void {
  apiProviderRegistry.set(provider.api, {
    provider: {
      /* ... */
    },
    sourceId,
  });
}

export function getApiProvider(api: Api): ApiProviderInternal | undefined {
  return apiProviderRegistry.get(api)?.provider;
}
```

注册表是一个 `Map<string, ApiProvider>`，key 是 API 类型（如 `"anthropic-messages"`、`"openai-completions"`），value 是对应的 provider 实现。

注意这里的 key 是 **API 类型**，不是 **provider 名称**。这是一个重要的设计决策——一个 API 类型可以被多个 provider 共用。比如 xAI、Groq、Cerebras 都兼容 OpenAI 的 Chat Completions API，所以它们共用 `"openai-completions"` 这个 API 实现。

内置的 provider 在模块加载时自动注册：

```typescript
// packages/ai/src/providers/register-builtins.ts（末尾）
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

  registerApiProvider({
    api: "google-generative-ai",
    stream: streamGoogle,
    streamSimple: streamSimpleGoogle,
  });

  // ... 其他 provider
}

// 模块加载时自动执行
registerBuiltInApiProviders();
```

pi-mono 目前内置了 **10 种 API 实现**：

| API 类型                  | 对应 Provider                              | 实现文件                    |
| ------------------------- | ------------------------------------------ | --------------------------- |
| `anthropic-messages`      | Anthropic                                  | `anthropic.ts`              |
| `openai-completions`      | OpenAI, xAI, Groq, Cerebras, OpenRouter 等 | `openai-completions.ts`     |
| `openai-responses`        | OpenAI (Responses API)                     | `openai-responses.ts`       |
| `azure-openai-responses`  | Azure OpenAI                               | `azure-openai-responses.ts` |
| `openai-codex-responses`  | OpenAI Codex                               | `openai-codex-responses.ts` |
| `google-generative-ai`    | Google Gemini                              | `google.ts`                 |
| `google-gemini-cli`       | Google Gemini CLI                          | `google-gemini-cli.ts`      |
| `google-vertex`           | Google Vertex AI                           | `google-vertex.ts`          |
| `mistral-conversations`   | Mistral                                    | `mistral.ts`                |
| `bedrock-converse-stream` | Amazon Bedrock                             | `amazon-bedrock.ts`         |

注册表还支持动态注册和注销，这让外部扩展可以添加自定义 provider：

```typescript
// 注册自定义 provider
registerApiProvider(
  {
    api: "my-custom-api",
    stream: myCustomStream,
    streamSimple: myCustomStreamSimple,
  },
  "my-extension",
);

// 注销特定来源的 provider
unregisterApiProviders("my-extension");

// 清空并重新注册所有内置 provider
resetApiProviders();
```

### 第三层：Provider 实现

每个 provider 实现文件（如 `anthropic.ts`、`openai-completions.ts`）负责一件事：**把统一的 `Model` + `Context` + `StreamOptions` 翻译成该 provider 的原生 API 调用，然后把原生响应翻译回统一的 `AssistantMessageEvent` 事件流**。

以 Anthropic 为例，provider 实现大致做了这些事：

1. **构造请求**：把 `Context.systemPrompt` 放到请求体的顶层 `system` 字段（而不是 messages 中）；把 `Context.messages` 转换成 Anthropic 格式（合并连续的 user 消息，把 `toolResult` 包装成 `tool_result` 内容块放在 user 消息中）；把 `Context.tools` 转换成 Anthropic 的工具定义格式
2. **发送请求**：使用 Anthropic SDK 发起流式请求
3. **解析响应**：监听 `message_start`、`content_block_start`、`content_block_delta` 等原生事件，翻译成统一的 `text_delta`、`toolcall_start`、`toolcall_end` 等事件
4. **计算 token**：把 Anthropic 的 `usage.input_tokens`、`usage.cache_read_input_tokens` 等字段归一化为统一的 `Usage` 格式

每个 provider 实现文件都在 200-800 行之间，包含了大量的格式转换和边界情况处理。但这些复杂性被完全封装在 provider 内部，上层代码完全不需要知道。

## Provider vs API：一个容易混淆的概念

在 pi-mono 中，**provider** 和 **API** 是两个不同的维度：

- **Provider**（提供商）：谁提供模型服务。比如 `openai`、`anthropic`、`google`、`xai`、`groq`
- **API**：用什么协议和模型通信。比如 `openai-completions`、`anthropic-messages`、`google-generative-ai`

它们的关系是多对多的：

```
Provider          API
─────────         ─────────────────
anthropic    →    anthropic-messages
openai       →    openai-completions
openai       →    openai-responses
xai          →    openai-completions    ← 共用！
groq         →    openai-completions    ← 共用！
cerebras     →    openai-completions    ← 共用！
openrouter   →    openai-completions    ← 共用！
google       →    google-generative-ai
google-vertex →   google-vertex
```

一个 provider 可能使用特定的 API（Anthropic 用 `anthropic-messages`），但多个 provider 也可能共用同一个 API（xAI、Groq、Cerebras 都兼容 OpenAI 的接口，所以共用 `openai-completions`）。

这就是为什么注册表的 key 是 API 类型而不是 provider 名称——同一个 API 实现可以服务多个 provider。区分 provider 和 API 的信息记录在 `Model` 对象中：

```typescript
// getModel("xai", "grok-3-mini") 返回的 Model 对象
{
  id: "grok-3-mini",
  provider: "xai",           // provider 是 xAI
  api: "openai-completions", // 但 API 协议是 OpenAI 兼容的
  baseUrl: "https://api.x.ai/v1",
  // ...
}
```

当 `stream(model, context)` 被调用时，它根据 `model.api`（`"openai-completions"`）找到 provider 实现，然后 provider 实现根据 `model.baseUrl`（`"https://api.x.ai/v1"`）知道该把请求发到哪里。

## 模型注册表：编译时的类型安全

除了运行时的 API Provider 注册表，pi-mono 还有一个**模型注册表**——一个自动生成的巨大文件 `models.generated.ts`（353KB），包含所有已知 provider 的所有模型及其元数据。

```typescript
// packages/ai/src/models.ts
import { MODELS } from "./models.generated.js";

const modelRegistry: Map<string, Map<string, Model<Api>>> = new Map();

// 模块加载时从 MODELS 初始化注册表
for (const [provider, models] of Object.entries(MODELS)) {
  const providerModels = new Map<string, Model<Api>>();
  for (const [id, model] of Object.entries(models)) {
    providerModels.set(id, model as Model<Api>);
  }
  modelRegistry.set(provider, providerModels);
}
```

`getModel` 函数从这个注册表中查找模型：

```typescript
export function getModel<
  TProvider extends KnownProvider,
  TModelId extends keyof (typeof MODELS)[TProvider],
>(
  provider: TProvider,
  modelId: TModelId,
): Model<ModelApi<TProvider, TModelId>> {
  const providerModels = modelRegistry.get(provider);
  return providerModels?.get(modelId as string) as Model<
    ModelApi<TProvider, TModelId>
  >;
}
```

注意泛型签名：`TProvider` 被约束为 `KnownProvider`，`TModelId` 被约束为该 provider 下已知的模型 ID。这意味着：

```typescript
// ✅ 编译通过——openai 下确实有 gpt-4o
const model1 = getModel("openai", "gpt-4o");

// ❌ 编译报错——openai 下没有 claude-sonnet-4-20250514
const model2 = getModel("openai", "claude-sonnet-4-20250514");

// ✅ 编译通过——anthropic 下确实有 claude-sonnet-4-20250514
const model3 = getModel("anthropic", "claude-sonnet-4-20250514");
```

而且返回类型也是精确的——`getModel("anthropic", "claude-sonnet-4-20250514")` 返回的是 `Model<"anthropic-messages">`，不是泛化的 `Model<Api>`。这让后续代码可以根据 API 类型做类型安全的分支处理。

模型注册表还提供了其他实用函数：

```typescript
// 获取所有已知 provider
getProviders(); // ["openai", "anthropic", "google", ...]

// 获取某个 provider 的所有模型
getModels("openai"); // [Model<"openai-completions">, Model<"openai-responses">, ...]

// 计算一次调用的费用
calculateCost(model, usage); // 根据模型的单价和实际 token 用量计算

// 检查两个模型是否相同
modelsAreEqual(modelA, modelB); // 比较 id 和 provider
```

## 懒加载：不用的 provider 不加载

pi-mono 支持 10 种 API 实现，每种都依赖不同的 SDK（OpenAI SDK、Anthropic SDK、Google GenAI SDK、AWS SDK 等）。如果在模块加载时就全部导入，启动时间和内存占用都会很大。

`register-builtins.ts` 使用**懒加载**解决这个问题：

```typescript
// packages/ai/src/providers/register-builtins.ts（简化）

// 不是直接 import，而是在首次调用时才加载
let anthropicProviderModulePromise: Promise<...> | undefined;

function loadAnthropicProviderModule() {
  // 只在第一次调用时 import，后续复用 promise
  anthropicProviderModulePromise ||= import("./anthropic.js").then((module) => {
    return {
      stream: module.streamAnthropic,
      streamSimple: module.streamSimpleAnthropic,
    };
  });
  return anthropicProviderModulePromise;
}

// 创建一个"懒代理"——注册时不加载模块，调用时才加载
function createLazyStream(loadModule) {
  return (model, context, options) => {
    const outer = new AssistantMessageEventStream();

    loadModule()
      .then((module) => {
        const inner = module.stream(model, context, options);
        forwardStream(outer, inner);
      })
      .catch((error) => {
        const message = createLazyLoadErrorMessage(model, error);
        outer.push({ type: "error", reason: "error", error: message });
        outer.end(message);
      });

    return outer;
  };
}

// 注册时用懒代理
export const streamAnthropic = createLazyStream(loadAnthropicProviderModule);
```

这个设计的巧妙之处在于：

1. **注册时不加载**：`registerApiProvider` 注册的是懒代理函数，不是真正的 provider 实现
2. **首次调用时加载**：当 `stream(model, context)` 第一次被调用且 `model.api === "anthropic-messages"` 时，才会触发 `import("./anthropic.js")`
3. **后续调用复用**：`anthropicProviderModulePromise ||= ...` 确保模块只加载一次
4. **加载失败优雅处理**：如果 SDK 不可用（比如在浏览器环境中加载 Node.js 专用的 Bedrock SDK），错误会被转换为标准的 `error` 事件，而不是未捕获的异常

这意味着如果你只用 Anthropic 的模型，OpenAI、Google、Bedrock 等 SDK 永远不会被加载。

## stream vs streamSimple：两种调用风格

每个 provider 都注册了两个函数：`stream` 和 `streamSimple`。它们的区别在于选项的抽象级别。

**`stream`**：接受 provider 特定的选项。

```typescript
import { stream } from "@mariozechner/pi-ai";
import type { AnthropicOptions } from "@mariozechner/pi-ai";

// Anthropic 特有的选项：精确控制 thinking budget
const options: AnthropicOptions = {
  thinkingBudgetTokens: 8192,
  temperature: 1, // Anthropic 要求 thinking 模式下 temperature 必须为 1
};

const s = stream(model, context, options);
```

**`streamSimple`**：接受统一的选项，由库自动映射到各 provider 的具体参数。

```typescript
import { streamSimple } from "@mariozechner/pi-ai";

// 统一的选项：不需要知道 provider 的细节
const s = streamSimple(model, context, {
  reasoning: "medium", // 自动映射到各 provider 的 thinking 参数
});
```

映射逻辑在 `simple-options.ts` 中：

```typescript
// packages/ai/src/providers/simple-options.ts
export function buildBaseOptions(
  model: Model<Api>,
  options?: SimpleStreamOptions,
  apiKey?: string,
): StreamOptions {
  return {
    temperature: options?.temperature,
    maxTokens: options?.maxTokens || Math.min(model.maxTokens, 32000),
    signal: options?.signal,
    apiKey: apiKey || options?.apiKey,
    cacheRetention: options?.cacheRetention,
    // ...
  };
}

export function adjustMaxTokensForThinking(
  baseMaxTokens: number,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: ThinkingBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  // ...
}
```

`reasoning: "medium"` 在不同 provider 下会被映射为：

- Anthropic：`thinkingBudgetTokens: 8192`
- OpenAI：`reasoning_effort: "medium"`
- Google：对应的 thinking 配置

这让 agent 层可以用统一的方式控制推理强度，而不需要知道每个 provider 的具体参数名。

## API Key 解析：又一个被统一的差异

不同 provider 的 API key 来源也各不相同。pi-mono 通过 `getEnvApiKey` 函数统一处理：

```typescript
// packages/ai/src/env-api-keys.ts
export function getEnvApiKey(provider: string): string | undefined {
  // GitHub Copilot 有多个可能的环境变量
  if (provider === "github-copilot") {
    return (
      process.env.COPILOT_GITHUB_TOKEN ||
      process.env.GH_TOKEN ||
      process.env.GITHUB_TOKEN
    );
  }

  // Anthropic 的 OAuth token 优先于 API key
  if (provider === "anthropic") {
    return process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
  }

  // Google Vertex 支持 API key 或 Application Default Credentials
  if (provider === "google-vertex") {
    if (process.env.GOOGLE_CLOUD_API_KEY) {
      return process.env.GOOGLE_CLOUD_API_KEY;
    }
    // 检查 ADC 凭证文件是否存在
    if (hasVertexAdcCredentials() && hasProject && hasLocation) {
      return "<authenticated>";
    }
  }

  // Amazon Bedrock 支持多种 AWS 认证方式
  if (provider === "amazon-bedrock") {
    if (
      process.env.AWS_PROFILE ||
      (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) ||
      process.env.AWS_BEARER_TOKEN_BEDROCK
      // ... 更多 AWS 认证方式
    ) {
      return "<authenticated>";
    }
  }

  // 其他 provider 使用简单的环境变量映射
  const envMap: Record<string, string> = {
    openai: "OPENAI_API_KEY",
    google: "GEMINI_API_KEY",
    groq: "GROQ_API_KEY",
    xai: "XAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
    // ...
  };

  const envVar = envMap[provider];
  return envVar ? process.env[envVar] : undefined;
}
```

这个函数封装了各 provider 认证方式的差异：

- 有的用简单的 API key（OpenAI、Google、xAI）
- 有的有多个可能的环境变量（GitHub Copilot）
- 有的 OAuth token 优先于 API key（Anthropic）
- 有的使用文件系统凭证（Google Vertex 的 ADC）
- 有的使用 AWS 的多种认证机制（Bedrock）

上层代码只需要调用 `getEnvApiKey("anthropic")`，不需要知道 Anthropic 的 key 可能来自 `ANTHROPIC_OAUTH_TOKEN` 还是 `ANTHROPIC_API_KEY`。

## 跨 Provider 消息转换

当用户在 agent 运行过程中切换模型（比如从 Claude 切换到 GPT-4o），历史消息需要从一个 provider 的格式转换到另一个 provider 的格式。这由 `transform-messages.ts` 处理：

```typescript
// packages/ai/src/providers/transform-messages.ts
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (
    id: string,
    model: Model<TApi>,
    source: AssistantMessage,
  ) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();

  const transformed = messages.map((msg) => {
    if (msg.role === "user") return msg;

    if (msg.role === "assistant") {
      const isSameModel =
        assistantMsg.provider === model.provider &&
        assistantMsg.api === model.api &&
        assistantMsg.model === model.id;

      const transformedContent = assistantMsg.content.flatMap((block) => {
        if (block.type === "thinking") {
          // 加密的 thinking 只对同一模型有效，跨模型时丢弃
          if (block.redacted) return isSameModel ? block : [];
          // 非空 thinking 跨模型时转为普通文本
          if (!isSameModel) return { type: "text", text: block.thinking };
          return block;
        }

        if (block.type === "toolCall") {
          // 跨模型时归一化工具调用 ID
          if (!isSameModel && normalizeToolCallId) {
            const normalizedId = normalizeToolCallId(
              toolCall.id,
              model,
              assistantMsg,
            );
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              return { ...toolCall, id: normalizedId };
            }
          }
          return block;
        }
        return block;
      });

      return { ...assistantMsg, content: transformedContent };
    }

    // toolResult 消息：如果工具调用 ID 被归一化了，这里也要同步更新
    if (msg.role === "toolResult") {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId) return { ...msg, toolCallId: normalizedId };
      return msg;
    }
  });

  // 第二遍：为孤立的工具调用插入合成的错误结果
  // ...
}
```

这个函数处理了跨 provider 切换时的几个关键问题：

1. **Thinking 块转换**：Claude 的 thinking 块在发给 GPT-4o 时会被转换为普通文本；加密的 thinking（`redacted: true`）只对同一模型有效，跨模型时直接丢弃
2. **工具调用 ID 归一化**：OpenAI Responses API 生成的超长 ID 在发给 Anthropic 时需要截断和清理
3. **孤立工具调用处理**：如果历史消息中有工具调用但没有对应的结果（比如因为中断），会插入合成的错误结果，避免 API 报错
4. **错误/中断消息跳过**：`stopReason` 为 `"error"` 或 `"aborted"` 的助手消息会被跳过，因为它们可能包含不完整的内容

## 设计后果与权衡

### 统一接口的代价

统一接口意味着取最大公约数。每个 provider 都有独特的功能：

- OpenAI 的 `store` 字段（用于数据存储策略）
- Anthropic 的精确 cache 控制
- Google 的 grounding（搜索增强）
- OpenAI Codex 的特殊认证头

这些功能不能通过统一接口直接暴露。pi-mono 的策略是：

- **通用能力**（消息、工具、流式输出、temperature、maxTokens）走统一接口
- **特殊能力**通过两种方式暴露：
  1. `ProviderStreamOptions`（`StreamOptions & Record<string, unknown>`）允许传递任意额外字段
  2. 每个 provider 导出自己的 `Options` 类型（如 `AnthropicOptions`、`OpenAICompletionsOptions`），提供类型安全的特殊选项

### 为什么用 API 类型而不是 Provider 名称做注册 key

如果用 provider 名称做 key，xAI、Groq、Cerebras 等兼容 OpenAI 的 provider 就需要各自注册一份几乎相同的实现。用 API 类型做 key，这些 provider 可以共用同一个实现，差异通过 `Model.baseUrl` 和 `Model.compat` 处理。

但这也意味着同一个 API 类型下的不同 provider 可能有微妙的行为差异。比如 OpenRouter 的 `openai-completions` 实现和原生 OpenAI 的有些不同（缓存 token 的报告方式不同）。这些差异通过 `OpenAICompletionsCompat` 接口处理：

```typescript
export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen";
  // ...
}
```

每个模型的 `compat` 字段记录了它和"标准" OpenAI API 的差异，provider 实现根据这些字段调整行为。

### 懒加载的代价

懒加载意味着第一次调用某个 provider 时会有额外的延迟（需要加载模块）。但这个延迟只发生一次，而且通常被网络请求的延迟掩盖。

更重要的是，懒加载让 `packages/ai` 可以在浏览器环境中使用——浏览器不支持 Node.js 专用的 AWS SDK，但只要你不调用 Bedrock 模型，这个 SDK 就永远不会被加载，也就不会报错。

## 后续章节预告

本章解释了为什么需要统一模型接口，以及 pi-mono 是怎么通过三层抽象（统一调用接口 → API Provider 注册表 → Provider 实现）来实现的。

下一章（第 8 章：消息格式是 agent 的基础协议）会深入消息层面，详细讨论 `UserMessage`、`AssistantMessage`、`ToolResultMessage` 三种消息类型的设计，以及它们如何构成 agent 和 LLM 之间的通信协议。

## 小练习

1. **追踪一次调用**：从 `stream(getModel("anthropic", "claude-sonnet-4-20250514"), context)` 开始，追踪代码执行路径，列出经过的每个函数和文件。提示：从 `stream.ts` → `api-registry.ts` → `register-builtins.ts` → `anthropic.ts`。

   > **关键信息**：完整的调用链如下：
   >
   > 1. `stream.ts` 的 `stream()` 函数被调用，参数中 `model.api` 为 `"anthropic-messages"`
   > 2. `resolveApiProvider("anthropic-messages")` 调用 `api-registry.ts` 的 `getApiProvider()`，从 `apiProviderRegistry` Map 中查找
   > 3. 找到的是 `register-builtins.ts` 中注册的懒代理 `streamAnthropic`
   > 4. 懒代理调用 `createLazyStream(loadAnthropicProviderModule)`，首次调用时触发 `import("./anthropic.js")`
   > 5. 模块加载完成后，调用 `anthropic.ts` 中的 `streamAnthropic()` 函数
   > 6. `anthropic.ts` 内部：构造 Anthropic API 请求 → 使用 Anthropic SDK 发起流式调用 → 解析原生事件 → 翻译为统一的 `AssistantMessageEvent` → push 到 `AssistantMessageEventStream`
   > 7. 调用方通过 `for await (const event of s)` 消费统一事件
   >
   > 注意第 4 步的懒加载：如果之前已经调用过 Anthropic 模型，`anthropicProviderModulePromise` 已经有值，`import` 不会再次执行。

2. **理解 Provider vs API**：解释为什么 `getModel("xai", "grok-3-mini")` 返回的模型的 `api` 字段是 `"openai-completions"` 而不是 `"xai"`。如果 xAI 将来推出了自己的专有 API，pi-mono 需要做哪些改动？

   > **关键信息**：xAI 的 Grok 模型兼容 OpenAI 的 Chat Completions API，所以它的 `api` 字段是 `"openai-completions"`。这意味着调用 Grok 时，使用的是 `openai-completions.ts` 中的 provider 实现，只是 `baseUrl` 指向 `https://api.x.ai/v1`。
   >
   > 如果 xAI 推出专有 API，需要做以下改动：
   >
   > 1. 在 `types.ts` 的 `KnownApi` 中添加 `"xai-native"`（或类似名称）
   > 2. 创建新的 provider 实现文件 `xai-native.ts`，处理 xAI 专有 API 的请求构造和响应解析
   > 3. 在 `register-builtins.ts` 中添加懒加载和注册逻辑
   > 4. 在 `models.generated.ts` 中更新 xAI 模型的 `api` 字段为 `"xai-native"`
   >
   > 关键点：**上层代码（agent 层）完全不需要改动**。`stream(model, context)` 会自动根据新的 `api` 字段路由到新的 provider 实现。这就是统一接口的价值。

3. **对比两种调用风格**：分别用 `stream` 和 `streamSimple` 调用同一个模型，传入 `reasoning: "medium"`。追踪代码看看 `"medium"` 在 Anthropic 和 OpenAI 下分别被映射成了什么参数。

   > **关键信息**：
   >
   > **`streamSimple` 路径**：`reasoning: "medium"` 通过 `simple-options.ts` 的 `adjustMaxTokensForThinking` 函数处理。默认 budgets 中 `medium` 对应 `8192` token。
   >
   > - **Anthropic**：映射为 `thinkingBudgetTokens: 8192`，同时 `maxTokens` 被调整为 `baseMaxTokens + 8192`（但不超过模型的 `maxTokens`）。Anthropic 的 thinking 模式还要求 `temperature: 1`。
   > - **OpenAI**：映射为 `reasoning_effort: "medium"`（对于支持 reasoning 的模型如 o3）。对于不支持 reasoning 的模型（如 gpt-4o），这个参数会被忽略。
   >
   > **`stream` 路径**：你需要自己传入 provider 特定的参数。对于 Anthropic，你需要传 `{ thinkingBudgetTokens: 8192, temperature: 1 }`；对于 OpenAI，你需要传 `{ reasoningEffort: "medium" }`。格式完全不同。
   >
   > 这就是 `streamSimple` 的价值：用一个统一的 `reasoning: "medium"` 替代了各 provider 不同的参数格式。

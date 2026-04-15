# 第 3 章补充：10 个关键文件的深度讲解

> **定位**：本文是第 3 章"怎样高效阅读这个仓库"的补充材料。第 3 章给出了阅读路线图和概览；本文对"先读的 10 个文件"做逐项拆解，帮助你在打开每个文件时知道每一行在干什么、每个类型被谁消费。
>
> **阅读顺序**：按 pi-ai → pi-agent-core → pi-coding-agent 自底向上组织。底层的类型定义是上层一切的基础 — 先理解它们，再看循环引擎和产品层才不会迷失。

---

## 目录

- [第一部分：pi-ai 层](#第一部分pi-ai-层底层-llm-抽象)
  - [1. `packages/ai/src/types.ts`](#1-packagesaisrctypests)
  - [2. `packages/ai/src/api-registry.ts`](#2-packagesaisrcapi-registryts)
  - [3. `packages/ai/src/stream.ts`](#3-packagesaisrcstreamts)
- [第二部分：pi-agent-core 层](#第二部分pi-agent-core-层循环引擎)
  - [4. `packages/agent/src/types.ts`](#4-packagesagentsrctypests)
  - [5. `packages/agent/src/agent-loop.ts`](#5-packagesagentsrcagent-loopts)
  - [6. `packages/agent/src/agent.ts`](#6-packagesagentsrcagentts)
- [第三部分：pi-coding-agent 层](#第三部分pi-coding-agent-层产品实现)
  - [7. `packages/coding-agent/src/core/session-manager.ts`](#7-session-managerts)
  - [8. `packages/coding-agent/src/core/system-prompt.ts`](#8-system-promptts)
  - [9. `packages/coding-agent/src/core/tools/edit.ts`](#9-toolseditts)
  - [10. `packages/coding-agent/src/core/extensions/types.ts`](#10-extensionstypests)

---

# 第一部分：pi-ai 层（底层 LLM 抽象）

pi-ai 是整个系统的最底层 — 它不知道 agent 是什么，不知道工具是什么，不知道会话是什么。它只做一件事：**给定一个模型和一段上下文，返回一个流式的 LLM 响应**。这三个文件定义了这件事的全部契约。

---

## 1. `packages/ai/src/types.ts`

**文件概览**：约 400 行。这是 pi-ai 层的"公共 API 契约" — 上层代码（agent-core、coding-agent）只通过这些类型与 ai 层交互。你会在这里找到模型的描述、发送给 LLM 的上下文结构、LLM 返回的消息结构、流式事件协议，以及各种 provider 的兼容性配置。

### 1.1 API 与 Provider 标识

```typescript
type KnownApi = "openai-completions" | "mistral-conversations" | "openai-responses" | ...;
type Api = KnownApi | (string & {});

type KnownProvider = "anthropic" | "google" | "openai" | ...;
type Provider = KnownProvider | string;
```

- `KnownApi` 枚举了所有内置支持的 API 协议（约 10 种）。每种 API 对应一种 HTTP 请求格式。
- `Api` 是 `KnownApi` 的超集 — `(string & {})` 技巧允许任意字符串同时保留字面量类型的自动补全。
- `KnownProvider` 枚举了所有已知的 LLM 提供商（约 20 个），`Provider` 同样允许扩展。

**消费关系**：`Api` 用于 `Model.api` 字段，是 api-registry 的键；`Provider` 用于 `Model.provider` 字段，用于 API key 解析和路由。在 `agent/src/agent.ts` 中，`getApiKey` 回调接收 `provider` 参数来动态获取密钥。

**字面量例子**：

```typescript
const api: Api = "anthropic-messages";
const customApi: Api = "my-custom-api"; // (string & {}) 允许任意字符串

const provider: Provider = "anthropic";
const customProvider: Provider = "my-corp-proxy";
```

### 1.2 Thinking 相关类型

```typescript
type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

interface ThinkingBudgets {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
}
```

- `ThinkingLevel` 控制推理模型的"思考强度"。不同 provider 的映射方式不同（Anthropic 用 token 预算，OpenAI 用 `reasoning_effort` 参数）。
- `ThinkingBudgets` 为 token-based 的 provider 指定每个级别对应的 token 预算。

**消费关系**：`ThinkingLevel` 被 `agent/src/types.ts` 重新导出并扩展为 `"off" | ThinkingLevel`。`ThinkingBudgets` 作为 `SimpleStreamOptions` 的可选字段传入流函数。

**字面量例子**：

```typescript
const level: ThinkingLevel = "medium";

const budgets: ThinkingBudgets = {
    minimal: 1024,
    low: 4096,
    medium: 10240,
    high: 32768,
};
```

### 1.3 StreamOptions 系列

```typescript
interface StreamOptions {
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
    apiKey?: string;
    transport?: Transport;        // "sse" | "websocket" | "auto"
    cacheRetention?: CacheRetention; // "none" | "short" | "long"
    sessionId?: string;
    onPayload?: (payload, model) => unknown | undefined | Promise<...>;
    headers?: Record<string, string>;
    maxRetryDelayMs?: number;
    metadata?: Record<string, unknown>;
}

interface SimpleStreamOptions extends StreamOptions {
    reasoning?: ThinkingLevel;
    thinkingBudgets?: ThinkingBudgets;
}

type ProviderStreamOptions = StreamOptions & Record<string, unknown>;
```

| 字段 | 用途 |
|------|------|
| `temperature` | 控制生成随机性 |
| `maxTokens` | 最大输出 token 数 |
| `signal` | `AbortSignal`，用于取消请求 |
| `apiKey` | API 密钥，覆盖环境变量 |
| `transport` | 传输方式偏好（SSE / WebSocket） |
| `cacheRetention` | 提示缓存保留策略 |
| `sessionId` | 会话标识，用于 provider 侧缓存路由 |
| `onPayload` | 请求发送前的拦截回调，可以检查或替换 payload |
| `headers` | 自定义 HTTP 请求头 |
| `maxRetryDelayMs` | 服务端请求重试时的最大等待时间上限 |
| `metadata` | 附加元数据（如 Anthropic 的 `user_id`） |

- `SimpleStreamOptions` 在 `StreamOptions` 基础上加了 `reasoning` 和 `thinkingBudgets` — 这是上层代码（agent-core）最常使用的选项接口。
- `ProviderStreamOptions` 用于 `stream.ts` 的公共 API，允许传入 provider 特有的额外选项。

**消费关系**：`AgentLoopConfig` 继承自 `SimpleStreamOptions`，因此 agent 循环中的所有流式调用选项最终都源自这里。`Agent` 类在 `createLoopConfig()` 中把 `sessionId`、`transport`、`thinkingBudgets`、`maxRetryDelayMs` 等字段传入 config。

**字面量例子**：

```typescript
// StreamOptions
const opts: StreamOptions = {
    temperature: 0.7,
    maxTokens: 8192,
    signal: new AbortController().signal,
    apiKey: "sk-ant-api03-xxxx",
    transport: "sse",
    cacheRetention: "short",
    sessionId: "sess_abc123",
    headers: { "X-Custom": "value" },
    maxRetryDelayMs: 30000,
    metadata: { user_id: "user_42" },
};

// SimpleStreamOptions — 在 StreamOptions 基础上加了 reasoning
const simpleOpts: SimpleStreamOptions = {
    temperature: 0.5,
    maxTokens: 4096,
    reasoning: "high",
    thinkingBudgets: { high: 32768 },
};

// ProviderStreamOptions — 允许 provider 特有的额外字段
const providerOpts: ProviderStreamOptions = {
    temperature: 0.7,
    maxTokens: 8192,
    anthropicBeta: "some-beta-flag",  // provider 特有字段
};
```

### 1.4 StreamFunction — 流式调用的泛型签名

```typescript
type StreamFunction<TApi extends Api, TOptions extends StreamOptions> = (
    model: Model<TApi>,
    context: Context,
    options?: TOptions,
) => AssistantMessageEventStream;
```

这是 provider 实现的核心接口。每个 provider（Anthropic、OpenAI 等）都要提供一个满足这个签名的函数。约定：
- 返回 `AssistantMessageEventStream`（不是 Promise — 流在调用时即创建）
- 请求/运行时错误**不能抛出**，必须编码在返回的流中（通过 `error` 事件）

**消费关系**：`api-registry.ts` 中的 `ApiProvider` 接口要求提供 `stream` 和 `streamSimple` 两个 `StreamFunction`。

**字面量例子**（`StreamFunction` 是类型，展示其实际使用形式）：

```typescript
const myStream: StreamFunction<"anthropic-messages", StreamOptions> =
    (model, context, options?) => {
        return createEventStream(async function* () {
            yield { type: "start", partial: assistantMsg };
            yield { type: "done", reason: "stop", message: assistantMsg };
        });
    };
```

### 1.5 Content 类型（消息内容块）

```typescript
interface TextContent     { type: "text"; text: string; textSignature?: string; }
interface ThinkingContent  { type: "thinking"; thinking: string; thinkingSignature?: string; redacted?: boolean; }
interface ImageContent     { type: "image"; data: string; mimeType: string; }

interface ToolCall {
    type: "toolCall";
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;
}
```

这四种 content 类型是消息内容的基础构建块：

| 类型 | 出现在 | 说明 |
|------|--------|------|
| `TextContent` | `UserMessage.content`、`AssistantMessage.content`、`ToolResultMessage.content` | LLM 的文本输出 |
| `ThinkingContent` | `AssistantMessage.content` | 推理模型的"思考"过程，`redacted` 表示被安全过滤器隐藏 |
| `ImageContent` | `UserMessage.content`、`ToolResultMessage.content` | Base64 编码的图片 |
| `ToolCall` | `AssistantMessage.content` | LLM 请求调用的工具，包含工具名和参数 |

**消费关系**：`TextContent` 和 `ImageContent` 是全系统最广泛使用的类型。`ToolCall` 在 `agent-loop.ts` 中被提取并路由到对应的 `AgentTool.execute()`。

**字面量例子**：

```typescript
const text: TextContent = { type: "text", text: "Hello, how can I help you today?" };

const thinking: ThinkingContent = {
    type: "thinking",
    thinking: "The user is asking about file editing. I should use the edit tool...",
    thinkingSignature: "sig_abc123",
};

const image: ImageContent = {
    type: "image",
    data: "iVBORw0KGgoAAAANSUhEUgAA...",  // base64 编码
    mimeType: "image/png",
};

const toolCall: ToolCall = {
    type: "toolCall",
    id: "toolu_01XFDUDYJgAACzvnptvVer6z",
    name: "edit",
    arguments: {
        path: "src/index.ts",
        edits: [{ oldText: "console.log", newText: "logger.info" }],
    },
};
```

### 1.6 Usage — Token 使用统计

```typescript
interface Usage {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        total: number;
    };
}
```

每次 LLM 调用后的 token 统计和费用计算。`cost` 字段基于 `Model.cost` 中定义的单价自动计算。

**消费关系**：附在 `AssistantMessage.usage` 上，被 coding-agent 的 footer 组件显示、被 HTML 导出渲染、被测试文件断言。

**字面量例子**：

```typescript
const usage: Usage = {
    input: 1523,
    output: 847,
    cacheRead: 1200,
    cacheWrite: 323,
    totalTokens: 3893,
    cost: {
        input: 0.004569,
        output: 0.012705,
        cacheRead: 0.00036,
        cacheWrite: 0.001211,
        total: 0.018845,
    },
};
```

### 1.7 Message 类型（三种角色）

```typescript
interface UserMessage {
    role: "user";
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
}

interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api;
    provider: Provider;
    model: string;
    responseId?: string;
    usage: Usage;
    stopReason: StopReason;  // "stop" | "length" | "toolUse" | "error" | "aborted"
    errorMessage?: string;
    timestamp: number;
}

interface ToolResultMessage<TDetails = any> {
    role: "toolResult";
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    details?: TDetails;
    isError: boolean;
    timestamp: number;
}

type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

**设计要点**：
- `UserMessage.content` 可以是纯字符串（简单文本）或 content 块数组（包含图片时）。
- `AssistantMessage` 记录了完整的元信息：使用了哪个 API、哪个 provider、哪个模型、token 用量、停止原因。`stopReason` 是循环引擎决定"是否继续"的关键信号。
- `ToolResultMessage` 的 `details` 是泛型的 — 不同工具返回不同结构的详情（如 edit 工具返回 diff，bash 工具返回退出码）。`details` 不发送给 LLM，只用于 UI 渲染和日志。

**消费关系**：`Message` 是 `Context.messages` 的元素类型。`agent/src/types.ts` 用 `Message` 构造了 `AgentMessage` 联合类型。`session-manager.ts` 的 `SessionMessageEntry.message` 字段存储的就是 `AgentMessage`（包含 `Message`）。

**字面量例子**：

```typescript
// UserMessage — 简单文本
const userMsg: UserMessage = {
    role: "user",
    content: "请帮我重构这个函数",
    timestamp: 1718500000000,
};

// UserMessage — 包含图片
const userMsgWithImage: UserMessage = {
    role: "user",
    content: [
        { type: "text", text: "这个截图里的 bug 是什么？" },
        { type: "image", data: "iVBORw0KGgo...", mimeType: "image/png" },
    ],
    timestamp: 1718500001000,
};

// AssistantMessage
const assistantMsg: AssistantMessage = {
    role: "assistant",
    content: [
        { type: "thinking", thinking: "I need to read the file first..." },
        { type: "text", text: "I'll edit the file for you." },
        {
            type: "toolCall", id: "toolu_01abc", name: "edit",
            arguments: { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
        },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
    responseId: "msg_01XYZ",
    usage: {
        input: 1523, output: 847, cacheRead: 0, cacheWrite: 0, totalTokens: 2370,
        cost: { input: 0.004569, output: 0.012705, cacheRead: 0, cacheWrite: 0, total: 0.017274 },
    },
    stopReason: "toolUse",
    timestamp: 1718500002000,
};

// ToolResultMessage
const toolResult: ToolResultMessage<{ diff: string; firstChangedLine: number }> = {
    role: "toolResult",
    toolCallId: "toolu_01abc",
    toolName: "edit",
    content: [{ type: "text", text: "Successfully edited src/index.ts" }],
    details: { diff: "- foo\n+ bar", firstChangedLine: 42 },
    isError: false,
    timestamp: 1718500003000,
};
```

### 1.8 Tool — LLM 可见的工具定义

```typescript
interface Tool<TParameters extends TSchema = TSchema> {
    name: string;
    description: string;
    parameters: TParameters;
}
```

这是发送给 LLM 的工具 schema — 只有名称、描述、参数定义，没有执行逻辑。参数使用 `@sinclair/typebox` 的 `TSchema`，在运行时可做 JSON Schema 验证。

**消费关系**：`AgentTool` 继承自 `Tool`，加上了 `execute`、`label`、`prepareArguments` 等执行侧字段。`Context.tools` 是 `Tool[]`。

**字面量例子**：

```typescript
import { Type } from "@sinclair/typebox";

const tool: Tool = {
    name: "grep",
    description: "Search file contents using a regex pattern",
    parameters: Type.Object({
        pattern: Type.String({ description: "Regex pattern" }),
        path: Type.Optional(Type.String({ description: "Directory to search in" })),
    }),
};
```

### 1.9 Context — 发送给 LLM 的完整上下文

```typescript
interface Context {
    systemPrompt?: string;
    messages: Message[];
    tools?: Tool[];
}
```

只有三个字段 — 这就是 LLM 调用的全部输入。简单是因为复杂性被推到了各个 provider 的实现中（每个 provider 负责把 `Context` 转换成自己的 API 格式）。

**消费关系**：在 `agent-loop.ts` 的 `streamAssistantResponse()` 中构造，传入 `streamSimple()` 或自定义流函数。

**字面量例子**：

```typescript
const context: Context = {
    systemPrompt: "You are a helpful coding assistant.",
    messages: [
        { role: "user", content: "What files are in src/?", timestamp: 1718500000000 },
    ],
    tools: [tool],
};
```

### 1.10 AssistantMessageEvent — 流式事件协议

```typescript
type AssistantMessageEvent =
    | { type: "start"; partial: AssistantMessage }
    | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "thinking_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
    | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
    | { type: "toolcall_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
    | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
    | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
    | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

这是 pi-ai 层与上层通信的事件协议。注意每个事件都携带 `partial: AssistantMessage` — 这是**累积构建**的消息快照，上层可以直接使用而不需要自己拼接 delta。

流的生命周期：`start` → 若干 `*_start` / `*_delta` / `*_end` → 最终 `done` 或 `error`。

**消费关系**：`agent-loop.ts` 的 `streamAssistantResponse()` 消费这些事件，把它们包装成 `AgentEvent.message_update`。`AgentEvent.message_update.assistantMessageEvent` 字段就是这个类型。

**字面量例子**（几个代表性变体）：

```typescript
// 流开始
{ type: "start", partial: assistantMsg }

// 文本增量
{ type: "text_delta", contentIndex: 0, delta: "I'll help", partial: assistantMsg }

// 工具调用结束
{
    type: "toolcall_end", contentIndex: 1,
    toolCall: { type: "toolCall", id: "toolu_01abc", name: "edit", arguments: { path: "src/index.ts", edits: [] } },
    partial: assistantMsg,
}

// 成功结束
{ type: "done", reason: "stop", message: assistantMsg }

// 错误结束
{ type: "error", reason: "aborted", error: { ...assistantMsg, stopReason: "aborted", errorMessage: "User cancelled" } }
```

### 1.11 Model — 模型的完整元数据

```typescript
interface Model<TApi extends Api> {
    id: string;
    name: string;
    api: TApi;
    provider: Provider;
    baseUrl: string;
    reasoning: boolean;
    input: ("text" | "image")[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    headers?: Record<string, string>;
    compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
           : TApi extends "openai-responses" ? OpenAIResponsesCompat
           : never;
}
```

| 字段 | 说明 |
|------|------|
| `id` | 模型 ID，如 `"claude-sonnet-4-20250514"` |
| `name` | 显示名称，如 `"Claude 4 Sonnet"` |
| `api` | 使用的 API 协议，决定走哪个 provider 实现 |
| `provider` | 提供商名称，用于密钥解析 |
| `baseUrl` | API 端点 URL |
| `reasoning` | 是否支持扩展思考 |
| `input` | 支持的输入类型（文本/图片） |
| `cost` | 每百万 token 的价格（美元），用于实时费用计算 |
| `contextWindow` | 上下文窗口大小（token） |
| `maxTokens` | 最大输出 token 数 |
| `headers` | 自定义请求头 |
| `compat` | OpenAI 兼容 API 的特殊配置 |

泛型 `TApi` 的设计意图：`compat` 字段的类型根据 `api` 的值条件推导。当 `api` 是 `"openai-completions"` 时 `compat` 可以是 `OpenAICompletionsCompat`；其他 API 则为 `never`。

**消费关系**：`Model` 是整个系统中传递最广的类型之一。`AgentLoopConfig.model`、`AgentState.model`、`ExtensionContext.model`、`ModelSelectEvent.model` 都是它。

**字面量例子**：

```typescript
const model: Model<"anthropic-messages"> = {
    id: "claude-sonnet-4-20250514",
    name: "Claude 4 Sonnet",
    api: "anthropic-messages",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 16384,
};
```

### 1.12 OpenAICompletionsCompat — 兼容性配置

这是一个大约 30 个字段的接口，用于处理各种 OpenAI 兼容 API 的差异：`supportsStore`、`supportsDeveloperRole`、`supportsReasoningEffort`、`thinkingFormat`、`openRouterRouting` 等。大部分字段有从 `baseUrl` 自动检测的默认值。

**消费关系**：仅被 OpenAI completions provider 实现消费，存储在 `Model.compat` 上。

**字面量例子**：

```typescript
const compat: OpenAICompletionsCompat = {
    supportsStore: false,
    supportsDeveloperRole: true,
    supportsReasoningEffort: false,
    supportsUsageInStreaming: true,
    maxTokensField: "max_completion_tokens",
    requiresToolResultName: false,
    requiresThinkingAsText: true,
    thinkingFormat: "openai",
    supportsStrictMode: true,
};
```

### 1.13 阅读建议

读完 `types.ts` 后你应该能回答：
- LLM 调用的输入是什么形状？（`Context`）
- LLM 的响应流产出什么事件？（`AssistantMessageEvent`）
- 一个模型的完整描述包含哪些信息？（`Model`）
- 系统中有几种消息角色？每种包含什么内容？（`UserMessage` / `AssistantMessage` / `ToolResultMessage`）

---

## 2. `packages/ai/src/api-registry.ts`

**文件概览**：99 行。这是整个系统的 LLM 调用多态性基础 — 一个极简的 provider 注册表。你会看到一个 `Map`、两个注册函数、两个查询函数、一个清理函数。就这些。

### 2.1 类型定义

```typescript
type ApiStreamFunction = (model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream;
type ApiStreamSimpleFunction = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;

interface ApiProvider<TApi extends Api, TOptions extends StreamOptions> {
    api: TApi;
    stream: StreamFunction<TApi, TOptions>;
    streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
```

`ApiProvider` 是 provider 需要实现的接口。每个 provider 提供：
- `api`：标识自己处理哪种 API（如 `"anthropic-messages"`）
- `stream`：接受 provider 特有选项的流函数
- `streamSimple`：接受统一的 `SimpleStreamOptions` 的流函数（上层代码主要使用这个）

内部还有一个 `ApiProviderInternal` 接口，把泛型擦除为 `Api`，方便存储在 `Map` 中。

**字面量例子**：

```typescript
const anthropicProvider: ApiProvider<"anthropic-messages", AnthropicOptions> = {
    api: "anthropic-messages",
    stream: (model, context, options?) => { /* 返回 AssistantMessageEventStream */ },
    streamSimple: (model, context, options?) => { /* 返回 AssistantMessageEventStream */ },
};
```

### 2.2 注册表核心

```typescript
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();
```

一个模块级的 `Map`，键是 `api` 字符串（如 `"anthropic-messages"`），值是包装后的 provider。整个系统的 LLM 调用路由就建立在这个 Map 之上。

### 2.3 函数一览

| 函数 | 签名 | 说明 |
|------|------|------|
| `registerApiProvider` | `(provider, sourceId?) => void` | 注册一个 provider。`sourceId` 用于批量注销 |
| `getApiProvider` | `(api) => ApiProviderInternal \| undefined` | 根据 `model.api` 取出对应 provider |
| `getApiProviders` | `() => ApiProviderInternal[]` | 返回所有已注册 provider |
| `unregisterApiProviders` | `(sourceId) => void` | 按 `sourceId` 批量注销（用于清理 faux/测试 provider） |
| `clearApiProviders` | `() => void` | 清空注册表 |

内部还有两个 `wrap` 函数（`wrapStream`、`wrapStreamSimple`），它们在注册时做类型安全检查：如果 `model.api` 与注册的 `api` 不匹配，抛出错误。

### 2.4 消费关系

- **注册端**：`packages/ai/src/providers/register-builtins.ts` 调用 `registerApiProvider` 约 10 次，注册所有内置 provider（Anthropic、OpenAI Responses、OpenAI Completions、Google、Bedrock、Mistral 等）。`packages/ai/src/providers/faux.ts` 注册测试用的模拟 provider。`packages/coding-agent/src/core/model-registry.ts` 中的 `registerProvider` 也会调用它来注册自定义 provider。
- **查询端**：`packages/ai/src/stream.ts` 的 `resolveApiProvider()` 调用 `getApiProvider(model.api)` 获取对应实现。

### 2.5 阅读建议

读完 `api-registry.ts` 后你应该能回答：
- 添加一个新的 LLM provider 需要提供什么？（实现 `ApiProvider` 接口）
- LLM 调用是怎么路由到正确 provider 的？（按 `model.api` 查 Map）
- 为什么注册表这么简单就够了？（因为所有差异都被推到各 provider 内部处理）

---

## 3. `packages/ai/src/stream.ts`

**文件概览**：59 行。pi-ai 层的公共 API 入口。你会看到四个函数 — 两对"流式 + 完成"变体。这个文件的存在意义是：**给上层代码一个不需要关心 provider 注册细节的调用接口**。

### 3.1 副作用导入

```typescript
import "./providers/register-builtins.js";
```

第一行就是一个副作用导入 — 确保所有内置 provider 在首次使用 `stream` 模块时已注册。这意味着只要你 `import { stream } from "@mariozechner/pi-ai"`，所有 10+ 个 provider 就已经就绪了。

### 3.2 函数一览

| 函数 | 返回类型 | 说明 |
|------|----------|------|
| `stream(model, context, options?)` | `AssistantMessageEventStream` | 使用 provider 原生选项的流式调用 |
| `complete(model, context, options?)` | `Promise<AssistantMessage>` | `stream` 的便捷包装 — 等待流结束，返回最终消息 |
| `streamSimple(model, context, options?)` | `AssistantMessageEventStream` | 使用统一的 `SimpleStreamOptions` 的流式调用 |
| `completeSimple(model, context, options?)` | `Promise<AssistantMessage>` | `streamSimple` 的便捷包装 |

所有函数的内部逻辑相同：
1. 调用 `resolveApiProvider(model.api)` 从注册表获取 provider
2. 调用 provider 的 `stream` 或 `streamSimple` 方法
3. 返回结果（或 `await` 其 `.result()`）

`resolveApiProvider` 是一个 3 行的内部函数：查注册表，没找到就抛错。

**字面量例子**（四个函数的使用形式）：

```typescript
import { streamSimple, completeSimple } from "@mariozechner/pi-ai";

// 流式调用
const eventStream = streamSimple(model, context, { reasoning: "high" });
for await (const event of eventStream) {
    if (event.type === "text_delta") console.log(event.delta);
}

// 一次性调用（等待流结束，返回最终消息）
const message = await completeSimple(model, context, { temperature: 0.5 });
console.log(message.content);
```

### 3.3 消费关系

- **`streamSimple` 是被消费最多的函数**：
  - `packages/agent/src/types.ts` — 用 `typeof streamSimple` 的参数和返回类型定义了 `StreamFn` 类型
  - `packages/agent/src/agent.ts` — 作为 `Agent` 类的默认流函数：`this.streamFn = options.streamFn ?? streamSimple`
  - `packages/agent/src/agent-loop.ts` — 在 `streamAssistantResponse()` 中作为后备：`const streamFunction = streamFn || streamSimple`
  - `packages/coding-agent/src/core/sdk.ts` — 在 `createAgentSession` 中直接调用
- **`complete` / `completeSimple`** 被 coding-agent 的压缩模块和某些扩展使用（如 `summarize.ts`、`qna.ts`）

### 3.4 阅读建议

读完 `stream.ts` 后你应该能回答：
- 调用 LLM 的最短路径是什么？（`streamSimple(model, context)` 或 `completeSimple(model, context)`）
- `stream` 和 `streamSimple` 的区别是什么？（选项类型不同 — 前者允许 provider 特有选项）
- agent-core 使用的是哪个入口？（`streamSimple`）

---

# 第二部分：pi-agent-core 层（循环引擎）

pi-agent-core 在 pi-ai 之上搭建了"agent 循环"的概念：给一个提示，LLM 回复，如果有工具调用就执行，把结果放回上下文，继续循环直到 LLM 不再调用工具。这三个文件定义了这个循环的类型系统、实现和有状态包装。

---

## 4. `packages/agent/src/types.ts`

**文件概览**：约 370 行。这是整个 agent 系统的 "schema"。你会在这里找到：循环引擎使用的流函数签名、工具执行模式、循环配置、自定义消息机制、agent 状态、工具定义、事件流。信息密度极高。

### 4.1 StreamFn — agent 层的流函数类型

```typescript
type StreamFn = (
    ...args: Parameters<typeof streamSimple>
) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;
```

注意和 pi-ai 层的 `StreamFunction` 的区别：`StreamFn` 允许返回 `Promise` — 这是因为某些场景下（如代理模式）需要异步创建流。

**消费关系**：`Agent` 类的 `streamFn` 属性类型是 `StreamFn`。`agent-loop.ts` 中 `streamAssistantResponse()` 接受可选的 `StreamFn` 参数。

**字面量例子**：

```typescript
const myStreamFn: StreamFn = async (model, context, options?) => {
    const proxyUrl = await resolveProxyUrl();
    return streamSimple({ ...model, baseUrl: proxyUrl }, context, options);
};
```

### 4.2 ToolExecutionMode

```typescript
type ToolExecutionMode = "sequential" | "parallel";
```

- `"sequential"`：工具调用一个接一个执行（prepare → execute → finalize）
- `"parallel"`：工具调用先依次 prepare（检查参数、调用 `beforeToolCall`），然后允许的工具并发执行，最终结果按原始顺序返回

**消费关系**：`AgentLoopConfig.toolExecution` 字段。`Agent` 类默认值为 `"parallel"`。

### 4.3 BeforeToolCall / AfterToolCall 钩子

```typescript
interface BeforeToolCallResult { block?: boolean; reason?: string; }
interface AfterToolCallResult { content?: (TextContent | ImageContent)[]; details?: unknown; isError?: boolean; }

interface BeforeToolCallContext {
    assistantMessage: AssistantMessage;
    toolCall: AgentToolCall;
    args: unknown;
    context: AgentContext;
}

interface AfterToolCallContext extends BeforeToolCallContext {
    result: AgentToolResult<any>;
    isError: boolean;
}
```

这是工具执行的拦截机制：
- `beforeToolCall`：在工具执行前调用。返回 `{ block: true }` 可以阻止执行（比如需要用户确认时）。
- `afterToolCall`：在工具执行后调用。可以修改返回给 LLM 的内容（比如截断过长的输出）。

**消费关系**：`AgentLoopConfig.beforeToolCall` 和 `afterToolCall`。在 coding-agent 的 `AgentSession._installAgentToolHooks()` 中设置，用于触发 extension 的 `tool_call` 和 `tool_result` 事件。

**字面量例子**：

```typescript
// BeforeToolCallResult — 阻止执行
const blocked: BeforeToolCallResult = { block: true, reason: "User denied bash execution" };

// AfterToolCallResult — 修改输出
const override: AfterToolCallResult = {
    content: [{ type: "text", text: "[output truncated to 500 chars]..." }],
};

// BeforeToolCallContext
const beforeCtx: BeforeToolCallContext = {
    assistantMessage: assistantMsg,
    toolCall: { type: "toolCall", id: "toolu_01abc", name: "bash", arguments: { command: "rm -rf /tmp/test" } },
    args: { command: "rm -rf /tmp/test" },
    context: { systemPrompt: "You are a coding assistant.", messages: [], tools: [] },
};

// AfterToolCallContext — 继承 BeforeToolCallContext，多了 result 和 isError
const afterCtx: AfterToolCallContext = {
    ...beforeCtx,
    result: { content: [{ type: "text", text: "file contents..." }], details: { lineCount: 42 } },
    isError: false,
};
```

### 4.4 AgentLoopConfig — 循环引擎的完整配置

```typescript
interface AgentLoopConfig extends SimpleStreamOptions {
    model: Model<any>;
    convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    transformContext?: (messages: AgentMessage[], signal?) => Promise<AgentMessage[]>;
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    getSteeringMessages?: () => Promise<AgentMessage[]>;
    getFollowUpMessages?: () => Promise<AgentMessage[]>;
    toolExecution?: ToolExecutionMode;
    beforeToolCall?: ...;
    afterToolCall?: ...;
}
```

| 字段 | 说明 |
|------|------|
| `model` | 当前使用的模型 |
| `convertToLlm` | **关键回调**：把 `AgentMessage[]` 转换成 LLM 能理解的 `Message[]`。自定义消息在这里被过滤或转换 |
| `transformContext` | 上下文变换（在 `convertToLlm` 之前执行），用于上下文窗口管理、注入外部信息 |
| `getApiKey` | 动态获取 API key（适用于可能过期的 OAuth token） |
| `getSteeringMessages` | 获取"转向消息" — 在当前 assistant turn 完成后、下一次 LLM 调用前注入 |
| `getFollowUpMessages` | 获取"跟进消息" — 在 agent 本应停止时注入，使其继续运行 |
| `toolExecution` | 工具执行模式 |
| `beforeToolCall` / `afterToolCall` | 工具拦截钩子 |

**设计要点**：`AgentLoopConfig` 继承自 `SimpleStreamOptions`，意味着循环配置天然携带流式调用的所有选项（`temperature`、`reasoning`、`maxTokens` 等）。

**消费关系**：`Agent` 类在 `createLoopConfig()` 方法中构造此配置，把自身状态（model、queues、callbacks）映射到这些字段上。

**字面量例子**：

```typescript
const loopConfig: AgentLoopConfig = {
    // 继承自 SimpleStreamOptions
    temperature: 0.5,
    reasoning: "medium",
    maxTokens: 16384,
    // AgentLoopConfig 自有字段
    model: model,
    convertToLlm: (messages) => messages.filter((m) => "role" in m) as Message[],
    transformContext: async (messages) => messages.slice(-50),
    getApiKey: async (provider) => process.env[`${provider.toUpperCase()}_API_KEY`],
    getSteeringMessages: async () => [],
    getFollowUpMessages: async () => [],
    toolExecution: "parallel",
    beforeToolCall: async (ctx) => undefined,
    afterToolCall: async (ctx) => undefined,
};
```

### 4.5 CustomAgentMessages 与 AgentMessage

```typescript
interface CustomAgentMessages {
    // 空接口 — 通过声明合并扩展
}

type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

这是 pi 的自定义消息机制。应用可以通过 TypeScript 的声明合并向 `CustomAgentMessages` 添加新的消息类型：

```typescript
declare module "@mariozechner/agent" {
    interface CustomAgentMessages {
        custom: CustomMessage;
    }
}
```

之后 `AgentMessage` 联合类型自动包含 `CustomMessage`，整个系统都能类型安全地处理它。

**消费关系**：coding-agent 的 `messages.ts` 定义了 `CustomMessage` 和 `BashExecutionMessage` 并通过声明合并注册。`session-manager.ts` 中 `SessionMessageEntry.message` 的类型就是 `AgentMessage`。

### 4.6 AgentState — 公共状态接口

```typescript
interface AgentState {
    systemPrompt: string;
    model: Model<any>;
    thinkingLevel: ThinkingLevel;  // "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
    set tools(tools: AgentTool<any>[]);
    get tools(): AgentTool<any>[];
    set messages(messages: AgentMessage[]);
    get messages(): AgentMessage[];
    readonly isStreaming: boolean;
    readonly streamingMessage?: AgentMessage;
    readonly pendingToolCalls: ReadonlySet<string>;
    readonly errorMessage?: string;
}
```

注意 `tools` 和 `messages` 使用 getter/setter — 赋值时会复制数组（防止外部直接修改内部引用）。

**消费关系**：`Agent.state` 返回此接口。coding-agent 的 `AgentSession` 通过 `agent.state` 读写系统提示、模型、工具列表、消息历史。HTML 导出模块也使用 `AgentState` 获取当前状态快照。

**字面量例子**（`AgentState` 是有 getter/setter 的接口，展示其属性的实际值）：

```typescript
agent.state.systemPrompt;      // "You are pi, a coding assistant..."
agent.state.model;             // { id: "claude-sonnet-4-20250514", api: "anthropic-messages", ... }
agent.state.thinkingLevel;     // "medium"
agent.state.tools;             // [editTool, bashTool, readTool, ...]
agent.state.messages;          // [UserMessage, AssistantMessage, ToolResultMessage, ...]
agent.state.isStreaming;       // true
agent.state.pendingToolCalls;  // Set { "toolu_01abc", "toolu_02def" }
agent.state.errorMessage;      // undefined 或 "Rate limit exceeded"
```

### 4.7 AgentToolResult / AgentTool — 工具的定义和结果

```typescript
interface AgentToolResult<T> {
    content: (TextContent | ImageContent)[];
    details: T;
}

type AgentToolUpdateCallback<T = any> = (partialResult: AgentToolResult<T>) => void;

interface AgentTool<TParameters extends TSchema, TDetails = any> extends Tool<TParameters> {
    label: string;
    prepareArguments?: (args: unknown) => Static<TParameters>;
    execute: (
        toolCallId: string,
        params: Static<TParameters>,
        signal?: AbortSignal,
        onUpdate?: AgentToolUpdateCallback<TDetails>,
    ) => Promise<AgentToolResult<TDetails>>;
}
```

`AgentTool` 继承了 pi-ai 层的 `Tool`（name、description、parameters），加上了：

| 字段 | 说明 |
|------|------|
| `label` | UI 显示用的标签 |
| `prepareArguments` | 参数预处理（在 schema 验证之前），用于向后兼容旧的参数格式 |
| `execute` | 执行函数。接收 `toolCallId`（与 `ToolCall.id` 对应）、验证后的参数、abort signal、进度回调 |

**消费关系**：这是 coding-agent 中所有工具文件实现的接口 — `edit.ts`、`bash.ts`、`write.ts`、`read.ts`、`grep.ts`、`find.ts`、`ls.ts` 都返回 `AgentTool`。`ToolDefinition`（extension 层的工具定义）通过 `tool-definition-wrapper.ts` 的 `wrapToolDefinition()` 被转换成 `AgentTool`。

**字面量例子**：

```typescript
// AgentToolResult
const editResult: AgentToolResult<{ diff: string; firstChangedLine: number }> = {
    content: [{ type: "text", text: "Successfully edited src/index.ts" }],
    details: { diff: "- foo\n+ bar", firstChangedLine: 42 },
};

// AgentTool（继承 Tool，加上 label / execute）
const readTool: AgentTool = {
    name: "read",
    description: "Read a file",
    parameters: Type.Object({
        path: Type.String({ description: "File path" }),
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
    }),
    label: "read",
    execute: async (toolCallId, params, signal, onUpdate) => {
        const content = await readFile(params.path, "utf-8");
        return {
            content: [{ type: "text", text: content }],
            details: { lineCount: content.split("\n").length },
        };
    },
};
```

### 4.8 AgentContext — 循环引擎的输入快照

```typescript
interface AgentContext {
    systemPrompt: string;
    messages: AgentMessage[];
    tools?: AgentTool<any>[];
}
```

与 pi-ai 层的 `Context` 相比：消息类型从 `Message[]` 变成了 `AgentMessage[]`，工具类型从 `Tool[]` 变成了 `AgentTool[]`。`convertToLlm` 回调负责在 LLM 调用前做 `AgentMessage[] → Message[]` 的转换。

**字面量例子**：

```typescript
const agentCtx: AgentContext = {
    systemPrompt: "You are a helpful coding assistant.",
    messages: [
        { role: "user", content: "Fix the bug in main.ts", timestamp: 1718500000000 },
    ],
    tools: [readTool, editTool],
};
```

### 4.9 AgentEvent — 生命周期事件流

```typescript
type AgentEvent =
    | { type: "agent_start" }
    | { type: "agent_end"; messages: AgentMessage[] }
    | { type: "turn_start" }
    | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
    | { type: "message_start"; message: AgentMessage }
    | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
    | { type: "message_end"; message: AgentMessage }
    | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
    | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
    | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

三个层级的事件：
1. **Agent 生命周期**：`agent_start` → ... → `agent_end`
2. **Turn 生命周期**：`turn_start` → ... → `turn_end`（一个 turn = 一次 assistant 响应 + 工具调用/结果）
3. **消息/工具生命周期**：`message_start/update/end`、`tool_execution_start/update/end`

注意 `message_update` 桥接了 pi-ai 层的 `AssistantMessageEvent` — 上层可以通过这个事件拿到 token 级的流式更新。

**消费关系**：`Agent.subscribe()` 的监听器接收 `AgentEvent`。coding-agent 的 `AgentSession._handleAgentEvent()` 是最核心的消费者 — 它把 `AgentEvent` 转化为 session 级的状态更新和 extension 事件。

**字面量例子**（各层级代表性事件）：

```typescript
{ type: "agent_start" }

{ type: "turn_start" }

{ type: "message_start", message: assistantMsg }

{
    type: "message_update", message: assistantMsg,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Let me", partial: assistantMsg },
}

{
    type: "tool_execution_start",
    toolCallId: "toolu_01abc", toolName: "edit",
    args: { path: "src/index.ts", edits: [] },
}

{
    type: "tool_execution_end",
    toolCallId: "toolu_01abc", toolName: "edit",
    result: { diff: "- old\n+ new", firstChangedLine: 10 },
    isError: false,
}

{ type: "turn_end", message: assistantMsg, toolResults: [toolResult] }

{ type: "agent_end", messages: [/* 本次运行新增的所有消息 */] }
```

### 4.10 阅读建议

读完 `agent/src/types.ts` 后你应该能回答：
- 循环引擎的配置项有哪些？各自的作用是什么？（`AgentLoopConfig`）
- agent 工具和 pi-ai 层工具的区别是什么？（`AgentTool` vs `Tool`）
- 怎么给 agent 添加自定义消息类型？（`CustomAgentMessages` 声明合并）
- 事件流的层级结构是什么？（agent → turn → message/tool）

---

## 5. `packages/agent/src/agent-loop.ts`

**文件概览**：约 630 行。循环引擎的完整实现。你会看到两个公共入口（`agentLoop` / `agentLoopContinue`）、一个核心循环（`runLoop`）、LLM 调用逻辑（`streamAssistantResponse`）和工具执行逻辑（sequential / parallel 两种模式）。

### 5.1 公共入口

```typescript
function agentLoop(prompts, context, config, signal?, streamFn?): EventStream<AgentEvent, AgentMessage[]>;
function agentLoopContinue(context, config, signal?, streamFn?): EventStream<AgentEvent, AgentMessage[]>;
```

- `agentLoop`：以新的 prompt 消息启动循环。prompt 被加入 context 并触发事件。
- `agentLoopContinue`：从已有 context 继续（用于重试 — context 中已有 user 消息或 tool result）。

两者都返回 `EventStream<AgentEvent, AgentMessage[]>` — 一个异步可迭代的事件流，最终结果是新增的消息列表。

还有对应的 `runAgentLoop` / `runAgentLoopContinue` — 不返回 EventStream，而是接受一个 `emit` 回调。`Agent` 类直接使用这两个函数。

### 5.2 核心循环 — `runLoop`

```typescript
async function runLoop(currentContext, newMessages, config, signal, emit, streamFn?): Promise<void>
```

双层循环结构：

**外层循环**：处理 follow-up 消息。当内层循环结束（agent 本应停止）时，检查 `config.getFollowUpMessages()`。如果有消息，把它们设为 pending 并继续外层循环。

**内层循环**：处理 tool calls 和 steering 消息。每次迭代：
1. 处理 pending 消息（注入到 context）
2. 调用 `streamAssistantResponse()` 获取 LLM 响应
3. 如果响应是 error/aborted，发射 `turn_end` + `agent_end`，返回
4. 提取 tool calls；如果有，执行它们，结果加入 context
5. 发射 `turn_end`
6. 检查 `config.getSteeringMessages()`，如果有，继续循环

**消费关系**：`Agent` 类的 `runPromptMessages()` 和 `runContinuation()` 方法分别调用 `runAgentLoop` 和 `runAgentLoopContinue`。coding-agent 不直接调用这些函数 — 全部通过 `Agent` 类间接使用。

### 5.3 LLM 调用 — `streamAssistantResponse`

```typescript
async function streamAssistantResponse(context, config, signal, emit, streamFn?): Promise<AssistantMessage>
```

这是 `AgentMessage[] → Message[]` 转换发生的地方：

1. 如果配置了 `transformContext`，先在 AgentMessage 层做变换（如裁剪旧消息）
2. 调用 `config.convertToLlm(messages)` 转换为 LLM 兼容的 `Message[]`
3. 构造 `Context` 对象（systemPrompt + messages + tools）
4. 解析 API key（`config.getApiKey` 或 `config.apiKey`）
5. 调用 `streamFunction(model, llmContext, options)` — 默认是 `streamSimple`
6. 迭代流事件，维护 `partialMessage`，发射对应的 `AgentEvent`
7. 返回最终的 `AssistantMessage`

### 5.4 工具执行

`executeToolCalls` 根据 `config.toolExecution` 分发到两个实现：

**Sequential 模式**：逐个处理 —— prepare → execute → finalize。

**Parallel 模式**：
1. 依次 prepare 所有 tool calls（因为 `beforeToolCall` 可能需要顺序执行，如用户确认）
2. 可执行的调用并发启动
3. 按原始顺序 await 结果
4. 依次 finalize

工具执行的生命周期：
```
prepareToolCall() → {prepared | immediate}
    → executePreparedToolCall() → {result, isError}
        → finalizeExecutedToolCall() → ToolResultMessage
```

`prepareToolCall` 查找工具、调用 `prepareArguments`、验证参数、调用 `beforeToolCall`。任一步骤失败都返回 `immediate` 结果（错误消息）。

### 5.5 阅读建议

读完 `agent-loop.ts` 后你应该能回答：
- 循环在什么条件下终止？（无 tool calls + 无 steering messages + 无 follow-up messages，或 error/aborted）
- `AgentMessage[]` 在什么时候转换成 `Message[]`？（`streamAssistantResponse` 的第 2 步）
- parallel 工具执行为什么还要顺序 prepare？（`beforeToolCall` 可能有副作用，如弹出确认对话框）
- steering 和 follow-up 消息的区别是什么？（steering 在 turn 间注入，follow-up 在 agent 停止前注入）

---

## 6. `packages/agent/src/agent.ts`

**文件概览**：约 540 行。`Agent` 类 — `agentLoop` 的有状态包装器。你会看到状态管理、事件订阅、消息队列（steering / follow-up）、生命周期控制。

### 6.1 AgentOptions — 构造选项

```typescript
interface AgentOptions {
    initialState?: Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
    convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    transformContext?: (messages: AgentMessage[], signal?) => Promise<AgentMessage[]>;
    streamFn?: StreamFn;
    getApiKey?: (provider: string) => ...;
    onPayload?: SimpleStreamOptions["onPayload"];
    beforeToolCall?: ...;
    afterToolCall?: ...;
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    sessionId?: string;
    thinkingBudgets?: ThinkingBudgets;
    transport?: Transport;
    maxRetryDelayMs?: number;
    toolExecution?: ToolExecutionMode;
}
```

大部分字段对应 `AgentLoopConfig` 的配置项。额外的：
- `initialState`：初始化状态（system prompt、model、tools、messages 等）
- `steeringMode` / `followUpMode`：控制消息队列的排空方式 — `"all"` 一次排空所有，`"one-at-a-time"` 每次只取一条

**字面量例子**：

```typescript
const agentOptions: AgentOptions = {
    initialState: {
        systemPrompt: "You are pi, a coding assistant.",
        model: model,
        thinkingLevel: "medium",
        tools: [editTool, bashTool],
        messages: [],
    },
    convertToLlm: (messages) => messages.filter((m) => "role" in m) as Message[],
    streamFn: streamSimple,
    getApiKey: async (provider) => process.env.ANTHROPIC_API_KEY,
    steeringMode: "all",
    followUpMode: "one-at-a-time",
    sessionId: "sess_xyz",
    thinkingBudgets: { medium: 10240, high: 32768 },
    transport: "sse",
    maxRetryDelayMs: 60000,
    toolExecution: "parallel",
};
```

### 6.2 Agent 类核心

```typescript
class Agent {
    private _state: MutableAgentState;
    private readonly listeners: Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>;
    private readonly steeringQueue: PendingMessageQueue;
    private readonly followUpQueue: PendingMessageQueue;
    private activeRun?: ActiveRun;
    // 公共属性：convertToLlm, transformContext, streamFn, getApiKey, ...
}
```

**关键方法**：

| 方法 | 说明 |
|------|------|
| `prompt(message)` | 发起新的对话轮次。消息可以是字符串、单条消息或消息数组 |
| `continue()` | 从当前上下文继续（用于重试或注入消息后继续） |
| `steer(message)` | 向 steering 队列添加消息（在当前 turn 结束后注入） |
| `followUp(message)` | 向 follow-up 队列添加消息（在 agent 停止前注入） |
| `abort()` | 中止当前运行 |
| `waitForIdle()` | 等待当前运行和所有 listener 完成 |
| `subscribe(listener)` | 订阅 `AgentEvent`，返回取消订阅函数 |
| `reset()` | 清空消息、状态和队列 |
| `state` (getter) | 返回 `AgentState` |

### 6.3 内部流程

`prompt()` → `runPromptMessages()` → `runWithLifecycle()` → `runAgentLoop()`

`runWithLifecycle()` 管理运行的生命周期：
1. 创建 `AbortController` 和 `Promise`
2. 设置 `isStreaming = true`
3. 执行器函数（调用 `runAgentLoop` 或 `runAgentLoopContinue`）
4. 如果执行器抛出，调用 `handleRunFailure()`（生成错误消息）
5. `finally` 中调用 `finishRun()`（清理状态）

`processEvents()` 是事件总线 — 每个 `AgentEvent` 先更新内部状态，然后分发给所有 listener。

`createLoopConfig()` 把 Agent 的属性映射到 `AgentLoopConfig`，特别是把 steering/follow-up 队列的 `drain()` 方法包装成 `getSteeringMessages` / `getFollowUpMessages` 回调。

### 6.4 PendingMessageQueue

```typescript
class PendingMessageQueue {
    constructor(public mode: "all" | "one-at-a-time");
    enqueue(message: AgentMessage): void;
    hasItems(): boolean;
    drain(): AgentMessage[];
    clear(): void;
}
```

`drain()` 的行为取决于 mode：
- `"all"`：返回所有排队消息，清空队列
- `"one-at-a-time"`：只返回第一条，其余保留

**字面量例子**：

```typescript
const queue = new PendingMessageQueue("all");
queue.enqueue({ role: "user", content: "Also fix the tests", timestamp: Date.now() });
queue.enqueue({ role: "user", content: "And update the README", timestamp: Date.now() });
queue.drain(); // mode="all" → 返回两条消息，队列清空
// 如果 mode="one-at-a-time" → 只返回第一条，第二条保留
```

### 6.5 消费关系

- **最核心的消费者**：`packages/coding-agent/src/core/sdk.ts` — `createAgentSession()` 中通过 `new Agent({...})` 实例化。传入 model、tools、流函数、convertToLlm 回调等。
- **测试**：`packages/coding-agent/test/` 下 10+ 个测试文件通过 `new Agent({...})` 创建实例。
- coding-agent 的 `AgentSession` 类持有一个 `Agent` 实例，通过 `agent.subscribe()` 监听事件，通过 `agent.state` 读写状态，通过 `agent.prompt()` / `agent.steer()` / `agent.followUp()` 驱动对话。

### 6.6 阅读建议

读完 `agent.ts` 后你应该能回答：
- 如果循环引擎（agent-loop）是无状态的，状态保存在哪里？（`Agent._state`）
- steering 和 follow-up 消息是怎么进入循环的？（通过 `PendingMessageQueue`，在 `createLoopConfig` 中包装为回调）
- 怎么知道 agent 当前是否在运行？（`state.isStreaming` 或 `activeRun` 是否存在）
- 多个 listener 的执行顺序是什么？（按 `Set` 的插入顺序，依次 await）

---

# 第三部分：pi-coding-agent 层（产品实现）

pi-coding-agent 是 pi 的"产品层" — 它在 agent-core 之上搭建了完整的编码助手：会话持久化、system prompt 动态装配、具体工具实现（edit、bash、read 等）、扩展系统。这四个文件代表了产品层最核心的四个关注点。

---

## 7. `packages/coding-agent/src/core/session-manager.ts`

**文件概览**：约 1420 行。会话的持久化和分支管理。你会看到会话如何被序列化到磁盘（JSONL 文件）、树形结构的 entry 系统、分支和时间旅行、上下文构建。

### 7.1 Session 文件格式

会话存储为 JSONL（每行一个 JSON 对象）。第一行是 `SessionHeader`，后续每行是一个 `SessionEntry`：

```typescript
interface SessionHeader {
    type: "session";
    version?: number;      // 当前是 v3
    id: string;
    timestamp: string;
    cwd: string;
    parentSession?: string; // 指向父会话文件（fork 时设置）
}
```

**字面量例子**：

```typescript
const header: SessionHeader = {
    type: "session",
    version: 3,
    id: "a1b2c3d4",
    timestamp: "2025-06-15T10:30:00.000Z",
    cwd: "/Users/dev/my-project",
    // parentSession: "/path/to/parent-session.jsonl"  // fork 时才有
};
```

### 7.2 Entry 类型体系

所有 entry 都继承 `SessionEntryBase`：

```typescript
interface SessionEntryBase {
    type: string;
    id: string;          // 8 字符短 UUID
    parentId: string | null; // 父 entry 的 id，形成树结构
    timestamp: string;
}
```

共 8 种 entry 类型：

| Entry 类型 | 用途 |
|-----------|------|
| `SessionMessageEntry` | 包含一条 `AgentMessage` |
| `ThinkingLevelChangeEntry` | 记录 thinking level 变化 |
| `ModelChangeEntry` | 记录模型切换（provider + modelId） |
| `CompactionEntry` | 上下文压缩摘要 + 保留的 entry 边界 |
| `BranchSummaryEntry` | 分支时对放弃路径的摘要 |
| `CustomEntry` | 扩展自定义数据（不参与 LLM 上下文） |
| `CustomMessageEntry` | 扩展消息（参与 LLM 上下文，转换为 user message） |
| `LabelEntry` | 用户标签/书签 |
| `SessionInfoEntry` | 会话元信息（如显示名称） |

**设计要点**：session 是 **append-only** 的 — entry 不可修改、不可删除。分支通过改变 `leafId` 指针实现，不修改已有数据。这保证了完整的历史记录和并发安全。

**字面量例子**（各 entry 类型）：

```typescript
// SessionEntryBase（所有 entry 的公共字段）
{ type: "message", id: "e5f6a7b8", parentId: "d4c3b2a1", timestamp: "2025-06-15T10:30:01.000Z" }

// SessionMessageEntry
{
    type: "message", id: "e5f6a7b8", parentId: "d4c3b2a1",
    timestamp: "2025-06-15T10:30:01.000Z",
    message: { role: "user", content: "Fix the bug in main.ts", timestamp: 1718446201000 },
}

// ThinkingLevelChangeEntry
{ type: "thinking_level_change", id: "f1e2d3c4", parentId: "e5f6a7b8",
  timestamp: "2025-06-15T10:31:00.000Z", thinkingLevel: "high" }

// ModelChangeEntry
{ type: "model_change", id: "b5a4c3d2", parentId: "f1e2d3c4",
  timestamp: "2025-06-15T10:31:30.000Z", provider: "anthropic", modelId: "claude-sonnet-4-20250514" }

// CompactionEntry
{
    type: "compaction", id: "c6d7e8f9", parentId: "b5a4c3d2",
    timestamp: "2025-06-15T11:00:00.000Z",
    summary: "The user asked to refactor the auth module. We renamed 3 functions and updated tests.",
    firstKeptEntryId: "a1b2c3d4", tokensBefore: 185000, fromHook: false,
}

// BranchSummaryEntry
{
    type: "branch_summary", id: "d8e9f0a1", parentId: "c6d7e8f9",
    timestamp: "2025-06-15T11:05:00.000Z", fromId: "b5a4c3d2",
    summary: "Abandoned approach: tried regex, switched to AST.", fromHook: false,
}

// CustomEntry — 扩展自定义数据（不参与 LLM 上下文）
{ type: "custom", id: "aa11bb22", parentId: "d8e9f0a1",
  timestamp: "2025-06-15T11:06:00.000Z", customType: "my-extension-state", data: { cursor: 42 } }

// CustomMessageEntry — 扩展消息（参与 LLM 上下文）
{
    type: "custom_message", id: "gg77hh88", parentId: "ee55ff66",
    timestamp: "2025-06-15T11:09:00.000Z", customType: "lint-results",
    content: "Found 3 lint errors in src/auth.ts", details: { source: "eslint" }, display: true,
}

// LabelEntry
{ type: "label", id: "cc33dd44", parentId: "aa11bb22",
  timestamp: "2025-06-15T11:07:00.000Z", targetId: "e5f6a7b8", label: "before refactor" }

// SessionInfoEntry
{ type: "session_info", id: "ee55ff66", parentId: "cc33dd44",
  timestamp: "2025-06-15T11:08:00.000Z", name: "Auth module refactor" }
```

### 7.3 SessionContext — 从树构建 LLM 上下文

```typescript
interface SessionContext {
    messages: AgentMessage[];
    thinkingLevel: string;
    model: { provider: string; modelId: string } | null;
}

function buildSessionContext(entries, leafId?, byId?): SessionContext
```

`buildSessionContext` 是会话系统的核心算法：
1. 从 `leafId` 指定的 entry 向根节点回溯，收集路径上的所有 entry
2. 提取路径上最新的 `ThinkingLevelChangeEntry` 和 `ModelChangeEntry`
3. 如果路径上有 `CompactionEntry`，先添加摘要消息，再添加从 `firstKeptEntryId` 到压缩点的保留消息，最后添加压缩点之后的消息
4. 如果没有压缩，直接按顺序收集所有消息类型的 entry

**消费关系**：`AgentSession` 中在会话恢复、树导航、压缩完成后都会调用 `sessionManager.buildSessionContext()` 来重建 agent 的消息列表。

**字面量例子**：

```typescript
const sessionCtx: SessionContext = {
    messages: [
        { role: "user", content: "Fix the bug", timestamp: 1718446201000 },
        { role: "assistant", content: [{ type: "text", text: "Done." }], api: "anthropic-messages",
          provider: "anthropic", model: "claude-sonnet-4-20250514", usage: { ... }, stopReason: "stop", timestamp: ... },
    ],
    thinkingLevel: "high",
    model: { provider: "anthropic", modelId: "claude-sonnet-4-20250514" },
};
```

### 7.4 SessionManager 类

```typescript
class SessionManager {
    private sessionId: string;
    private sessionFile: string | undefined;
    private sessionDir: string;
    private cwd: string;
    private persist: boolean;
    private fileEntries: FileEntry[];
    private byId: Map<string, SessionEntry>;
    private labelsById: Map<string, string>;
    private leafId: string | null;
}
```

**工厂方法**（全部是静态方法）：

| 方法 | 说明 |
|------|------|
| `SessionManager.create(cwd, sessionDir?)` | 创建新会话 |
| `SessionManager.open(path, sessionDir?, cwdOverride?)` | 打开指定会话文件 |
| `SessionManager.continueRecent(cwd, sessionDir?)` | 继续最近的会话 |
| `SessionManager.inMemory(cwd?)` | 创建纯内存会话（不写文件） |
| `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?)` | 从另一个项目 fork 会话 |
| `SessionManager.list(cwd, sessionDir?, onProgress?)` | 列出指定目录的所有会话 |
| `SessionManager.listAll(onProgress?)` | 列出所有项目的所有会话 |

**核心实例方法**：

| 方法 | 说明 |
|------|------|
| `appendMessage(message)` | 追加消息 entry（子节点挂在当前 leaf 下） |
| `appendCompaction(summary, firstKeptEntryId, tokensBefore, details?, fromHook?)` | 追加压缩 entry |
| `appendCustomEntry(customType, data?)` | 追加自定义 entry |
| `appendCustomMessageEntry(customType, content, display, details?)` | 追加自定义消息 entry |
| `branch(branchFromId)` | 移动 leaf 指针到指定 entry（开始新分支） |
| `branchWithSummary(branchFromId, summary, details?, fromHook?)` | 带摘要的分支 |
| `createBranchedSession(leafId)` | 从指定 leaf 创建新会话文件（只包含该路径的 entry） |
| `buildSessionContext()` | 构建当前 leaf 的 LLM 上下文 |
| `getBranch(fromId?)` | 从 entry 到根的路径 |
| `getTree()` | 获取完整的树结构 |

**持久化策略**：`_persist()` 方法实现了延迟写入 — 在收到第一条 assistant 消息之前不写入文件。这避免了只有 user 消息的"空"会话被保存。

### 7.5 版本迁移

```typescript
function migrateV1ToV2(entries): void  // 添加 id/parentId 树结构
function migrateV2ToV3(entries): void  // hookMessage → custom 重命名
```

会话文件在加载时自动迁移到最新版本（当前 v3）。

### 7.6 消费关系

- **最核心**：`packages/coding-agent/src/core/agent-session.ts` — `AgentSession` 类持有 `SessionManager` 实例，调用几十处方法管理会话的全部生命周期（追加消息、模型切换、压缩、分支、导航等）。
- **SDK 示例**：`examples/sdk/11-sessions.ts` 演示了所有工厂方法。
- **扩展**：extension 通过 `ctx.sessionManager`（`ReadonlySessionManager` 类型）读取会话状态。

### 7.7 阅读建议

读完 `session-manager.ts` 后你应该能回答：
- 会话文件的格式是什么？（JSONL，头行 + append-only entries）
- "时间旅行"（分支）是怎么实现的？（移动 `leafId` 指针，不修改已有数据）
- 压缩是怎么影响 LLM 上下文的？（摘要消息 + 保留消息 + 压缩后消息）
- 为什么会话在没有 assistant 消息时不写文件？（避免保存空会话）

---

## 8. `packages/coding-agent/src/core/system-prompt.ts`

**文件概览**：168 行。System prompt 的完整构建逻辑。你会看到 prompt 是如何从多个来源（基础模板、工具列表、指南、上下文文件、skills）层层拼装的。

### 8.1 BuildSystemPromptOptions

```typescript
interface BuildSystemPromptOptions {
    customPrompt?: string;        // 自定义 prompt（替换默认）
    selectedTools?: string[];     // 启用的工具名称
    toolSnippets?: Record<string, string>; // 工具的一行摘要
    promptGuidelines?: string[];  // 额外的指南条目
    appendSystemPrompt?: string;  // 追加到 prompt 末尾的文本
    cwd?: string;                 // 工作目录
    contextFiles?: Array<{ path: string; content: string }>; // 项目上下文文件（如 AGENTS.md）
    skills?: Skill[];             // 已加载的 skill
}
```

**字面量例子**：

```typescript
const promptOpts: BuildSystemPromptOptions = {
    selectedTools: ["read", "edit", "bash", "write"],
    toolSnippets: {
        read: "Read files from the filesystem",
        edit: "Edit files via search-and-replace",
        bash: "Execute shell commands",
        write: "Write new files",
    },
    promptGuidelines: ["Always run tests after editing source files"],
    appendSystemPrompt: "The user prefers concise responses.",
    cwd: "/Users/dev/my-project",
    contextFiles: [
        { path: "AGENTS.md", content: "# Dev Rules\n- No any types..." },
    ],
    skills: [
        { name: "docker", description: "Docker container management",
          filePath: "/Users/dev/.pi/skills/docker.md", baseDir: "/Users/dev/.pi/skills",
          sourceInfo: { type: "builtin" }, disableModelInvocation: false },
    ],
};
```

### 8.2 buildSystemPrompt — 两条分支

`buildSystemPrompt()` 有两条执行路径：

**路径 A — 自定义 prompt**（`customPrompt` 有值）：
1. 以 `customPrompt` 为基础
2. 追加 `appendSystemPrompt`
3. 追加项目上下文文件
4. 追加 skills（如果 read 工具可用）
5. 追加日期和工作目录

**路径 B — 默认 prompt**（无 `customPrompt`）：
1. 构建工具列表（只有提供了 `toolSnippets` 的工具才显示）
2. 构建指南列表（根据可用工具动态添加，如"Use bash for file operations"）
3. 拼装基础模板（角色描述 + 工具列表 + 指南 + pi 文档路径）
4. 追加 `appendSystemPrompt`
5. 追加项目上下文文件
6. 追加 skills
7. 追加日期和工作目录

**设计要点**：system prompt 不是静态字符串 — 它根据启用的工具、用户配置、项目上下文、已加载的 skills 动态组装。这解释了为什么 pi 可以根据环境自适应调整行为。

### 8.3 消费关系

- `packages/coding-agent/src/core/agent-session.ts` — `_rebuildSystemPrompt()` 方法调用 `buildSystemPrompt()`，传入当前的工具名称、自定义指令、context files、skills 等。在会话初始化、工具变更、reload 时都会重建。
- `packages/coding-agent/test/system-prompt.test.ts` — 直接测试各种组合下的 prompt 构建结果。

### 8.4 阅读建议

读完 `system-prompt.ts` 后你应该能回答：
- system prompt 的来源有哪些？（默认模板、工具信息、指南、自定义追加、上下文文件、skills）
- 什么决定了工具列表中显示哪些工具？（`toolSnippets` — 只有提供了摘要的工具才可见）
- 为什么日期和工作目录总是最后追加？（让 LLM 知道当前环境）

---

## 9. `packages/coding-agent/src/core/tools/edit.ts`

**文件概览**：约 307 行。文件编辑工具的完整实现 — 从 schema 定义到执行逻辑到 UI 渲染。这是理解 "pi 的工具是怎么设计的" 最好的范例。

### 9.1 参数 Schema（TypeBox）

```typescript
const replaceEditSchema = Type.Object({
    oldText: Type.String({ description: "..." }),
    newText: Type.String({ description: "..." }),
}, { additionalProperties: false });

const editSchema = Type.Object({
    path: Type.String({ description: "Path to the file to edit" }),
    edits: Type.Array(replaceEditSchema, { description: "..." }),
}, { additionalProperties: false });
```

参数定义使用 `@sinclair/typebox` — 这同时提供了运行时 JSON Schema 验证和编译时 TypeScript 类型推导。`Static<typeof editSchema>` 自动推导出 `EditToolInput` 类型。

**字面量例子**（`Static<typeof editSchema>` 推导出的实际值）：

```typescript
const input: EditToolInput = {
    path: "src/utils/auth.ts",
    edits: [
        { oldText: "function login(user: any)", newText: "function login(user: User)" },
        { oldText: "return null", newText: "return undefined" },
    ],
};
```

### 9.2 EditOperations — 可插拔的文件操作

```typescript
interface EditOperations {
    readFile: (absolutePath: string) => Promise<Buffer>;
    writeFile: (absolutePath: string, content: string) => Promise<void>;
    access: (absolutePath: string) => Promise<void>;
}
```

默认实现使用 `fs/promises`，但可以通过 `EditToolOptions.operations` 替换 — 这使得 SSH 远程编辑成为可能（见 `examples/extensions/ssh.ts`）。

**字面量例子**：

```typescript
const ops: EditOperations = {
    readFile: async (path) => Buffer.from(await fs.readFile(path)),
    writeFile: async (path, content) => { await fs.writeFile(path, content); },
    access: async (path) => { await fs.access(path, fs.constants.R_OK | fs.constants.W_OK); },
};

const editDetails: EditToolDetails = {
    diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-login(user: any)\n+login(user: User)",
    firstChangedLine: 1,
};
```

### 9.3 prepareEditArguments — 向后兼容

```typescript
function prepareEditArguments(input: unknown): EditToolInput
```

处理旧版 LLM 输出的参数格式 — 如果 LLM 传了 top-level 的 `oldText`/`newText`（旧格式），转换为 `edits[]` 数组（新格式）。这是 `AgentTool.prepareArguments` 的实际使用案例。

### 9.4 createEditToolDefinition — 完整的 ToolDefinition

```typescript
function createEditToolDefinition(cwd, options?): ToolDefinition<typeof editSchema, EditToolDetails, EditRenderState>
```

返回一个 `ToolDefinition` 对象（extension 层类型），包含：

| 字段 | 值 |
|------|-----|
| `name` | `"edit"` |
| `label` | `"edit"` |
| `description` | 编辑工具的 LLM 描述 |
| `promptSnippet` | 在 system prompt 的 Available tools 中显示的一行摘要 |
| `promptGuidelines` | 追加到 system prompt Guidelines 中的使用指南（4 条） |
| `parameters` | `editSchema` |
| `prepareArguments` | `prepareEditArguments` |
| `execute` | 核心执行逻辑 |
| `renderCall` | 自定义 TUI 渲染（工具调用时的显示） |
| `renderResult` | 自定义 TUI 渲染（工具结果的显示，渲染 diff） |

### 9.5 execute 逻辑

执行流程：
1. 验证输入（`validateEditInput`）
2. 解析路径（`resolveToCwd`）
3. 通过 `withFileMutationQueue` 排队（防止并发文件修改冲突）
4. 检查 abort signal
5. 读取文件内容
6. 剥离 BOM、检测换行符、标准化为 LF
7. 应用编辑（`applyEditsToNormalizedContent`）
8. 恢复原始换行符、重新加上 BOM
9. 写入文件
10. 生成 diff 字符串
11. 返回 `{ content: [成功消息], details: { diff, firstChangedLine } }`

注意 abort signal 在每个 I/O 操作前后都被检查 — 这是好的中止实践。

### 9.6 createEditTool — 包装为 AgentTool

```typescript
function createEditTool(cwd, options?): AgentTool<typeof editSchema>
```

调用 `wrapToolDefinition(createEditToolDefinition(cwd, options))`，把 `ToolDefinition` 转换为 `AgentTool`。

### 9.7 消费关系

- `packages/coding-agent/src/core/tools/index.ts` — 工具注册表中调用 `createEditToolDefinition(cwd)` 和 `createEditTool(cwd)`
- `packages/coding-agent/src/core/sdk.ts` — 默认工具集中包含 edit
- `packages/coding-agent/examples/extensions/ssh.ts` — 创建自定义 `EditOperations` 实现 SSH 远程编辑
- `packages/coding-agent/src/modes/interactive/components/tool-execution.ts` — 使用 `renderCall` 和 `renderResult` 渲染 TUI

### 9.8 阅读建议

读完 `edit.ts` 后你应该能回答：
- 一个完整的工具定义包含哪些部分？（schema、描述、execute、prepareArguments、renderCall、renderResult、promptSnippet、promptGuidelines）
- 为什么需要 `prepareArguments`？（向后兼容旧格式）
- 文件编辑如何处理并发？（`withFileMutationQueue`）
- 怎么让同一个工具在本地和远程都能工作？（`EditOperations` 接口）

---

## 10. `packages/coding-agent/src/core/extensions/types.ts`

**文件概览**：约 1450 行。Extension API 的完整类型定义。你会看到 Extension 可以做的所有事情：订阅事件、注册工具、注册命令和快捷键、UI 交互、provider 注册。这个文件定义了 pi 的**可扩展性边界**。

### 10.1 ExtensionUIContext — UI 能力

```typescript
interface ExtensionUIContext {
    select(title, options, opts?): Promise<string | undefined>;
    confirm(title, message, opts?): Promise<boolean>;
    input(title, placeholder?, opts?): Promise<string | undefined>;
    notify(message, type?): void;
    onTerminalInput(handler): () => void;
    setStatus(key, text): void;
    setWorkingMessage(message?): void;
    setHiddenThinkingLabel(label?): void;
    setWidget(key, content, options?): void;
    setFooter(factory): void;
    setHeader(factory): void;
    setTitle(title): void;
    custom<T>(factory, options?): Promise<T>;
    pasteToEditor(text): void;
    setEditorText(text): void;
    getEditorText(): string;
    editor(title, prefill?): Promise<string | undefined>;
    setEditorComponent(factory): void;
    readonly theme: Theme;
    getAllThemes(): { name: string; path: string | undefined }[];
    getTheme(name): Theme | undefined;
    setTheme(theme): { success: boolean; error?: string };
    getToolsExpanded(): boolean;
    setToolsExpanded(expanded): void;
}
```

这是 extension 与用户交互的全部能力。从简单的 select/confirm/input 对话框，到完全自定义的 UI 组件（`custom()`、`setWidget()`、`setFooter()`、`setHeader()`、`setEditorComponent()`），到主题控制。

**字面量例子**（方法调用形式）：

```typescript
const choice = await ctx.ui.select("Choose model", ["Claude 4 Sonnet", "GPT-4o"]);
const ok = await ctx.ui.confirm("Dangerous", "Delete all test files?");
const name = await ctx.ui.input("Session name", "my-session");
ctx.ui.notify("Extension loaded", "info");
ctx.ui.setStatus("git", "main ✓");
ctx.ui.setStatus("git", undefined); // 清除
```

### 10.2 ExtensionContext — 事件处理器的上下文

```typescript
interface ExtensionContext {
    ui: ExtensionUIContext;
    hasUI: boolean;
    cwd: string;
    sessionManager: ReadonlySessionManager;
    modelRegistry: ModelRegistry;
    model: Model<any> | undefined;
    isIdle(): boolean;
    signal: AbortSignal | undefined;
    abort(): void;
    hasPendingMessages(): boolean;
    shutdown(): void;
    getContextUsage(): ContextUsage | undefined;
    compact(options?): void;
    getSystemPrompt(): string;
}
```

每个事件处理器都会收到这个上下文。注意 `sessionManager` 是 `ReadonlySessionManager` — extension 不能直接修改会话，只能读取。

`ExtensionCommandContext` 继承 `ExtensionContext`，增加了会话控制方法（`newSession`、`fork`、`navigateTree`、`switchSession`、`reload`）— 这些只在用户主动触发的命令中可用。

**字面量例子**：

```typescript
// ExtensionContext 的属性值
ctx.ui;                  // ExtensionUIContext 实现
ctx.hasUI;               // true
ctx.cwd;                 // "/Users/dev/my-project"
ctx.model;               // Model<any> 或 undefined
ctx.isIdle();            // true
ctx.signal;              // undefined（agent 不在运行时）
ctx.getContextUsage();   // { tokens: 45000, contextWindow: 200000, percent: 22.5 }
ctx.getSystemPrompt();   // "You are pi..."

// ExtensionCommandContext 额外方法
await ctx.waitForIdle();
await ctx.newSession();
await ctx.fork("e5f6a7b8");
await ctx.navigateTree("d4c3b2a1", { summarize: true });
```

### 10.3 ToolDefinition — Extension 层的工具定义

```typescript
interface ToolDefinition<TParams extends TSchema, TDetails = unknown, TState = any> {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TParams;
    prepareArguments?: (args) => Static<TParams>;
    execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<TDetails>>;
    renderCall?: (args, theme, context) => Component;
    renderResult?: (result, options, theme, context) => Component;
}
```

与 `AgentTool` 的关键区别：
- `execute` 多了一个 `ctx: ExtensionContext` 参数 — extension 工具可以访问 UI、会话、模型等
- 有 `renderCall` / `renderResult` — 自定义 TUI 渲染
- 有 `promptSnippet` / `promptGuidelines` — 影响 system prompt 构建

`defineTool()` 辅助函数保留泛型推导，避免赋值时类型被 widen。

**消费关系**：`tool-definition-wrapper.ts` 的 `wrapToolDefinition()` 把 `ToolDefinition` 转换为 `AgentTool`。`tool-execution.ts` 使用 `renderCall` / `renderResult` 渲染 TUI。

**字面量例子**：

```typescript
const myTool: ToolDefinition<typeof mySchema, { count: number }> = {
    name: "count_lines",
    label: "count lines",
    description: "Count lines in a file",
    promptSnippet: "Count lines in files",
    promptGuidelines: ["Use count_lines for line counting instead of bash wc -l"],
    parameters: Type.Object({ path: Type.String({ description: "File path" }) }),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
        const content = await readFile(params.path, "utf-8");
        const count = content.split("\n").length;
        return { content: [{ type: "text", text: `${count} lines` }], details: { count } };
    },
};
```

### 10.4 事件类型（约 40 种）

事件分为几个大类：

**Resource 事件**：`resources_discover` — 扩展可以提供额外的 skill/prompt/theme 路径

**Session 事件**（8 种）：
- `session_start`：会话启动
- `session_before_switch` / `session_before_fork` / `session_before_compact` / `session_before_tree`：可以取消或自定义的"before"事件
- `session_compact` / `session_tree`：完成后通知
- `session_shutdown`：进程退出

**Agent 事件**（9 种）：
- `context`：LLM 调用前，可修改消息
- `before_provider_request`：可替换 provider payload
- `before_agent_start`：prompt 提交后、循环开始前
- `agent_start` / `agent_end`
- `turn_start` / `turn_end`
- `message_start` / `message_update` / `message_end`
- `tool_execution_start` / `tool_execution_update` / `tool_execution_end`

**Tool 事件**（2 种）：
- `tool_call`：工具执行前，可以 block 或修改参数（`event.input` 可变）
- `tool_result`：工具执行后，可以修改返回内容

**Model 事件**：`model_select` — 模型切换时触发

**User 事件**：`user_bash`（用户 `!` 命令）、`input`（用户输入，可 transform 或 handled）

每种事件都有对应的 `*Result` 类型定义返回值结构。

**字面量例子**（各类代表性事件）：

```typescript
// Session 事件
const e1: SessionStartEvent = { type: "session_start", reason: "startup" };

// Agent 事件
const e2: BeforeAgentStartEvent = {
    type: "before_agent_start", prompt: "Fix the auth bug", systemPrompt: "You are pi...",
};

// Model 事件
const e3: ModelSelectEvent = {
    type: "model_select", model: model, previousModel: undefined, source: "set",
};

// Tool 事件 — tool_call（event.input 可变）
const e4: ToolCallEvent = {
    type: "tool_call", toolCallId: "toolu_01abc", toolName: "edit",
    input: { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
};

// Tool 事件 — tool_result
const e5: ToolResultEvent = {
    type: "tool_result", toolCallId: "toolu_01abc", toolName: "edit",
    input: { path: "src/index.ts", edits: [{ oldText: "foo", newText: "bar" }] },
    content: [{ type: "text", text: "Successfully edited src/index.ts" }],
    isError: false, details: { diff: "- foo\n+ bar", firstChangedLine: 10 },
};

// User 事件
const e6: InputEvent = { type: "input", text: "Fix the auth module", source: "interactive" };
const e7: UserBashEvent = { type: "user_bash", command: "git status", excludeFromContext: false, cwd: "/Users/dev/my-project" };

// InputEventResult 各变体
const r1: InputEventResult = { action: "continue" };
const r2: InputEventResult = { action: "transform", text: "TRANSFORMED: Fix the auth module" };
const r3: InputEventResult = { action: "handled" };
```

### 10.5 ExtensionAPI — Extension 工厂函数的参数

```typescript
interface ExtensionAPI {
    // 事件订阅
    on(event: "session_start", handler): void;
    on(event: "tool_call", handler): void;
    // ... 约 25 种事件

    // 工具注册
    registerTool(tool: ToolDefinition): void;

    // 命令、快捷键、CLI flag 注册
    registerCommand(name, options): void;
    registerShortcut(shortcut, options): void;
    registerFlag(name, options): void;
    getFlag(name): boolean | string | undefined;

    // 消息渲染器注册
    registerMessageRenderer(customType, renderer): void;

    // Actions
    sendMessage(message, options?): void;
    sendUserMessage(content, options?): void;
    appendEntry(customType, data?): void;
    setSessionName(name): void;
    getSessionName(): string | undefined;
    setLabel(entryId, label): void;
    exec(command, args, options?): Promise<ExecResult>;
    getActiveTools(): string[];
    getAllTools(): ToolInfo[];
    setActiveTools(toolNames): void;
    getCommands(): SlashCommandInfo[];

    // Model / Thinking
    setModel(model): Promise<boolean>;
    getThinkingLevel(): ThinkingLevel;
    setThinkingLevel(level): void;

    // Provider 注册
    registerProvider(name, config): void;
    unregisterProvider(name): void;

    // 事件总线
    events: EventBus;
}
```

这是 extension 的全部 API 表面。每个 extension 的入口函数签名是：

```typescript
type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
```

**字面量例子**：

```typescript
const myExtension: ExtensionFactory = (pi) => {
    pi.on("session_start", async (event, ctx) => {
        ctx.ui.notify(`Session started: ${event.reason}`);
    });

    pi.registerTool(myTool);

    pi.registerCommand("greet", {
        description: "Say hello",
        handler: async (args, ctx) => { ctx.ui.notify(`Hello, ${args || "world"}!`); },
    });
};
```

### 10.6 ProviderConfig — 自定义 Provider 注册

```typescript
interface ProviderConfig {
    baseUrl?: string;
    apiKey?: string;
    api?: Api;
    streamSimple?: (...) => AssistantMessageEventStream;
    headers?: Record<string, string>;
    authHeader?: boolean;
    models?: ProviderModelConfig[];
    oauth?: { name; login; refreshToken; getApiKey; modifyModels? };
}
```

extension 可以通过 `pi.registerProvider()` 注册自定义 LLM provider — 提供 models 列表、自定义流处理器，甚至 OAuth 登录流程。

**字面量例子**：

```typescript
const providerConfig: ProviderConfig = {
    baseUrl: "https://proxy.example.com/v1",
    apiKey: "PROXY_API_KEY",
    api: "openai-completions",
    headers: { "X-Org": "my-org" },
    authHeader: true,
    models: [{
        id: "gpt-4o", name: "GPT-4o (via proxy)", reasoning: false,
        input: ["text", "image"],
        cost: { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
        contextWindow: 128000, maxTokens: 16384,
    }],
};
```

### 10.7 Extension / LoadExtensionsResult

```typescript
interface Extension {
    path: string;
    resolvedPath: string;
    sourceInfo: SourceInfo;
    handlers: Map<string, HandlerFn[]>;
    tools: Map<string, RegisteredTool>;
    messageRenderers: Map<string, MessageRenderer>;
    commands: Map<string, RegisteredCommand>;
    flags: Map<string, ExtensionFlag>;
    shortcuts: Map<KeyId, ExtensionShortcut>;
}
```

`Extension` 是加载后的 extension 完整状态 — 所有注册的处理器、工具、命令、快捷键都在这里。

**字面量例子**：

```typescript
const ext: Extension = {
    path: "~/.pi/extensions/my-ext.ts",
    resolvedPath: "/Users/dev/.pi/extensions/my-ext.ts",
    sourceInfo: { type: "user", path: "/Users/dev/.pi/extensions/my-ext.ts" },
    handlers: new Map([["session_start", [handler1]], ["tool_call", [handler2]]]),
    tools: new Map([["count_lines", { definition: myTool, sourceInfo: { ... } }]]),
    messageRenderers: new Map(),
    commands: new Map([["deploy", { name: "deploy", handler: async () => {}, sourceInfo: { ... } }]]),
    flags: new Map([["verbose", { name: "verbose", type: "boolean", default: false, extensionPath: "..." }]]),
    shortcuts: new Map(),
};
```

### 10.8 消费关系

- **Extension 开发者**：每个 extension 文件导出 `(pi: ExtensionAPI) => void`，使用 `pi.on()`、`pi.registerTool()`、`pi.registerCommand()` 等
- **运行时**：`packages/coding-agent/src/core/extensions/runner.ts` — `ExtensionRunner` 加载和运行 extension，创建 `ExtensionContext`
- **工具系统**：`tool-definition-wrapper.ts` — `wrapToolDefinition()` 把 `ToolDefinition` 转换为 `AgentTool`
- **TUI 渲染**：`tool-execution.ts` 使用 `ToolDefinition.renderCall/renderResult`
- **SDK 导出**：`packages/coding-agent/src/index.ts` 导出 `ExtensionAPI`、`ExtensionContext`、`ToolDefinition`、`ExtensionFactory` 等类型

### 10.9 阅读建议

读完 `extensions/types.ts` 后你应该能回答：
- Extension 能做什么、不能做什么？（能做的全在 `ExtensionAPI` 中列出；不能直接修改会话）
- Extension 和 Skill 的区别？（Extension 是代码模块，Skill 是 Markdown 注入到 system prompt）
- Extension 怎么注册自定义 LLM provider？（`pi.registerProvider(name, config)`）
- 事件处理器在什么上下文中运行？（`ExtensionContext` — 有 UI、会话只读访问、模型信息等）
- Tool 和 ToolDefinition 的区别？（`ToolDefinition` 有 UI 渲染和 ctx 参数；通过 `wrapToolDefinition` 转换为 `AgentTool`）

---

## 总结：类型如何串连整个系统

```
pi-ai (types.ts)                pi-agent-core (types.ts)           pi-coding-agent
─────────────────               ────────────────────────           ─────────────────
Model<TApi>          ──────►    AgentLoopConfig.model    ──────►  AgentSession.model
Context              ◄──────    agent-loop 构造          ◄──────  session-manager 提供 messages
Message              ──────►    AgentMessage (超集)      ──────►  SessionMessageEntry.message
Tool                 ──────►    AgentTool (超集)         ──────►  ToolDefinition → wrapToolDefinition
StreamFunction       ──────►    StreamFn                 ──────►  Agent.streamFn
AssistantMessageEvent ─────►    AgentEvent.message_update ─────►  ExtensionEvent.message_update
```

数据自底向上流动：pi-ai 定义基础类型 → agent-core 扩展为 agent 概念 → coding-agent 消费并包装为产品功能。类型边界清晰，每层只依赖下层的公共 API。

---

> 本文基于 pi-mono v0.66.0 的源码编写。文件路径和行号可能随版本变化。

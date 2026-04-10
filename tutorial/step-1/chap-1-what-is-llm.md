# 第 1 章：什么是 LLM，什么不是

## 前置知识

本章是整个教程系列的起点，不需要任何前置知识。你只需要有基本的编程经验（能读懂 TypeScript 代码即可）。

## 本章聚焦的层次

本章聚焦于整个系统的最底层——**模型本身**。我们要搞清楚 LLM 到底是什么、能做什么、不能做什么。这是后续所有章节的认知基础。

在 pi-mono 的分层架构中，本章对应的是 `packages/ai`，它负责"怎么稳定地和模型说话"。后续章节会在此基础上构建 agent 循环（`packages/agent`）、产品能力（`packages/coding-agent`）、交互界面（`packages/tui`、`packages/web-ui`）和部署系统（`packages/mom`、`packages/pods`）。

## LLM 是什么

LLM（Large Language Model，大语言模型）是一种经过大规模文本数据训练的神经网络模型。

先用一句话概括它的核心能力：

> **给定一段上下文，预测接下来最可能出现的 token。**

就这么简单。所有你看到的"对话"、"推理"、"写代码"、"总结文档"，本质上都是这个预测过程的外在表现。

### Token：模型的最小单位

模型不直接处理"文字"或"单词"。它处理的是 **token**——一种介于字符和单词之间的文本片段。

举几个例子：

- 英文单词 `hello` 通常是 1 个 token
- 中文 `你好` 可能是 2 个 token（每个汉字一个）
- 代码 `console.log("hello")` 可能被拆成 5-7 个 token
- 一个空格、一个换行符，都可能是独立的 token

不同模型使用不同的 tokenizer（分词器），所以同一段文本在不同模型下的 token 数量可能不同。

为什么 token 重要？因为：

1. **模型的输入和输出都以 token 计量**——你发给模型的消息、模型返回的回复，都按 token 计费
2. **上下文窗口以 token 为单位**——模型一次能"看到"的信息量有上限
3. **生成速度以 token/秒衡量**——模型每秒能产出多少 token 决定了响应速度

在 pi-mono 中，token 的使用量通过 `Usage` 类型追踪：

```typescript
// packages/ai/src/types.ts
export interface Usage {
  input: number; // 输入 token 数
  output: number; // 输出 token 数
  cacheRead: number; // 从缓存读取的 token 数
  cacheWrite: number; // 写入缓存的 token 数
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number; // 总费用（美元）
  };
}
```

每次模型调用结束后，`AssistantMessage` 都会携带 `usage` 字段，告诉你这次调用消耗了多少 token、花了多少钱。这不是锦上添花——在真实 agent 系统中，成本控制是核心工程问题。

### 上下文窗口：模型的"工作记忆"

上下文窗口（context window）是模型一次调用中能处理的最大 token 数量，包括输入和输出。

你可以把它想象成模型的"工作台"——工作台有多大，决定了你能同时摆多少资料。

不同模型的上下文窗口差异很大：

- 早期模型：4K-8K token
- 当前主流模型：128K-200K token
- 部分模型：1M+ token

在 pi-mono 中，每个模型的上下文窗口大小记录在 `Model` 接口中：

```typescript
// packages/ai/src/types.ts
export interface Model<TApi extends Api> {
  id: string;
  name: string;
  api: TApi;
  provider: Provider;
  contextWindow: number; // 上下文窗口大小（token 数）
  maxTokens: number; // 单次输出的最大 token 数
  // ...
}
```

`contextWindow` 和 `maxTokens` 是两个不同的概念：

- `contextWindow` 是总容量——输入 + 输出不能超过这个数
- `maxTokens` 是单次输出上限——模型一次最多生成这么多 token

为什么上下文窗口如此重要？因为在 agent 场景中，上下文里不只有用户的一句话。它通常包含：

- system prompt（系统提示词）
- 历史对话消息
- 工具定义（tool schema）
- 工具调用结果
- 附件、图片
- 运行时注入的规则

这些东西加起来，很容易就把上下文窗口撑满。这就是为什么后续章节会专门讨论上下文压缩（compaction）和裁剪策略。

### 采样：模型如何"选择"下一个 token

模型预测下一个 token 时，并不是直接给出一个确定答案。它输出的是一个**概率分布**——对词表中每个 token 给出一个概率值。

然后，通过**采样**（sampling）策略从这个分布中选出一个 token。

最常见的采样参数是 **temperature**（温度）：

- `temperature = 0`：几乎总是选概率最高的 token（确定性输出）
- `temperature = 0.5-0.7`：在高概率 token 中适度随机
- `temperature = 1.0+`：更大的随机性，更"有创意"但也更不可控

在 pi-mono 中，temperature 是 `StreamOptions` 的一部分：

```typescript
// packages/ai/src/types.ts
export interface StreamOptions {
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  apiKey?: string;
  // ...
}
```

这意味着每次调用模型时，你都可以控制采样行为。对于 coding agent 这类需要精确输出的场景，通常使用较低的 temperature；对于创意写作类场景，可以适当调高。

### 模型的能力边界

理解了 token、上下文窗口和采样之后，我们可以明确 LLM 的能力边界：

**LLM 能做的：**

- 根据上下文生成连贯的文本
- 理解和遵循指令（instruction following）
- 在上下文中进行推理（in-context reasoning）
- 处理多种语言
- 理解代码结构
- 根据 schema 生成结构化输出（如 JSON）

**LLM 不能做的：**

- 读你的文件系统
- 执行命令
- 记住上一次对话的内容（除非你把它放回上下文）
- 访问互联网
- 保证输出 100% 正确
- 自主决定何时停止、何时继续

这个边界至关重要。LLM 本身只是一个"生成器"——你给它输入，它给你输出。所有超出这个范围的能力（读文件、执行命令、记忆、工具调用），都是外围系统补出来的。这正是 agent 存在的意义，也是后续章节的主题。

## LLM 不是什么

### LLM 不是搜索引擎

搜索引擎从已有的文档库中检索信息。LLM 是根据训练数据中学到的模式生成新文本。它可能"看起来像在搜索"，但实际上是在做概率预测。这就是为什么 LLM 会"幻觉"（hallucinate）——它生成的内容看起来合理，但可能是错的。

### LLM 不是数据库

LLM 不存储你的数据。它的"知识"来自训练数据，而且有截止日期。它不知道你昨天写了什么代码，除非你把代码放进上下文。

### LLM 不是自主系统

这是最容易混淆的一点。LLM 本身不会主动做任何事。模型可以根据上下文提出下一步动作，比如“去读一个文件”“这个结果可能不对，应该重试”，并把这些意图输出为文本或结构化调用请求。

但模型本身并不会直接执行这些动作。真正负责解析模型输出、调用工具、保存状态、把结果反馈回模型，并持续推进多轮步骤的，是 agent runtime。也正因为如此，agent 需要一个循环来驱动，而这个循环正是 runtime 的核心职责之一。

## 在 pi-mono 中，LLM 是怎样被使用的

pi-mono 通过 `packages/ai` 提供了一个统一的 LLM 接口层。这个包的核心职责是：

> **让应用层不需要关心"我在和哪个模型厂商说话"。**

### 为什么需要统一接口

不同的模型提供商（provider）有完全不同的 API：

- **OpenAI** 使用 Chat Completions API 或 Responses API
- **Anthropic** 使用 Messages API
- **Google** 使用 Generative AI API
- **Mistral** 使用 Conversations API
- **Amazon Bedrock** 使用 Converse API

它们的差异不只是 URL 不同。下面逐一展开六个关键维度的差异：

**① 消息格式**

每个 provider 对"一条消息长什么样"有完全不同的定义：

- **OpenAI Chat Completions**：消息是 `{ role: "user" | "assistant" | "system" | "developer" | "tool", content: string | ContentPart[] }` 的数组。助手内容是纯字符串或内容块数组，工具结果用 `role: "tool"` 表示。
- **OpenAI Responses**：消息不再是简单的 role/content 对，而是类型化的 item 列表——`input_text`、`input_image`、`output_text`、`function_call`、`function_call_output`、`reasoning` 等，每个 item 有自己的 `type` 和 `id`。
- **Anthropic**：消息是 `{ role: "user" | "assistant", content: ContentBlockParam[] }` 的数组。注意 Anthropic 没有独立的 `tool` 角色——工具结果被包装成 `{ type: "tool_result", tool_use_id: "..." }` 放在 `role: "user"` 的消息里。多个连续的工具结果必须合并到同一条 user 消息中。
- **Google Gemini**：消息是 `Content[]`，每条 content 包含 `role: "user" | "model"` 和 `parts: Part[]`。Part 可以是 `{ text }` 或 `{ inlineData }` 或 `{ functionCall }` 或 `{ functionResponse }`。注意 Google 用 `model` 而不是 `assistant`。
- **Mistral**：消息格式类似 OpenAI，但图片用 `{ type: "image_url", imageUrl: "data:..." }` 而不是 `{ type: "image_url", image_url: { url: "data:..." } }`——字段名和嵌套层级都不同。
- **Amazon Bedrock**：消息使用 AWS SDK 的 `ConversationRole.USER` / `ConversationRole.ASSISTANT` 枚举，内容块是 `{ text }` 或 `{ image: { format, source: { bytes } } }` 的结构。

甚至连 system prompt 的传递方式都不统一：OpenAI 用 `role: "system"` 或 `role: "developer"` 消息；Anthropic 把它放在请求体的顶层 `system` 字段；Google 放在 `systemInstruction` 字段。

**② 流式事件结构**

模型流式输出时，每个 provider 发出的事件类型和结构完全不同：

- **OpenAI Chat Completions**：返回 `ChatCompletionChunk` 对象流，每个 chunk 包含 `choices[0].delta`，delta 里可能有 `content`（文本增量）或 `tool_calls`（工具调用增量）。
- **OpenAI Responses**：返回 `ResponseStreamEvent` 事件流，事件类型包括 `response.output_item.added`、`response.content_part.delta`、`response.function_call_arguments.delta`、`response.completed` 等——粒度更细，每个 item 有独立的生命周期。
- **Anthropic**：返回 `message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop` 的事件序列。内容块类型包括 `text`、`thinking`、`tool_use`。
- **Google Gemini**：返回 SSE 格式的 `GenerateContentResponse` 流，每个 response 包含 `candidates[0].content.parts`，需要自己判断 part 是文本、思考还是函数调用。
- **Mistral**：返回类似 OpenAI 的 chunk 流，但字段名不同（`finishReason` 而不是 `finish_reason`，`promptTokens` 而不是 `prompt_tokens`）。

**③ 工具调用协议**

模型"请求调用工具"的方式在各 provider 间差异显著：

- **OpenAI Chat Completions**：工具调用出现在 `delta.tool_calls` 数组中，每个调用有 `id`、`function.name`、`function.arguments`（JSON 字符串，流式时分片到达）。
- **OpenAI Responses**：工具调用是独立的 `function_call` item，有 `call_id` 和 `id` 两个标识符（`call_id` 用于匹配结果，`id` 是 item 级别的标识，必须以 `fc_` 开头）。
- **Anthropic**：工具调用是 `type: "tool_use"` 的内容块，有 `id`、`name`、`input`（JSON 对象，不是字符串）。工具结果通过 `tool_use_id` 关联。ID 格式要求 `^[a-zA-Z0-9_-]+$`，最长 64 字符。
- **Google Gemini**：工具调用是 `functionCall` part，包含 `name` 和 `args`（直接是对象）。早期版本没有 `id` 字段，需要自己生成。工具结果通过 `functionResponse` part 返回。
- **Amazon Bedrock**：工具调用通过 `toolUse` 内容块表示，有 `toolUseId`、`name`、`input`。

连工具调用 ID 的格式都不兼容：OpenAI Responses API 生成的 ID 可以超过 450 个字符并包含 `|` 等特殊字符，而 Anthropic 要求 ID 必须匹配 `^[a-zA-Z0-9_-]+$` 且不超过 64 字符。pi-mono 专门有一个 `transform-messages.ts` 来处理跨 provider 的 ID 归一化。

**④ 认证方式**

- **OpenAI**：标准 `Authorization: Bearer sk-...` header。
- **Anthropic**：使用 `x-api-key` header（不是 `Authorization`），OAuth token 以 `sk-ant-oat` 开头需要特殊处理。GitHub Copilot 代理模式下用 `authToken` 而不是 `apiKey`，还需要额外的 `anthropic-beta` header 来启用特定功能。
- **Google**：API key 通过 URL 参数传递（`?key=...`），或使用 OAuth2 access token。Vertex AI 使用 Google Cloud 的 service account 认证。
- **Amazon Bedrock**：使用 AWS SDK 的 Signature V4 签名认证，需要 access key、secret key 和 region，完全不同于 HTTP header 认证。
- **OpenAI Codex**：从 JWT token 中提取 `accountId`，请求需要同时携带 `Authorization`、`chatgpt-account-id`、`originator` 等多个自定义 header。

**⑤ 错误处理**

各 provider 的错误响应格式和可重试条件各不相同：

- **OpenAI**：错误在 `error.message` 字段，`finish_reason` 可能是 `content_filter`（内容审核拦截）或 `length`（超出长度）。
- **Anthropic**：错误通过 `message_delta` 事件的 `stop_reason` 传递，可能的值包括 `end_turn`、`max_tokens`、`tool_use`、`stop_sequence`。
- **Google**：错误是 HTTP 响应体中的 JSON，需要解析 `error.message` 字段。429 错误的重试延迟可能藏在错误文本中（`"Your quota will reset after 18h31m10s"`），也可能在 `retry-after` header 中，还可能在 JSON 的 `retryDelay` 字段中——三种格式都要处理。
- **OpenAI Codex**：错误可能包含 `plan_type` 和 `resets_at` 字段，用于生成友好的"您已达到使用限制"提示。
- **Bedrock**：错误通过 AWS SDK 的异常类型传递，需要处理 `ThrottlingException`、`ModelTimeoutException` 等 AWS 特有的错误类型。

**⑥ Token 计量方式**

各 provider 返回 token 使用量的字段名和语义都不同：

- **OpenAI Chat Completions**：`usage.prompt_tokens`、`usage.completion_tokens`，缓存信息在 `prompt_tokens_details.cached_tokens` 和 `prompt_tokens_details.cache_write_tokens` 中。有些兼容 provider（如 OpenRouter）把"缓存命中 + 本次写入"合并报告为 `cached_tokens`，需要手动拆分。推理 token 在 `completion_tokens_details.reasoning_tokens` 中，有些 provider（如 Groq）不把它计入 `total_tokens`。
- **OpenAI Responses**：`usage.input_tokens`、`usage.output_tokens`，缓存信息在 `input_tokens_details.cached_tokens` 中。注意 `input_tokens` 已经包含了缓存 token，需要减去才能得到实际的非缓存输入。
- **Anthropic**：`usage.input_tokens`、`usage.output_tokens`、`usage.cache_read_input_tokens`、`usage.cache_creation_input_tokens`。Anthropic 不提供 `total_tokens` 字段，需要自己计算。
- **Google Gemini**：`usageMetadata.promptTokenCount`、`usageMetadata.candidatesTokenCount`、`usageMetadata.cachedContentTokenCount`、`usageMetadata.thoughtsTokenCount`、`usageMetadata.totalTokenCount`。注意 Google 把思考 token 单独列出。
- **Mistral**：`usage.promptTokens`、`usage.completionTokens`、`usage.totalTokens`——用驼峰命名而不是下划线。没有缓存相关字段。

这些差异意味着，即使是"统计这次调用花了多少 token"这样看似简单的事情，每个 provider 都需要不同的解析和归一化逻辑。

---

如果应用层直接对接每个 provider 的 SDK，代码会变成一堆 `if provider === 'openai' ... else if provider === 'anthropic' ...` 的分支。每加一个 provider，所有调用点都要改。

`packages/ai` 的解决方案是定义一套统一的类型和接口，然后让每个 provider 的实现去适配这套接口。

### 核心抽象：Model、Context、Message

在 pi-mono 中，和 LLM 交互的核心概念只有三个：

**Model**——你要和哪个模型说话：

```typescript
// 获取一个模型实例
import { getModel } from "@mariozechner/pi-ai";
const model = getModel("openai", "gpt-4o-mini");
```

`getModel` 返回的 `Model` 对象包含了模型的所有元数据：它用哪个 API、上下文窗口多大、支不支持图片输入、支不支持推理（reasoning）、每百万 token 多少钱。

**Context**——你要告诉模型什么：

```typescript
const context: Context = {
  systemPrompt: "You are a helpful assistant.",
  messages: [{ role: "user", content: "What time is it?" }],
  tools: [
    /* 工具定义 */
  ],
};
```

Context 包含三部分：

- `systemPrompt`：系统级指令，告诉模型它的角色和行为规则
- `messages`：对话历史，包括用户消息、助手回复、工具结果
- `tools`：模型可以调用的工具列表

**Message**——对话中的每一条消息：

```typescript
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

三种角色：

- `UserMessage`：用户说的话
- `AssistantMessage`：模型的回复（可能包含文本、思考过程、工具调用）
- `ToolResultMessage`：工具执行的结果

这三个概念构成了和 LLM 交互的完整协议。无论底层是 OpenAI、Anthropic 还是 Google，上层代码都用同一套类型。

### 两种调用方式：stream 和 complete

pi-mono 提供了两种调用模型的方式：

```typescript
// 流式调用——边生成边返回事件
const s = stream(model, context);
for await (const event of s) {
  // 处理每个事件：text_delta、toolcall_end、done...
}

// 一次性调用——等模型生成完毕再返回
const response = await complete(model, context);
```

`stream` 返回一个异步事件流，你可以实时处理每个 token 的到来。`complete` 则等待整个响应完成后一次性返回。

在 agent 场景中，`stream` 几乎总是首选，因为：

1. 用户可以实时看到模型的输出，体验更好
2. 可以在生成过程中逐步检测到工具调用，而不必等待整个响应完成
3. 可以在中途中断（abort），节省不必要的 token 消耗

这两个函数的实现非常简洁（`packages/ai/src/stream.ts`）：

```typescript
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

`stream` 根据模型的 `api` 字段找到对应的 provider 实现，然后委托给它。`complete` 只是 `stream` 的便捷封装——启动流，等待最终结果。

这种设计意味着：**所有 provider 的差异都被封装在各自的实现文件中**，上层代码完全不需要知道底层用的是哪个 API。

### 事件流：模型输出不是一个字符串

当你调用 `stream` 时，模型的输出不是一个完整的字符串，而是一系列**事件**：

```typescript
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | { type: "toolcall_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "toolcall_end";
      contentIndex: number;
      toolCall: ToolCall;
      partial: AssistantMessage;
    }
  | { type: "done"; reason: StopReason; message: AssistantMessage }
  | { type: "error"; reason: StopReason; error: AssistantMessage };
// ...
```

这不是为了好看。事件流是 agent 系统的基础设施：

- `text_delta` 让 UI 可以逐字显示模型输出
- `toolcall_end` 告诉 agent runtime "模型想调用一个工具"
- `thinking_delta` 让用户看到模型的推理过程
- `done` 和 `error` 标记流的结束，触发后续逻辑

在后续章节中，你会看到 `packages/agent` 如何消费这些事件来驱动 agent 循环。

### 深入理解：这些事件是 LLM 原生生成的吗？

读到这里你可能会有一个疑问：`AssistantMessageEvent` 中的这些结构化事件（`text_delta`、`toolcall_start`、`toolcall_end` 等）是 LLM 原生就能生成的吗？

答案是：**不是**。LLM 本身确实只是"吐出一坨字符串"。这些结构化事件是 `packages/ai` 中每个 provider 实现**解析原始流之后手动构造并 push 出来的**。

整个过程经历三层转换：

```
LLM 模型（神经网络）
    ↓ 输出 token 序列（包含特殊的工具调用 token）
供应商 API 服务层（OpenAI / Anthropic / Google）
    ↓ 解析 token，拆分成文本块、工具调用块、思考块等，以各自格式返回
pi-mono packages/ai（各 provider 实现）
    ↓ 统一翻译成 8 种 AssistantMessageEvent
上层消费者（Agent / UI）
```

以 OpenAI Chat Completions 为例（`packages/ai/src/providers/openai-completions.ts`），LLM 返回的原始数据长这样：

```typescript
// OpenAI 返回的原始 chunk（简化）
{
  choices: [
    {
      delta: {
        content: "Hello", // 文本片段——就是一坨字符串
        tool_calls: [
          {
            // 工具调用片段——也是字符串
            id: "call_abc",
            function: {
              name: "read_file",
              arguments: '{"path":', // JSON 字符串，分片到达！
            },
          },
        ],
      },
      finish_reason: null, // 还没结束
    },
  ];
}
```

然后 provider 代码**手动解析**这些原始 chunk，维护一个状态机，逐步构造出统一事件：

```typescript
// openai-completions.ts 中的实际代码（简化）
for await (const chunk of openaiStream) {
    const choice = chunk.choices[0];

    // 原始 chunk 里有 content？→ 构造 text_delta 事件
    if (choice.delta.content) {
        currentBlock.text += choice.delta.content;
        stream.push({                          // ← 手动 push！
            type: "text_delta",
            delta: choice.delta.content,
            partial: output,
        });
    }

    // 原始 chunk 里有 tool_calls？→ 构造 toolcall 系列事件
    if (choice.delta.tool_calls) {
        // 新工具调用开始 → push toolcall_start
        stream.push({ type: "toolcall_start", ... });

        // 参数 JSON 片段到达 → 累积并 push toolcall_delta
        currentBlock.partialArgs += toolCall.function.arguments;
        stream.push({ type: "toolcall_delta", delta: ..., ... });
    }

    // chunk 结束 → push toolcall_end（解析完整 JSON）
    // 整个流结束 → push done
}
```

每个 provider 的原始流格式完全不同，这也是为什么需要封装：

| Provider               | 原始流格式                                                            | 工具调用在哪里              |
| ---------------------- | --------------------------------------------------------------------- | --------------------------- |
| **OpenAI Completions** | `ChatCompletionChunk`，工具在 `delta.tool_calls`                      | JSON 字符串分片             |
| **OpenAI Responses**   | `ResponseStreamEvent`，事件类型如 `response.output_text.delta`        | 独立的 `function_call` item |
| **Anthropic**          | `message_start` → `content_block_start` → `content_block_delta` → ... | `type: "tool_use"` 内容块   |
| **Google Gemini**      | `GenerateContentResponse` 流，内容在 `candidates[0].content.parts`    | `functionCall` part         |

每个 provider 实现文件（如 `packages/ai/src/providers/anthropic.ts`）都在做同一件事：**把各自格式的原始流，翻译成统一的 `AssistantMessageEvent` 事件序列**。

### 工具调用的本质：LLM 怎么"调用工具"的？

既然 LLM 只是生成字符串，它怎么"调用工具"的？

答案是：**LLM 并不真的调用工具**。它只是在输出中生成了一段特殊格式的文本（比如一个 JSON），表达"我想调用这个函数"。各 provider 的 API 层会把这段文本从普通文本中分离出来，放到 `tool_calls` 字段里返回。然后 pi-mono 的 provider 代码再把它翻译成 `toolcall_start` → `toolcall_delta` → `toolcall_end` 事件。

整个链条是：

> **LLM 生成包含工具调用意图的 token** → **供应商 API 层解析并结构化** → **pi-mono provider 代码翻译成统一事件** → **Agent runtime 消费事件并真正执行工具**

那模型是怎么学会"输出工具调用格式"的？这里有两种方式：

**方式一：训练时内化（现代主流方式）**。OpenAI、Anthropic、Google 等主流供应商的模型，在**训练阶段**就已经学会了"当需要调用工具时，输出特定格式的 token"。这不是通过 prompt 注入的，而是模型权重里就包含了这个能力——供应商在训练数据中包含了大量"工具调用"场景的样本，模型学会了当上下文中有 `tools` 定义且用户问题需要调用工具时，生成符合特定格式的 token。这些 token 在供应商的 API 服务层被拦截和解析，不会作为普通文本返回给你。

**方式二：Prompt 注入（早期/开源模型方式）**。早期模型或一些开源模型通过 system prompt 注入类似 `<tool_call>{"name": "read_file", ...}</tool_call>` 的格式指令，然后由外围系统用正则或解析器从输出文本中提取工具调用。

总结一下各层的职责：

| 层次                                | 谁负责                     | 输出什么                           |
| ----------------------------------- | -------------------------- | ---------------------------------- |
| LLM 模型                            | 预测下一个 token           | 一坨 token（字符串片段）           |
| Provider API（OpenAI/Anthropic 等） | 把 token 流包装成 HTTP SSE | 各自格式的 chunk/event             |
| pi-mono provider 实现               | 解析原始 chunk，维护状态机 | **统一的 `AssistantMessageEvent`** |
| Agent runtime / UI                  | 消费统一事件               | 执行工具、显示文本                 |

**一句话总结**：LLM 只管吐字符串，所有结构化的事件都是外围系统"翻译"出来的。`AssistantMessageEvent` 是 pi-mono 的封装层，目的是让上层代码不需要关心"我在和哪个 provider 说话"。

pi-mono 的最底层基本止步于供应商的 SDK 接口，但在 SDK 无法覆盖的场景下（非标准 API 端点），它也会深入到原始 HTTP/SSE/WebSocket 层自己做解析。不过即使是这些手动解析的 provider，它们解析的也是供应商 API 返回的 JSON 事件——并不涉及 LLM 输出的原始 token 流的解析（那一层始终是供应商服务端在做的）。

```
packages/ai 的 provider 实现
├── 大多数 provider：使用官方 SDK → SDK 已解析好结构化对象 → 翻译成 AssistantMessageEvent
│   ├── OpenAI Completions (openai SDK)
│   ├── OpenAI Responses (openai SDK)
│   ├── Anthropic (@anthropic-ai/sdk)
│   ├── Google Gemini (@google/genai)
│   ├── Google Vertex (@google/genai)
│   └── Amazon Bedrock (@aws-sdk)
│
└── 少数 provider：手动 fetch + 自己解析原始 SSE/WebSocket → 翻译成 AssistantMessageEvent
    ├── OpenAI Codex (非标准端点，SDK 不支持)
    └── Google Gemini CLI (Cloud Code Assist 端点，SDK 不支持)
```

## 容易混淆的概念

### Provider vs API

在 pi-mono 中，**provider** 和 **API** 是两个不同的概念：

- **Provider**（提供商）：谁提供模型服务。比如 `openai`、`anthropic`、`google`、`xai`
- **API**：用什么协议和模型通信。比如 `openai-completions`、`anthropic-messages`、`google-generative-ai`

一个 provider 可能使用特定的 API（Anthropic 用 `anthropic-messages`），但多个 provider 也可能共用同一个 API（xAI、Groq、Cerebras 都用 `openai-completions`，因为它们兼容 OpenAI 的接口）。

```typescript
// 这些 provider 用不同的 API
getModel("anthropic", "claude-sonnet-4-20250514"); // api: anthropic-messages
getModel("google", "gemini-2.5-flash"); // api: google-generative-ai

// 这些 provider 共用 openai-completions API
getModel("xai", "grok-3-mini"); // api: openai-completions
getModel("groq", "llama-3.3-70b-versatile"); // api: openai-completions
```

### stream vs complete

- `stream`：返回事件流，适合需要实时反馈的场景
- `complete`：等待完整结果，适合不需要中间状态的场景

`complete` 本质上就是 `stream` + 等待结果。选择哪个取决于你的使用场景，而不是模型能力。

### streamSimple vs stream

pi-mono 还提供了 `streamSimple` 和 `completeSimple`：

- `stream` / `complete`：接受 provider 特定的选项（比如 Anthropic 的 `thinkingBudgetTokens`）
- `streamSimple` / `completeSimple`：接受统一的选项（比如 `reasoning: 'medium'`），由库自动映射到各 provider 的具体参数

如果你不关心 provider 的细节差异，用 `Simple` 版本更方便。如果你需要精细控制某个 provider 的特殊功能，用非 `Simple` 版本。

## 设计后果与权衡

### 统一接口的代价

统一接口意味着取最大公约数。每个 provider 都有独特的功能（OpenAI 的 `store` 字段、Anthropic 的 cache 控制、Google 的 grounding），这些功能要么通过 `compat` 字段暴露，要么通过 provider 特定的选项类型传递。

这带来了一个工程权衡：**通用性 vs 特殊性**。pi-mono 的策略是：

- 通用能力（消息、工具、流式输出）走统一接口
- 特殊能力（provider 特有功能）走类型安全的选项扩展

### 模型注册表的设计

pi-mono 使用一个自动生成的模型注册表（`models.generated.js`），包含所有已知 provider 的所有模型及其元数据。这意味着：

- IDE 可以自动补全 provider 名和 model ID
- 类型系统可以在编译时检查你是否用了正确的 provider-model 组合
- 模型的价格、上下文窗口等信息不需要硬编码

但这也意味着新模型发布后，需要重新运行生成脚本来更新注册表。

## 后续章节预告

本章建立了对 LLM 的基本认知：它是一个基于 token 的文本生成器，有明确的能力边界。

下一章（第 2 章：什么是 Agent）会在此基础上回答一个关键问题：**如果 LLM 只是一个生成器，那怎么让它"做事"？** 答案就是 agent——通过循环、工具和状态管理，把生成器变成能驱动动作的系统。

## 小练习

1. **数 token**：找一段你常写的代码（10-20 行），估算它大约有多少 token。提示：英文大约 1 token ≈ 4 个字符，中文大约 1 token ≈ 1-2 个字符。

   > **关键信息**：以 `packages/ai/src/stream.ts` 中的 `stream` 和 `complete` 函数（约 18 行）为例，估算约 **90-100 个 token**。代码中的符号（`<`, `>`, `(`, `)`, `:`, `{`, `}` 等）通常各占 1 个 token；关键字和标识符（`export`, `function`, `const`）各占 1 个 token；类型名如 `AssistantMessageEventStream` 可能被拆成多个 token。一段很短的代码就能消耗近百 token，这解释了为什么 agent 场景中上下文管理如此重要——system prompt + 对话历史 + 工具定义 + 文件内容很容易达到数万甚至数十万 token。

2. **看模型元数据**：在 `packages/ai/src/models.ts` 中，找到 `getModel` 函数，理解它是如何从注册表中查找模型的。然后调用 `getModels('openai')` 看看 OpenAI 有哪些模型，注意它们的 `contextWindow` 和 `maxTokens` 分别是多少。

   > **关键信息**：`getModel(provider, modelId)` 从自动生成的注册表 `models.generated.js`（一个 `Map<Provider, Map<ModelId, Model>>` 结构）中按 provider 和 modelId 查找模型，找不到则抛出错误。OpenAI 主要模型的参数如下：
   >
   > | 模型                          | contextWindow | maxTokens |
   > | ----------------------------- | :-----------: | :-------: |
   > | gpt-4o                        |    128,000    |  16,384   |
   > | gpt-4o-mini                   |    128,000    |  16,384   |
   > | o1                            |    200,000    |  100,000  |
   > | o3 / o3-mini                  |    200,000    |  100,000  |
   > | o4-mini                       |    200,000    |  100,000  |
   > | gpt-4.1 / 4.1-mini / 4.1-nano |   1,047,576   |  32,768   |
   >
   > 注意 `contextWindow`（总容量）和 `maxTokens`（单次输出上限）差异巨大——128K 上下文的 gpt-4o 单次输出最多 16K，说明大部分空间留给输入。推理模型（o 系列）的 `maxTokens` 更大（65K-100K），因为推理过程需要更多输出空间。gpt-4.1 系列突破了百万 token 上下文窗口。

3. **理解事件流**：阅读 `packages/ai/src/types.ts` 中的 `AssistantMessageEvent` 类型定义，列出所有可能的事件类型，思考每种事件在什么场景下会被触发。

   > **关键信息**：`AssistantMessageEvent` 共有 **8 种事件类型**：
   >
   > | 事件类型         | 触发场景                        | 在 agent 系统中的作用                            |
   > | ---------------- | ------------------------------- | ------------------------------------------------ |
   > | `start`          | 流开始时触发一次                | 初始化 UI、准备接收数据                          |
   > | `text_delta`     | 模型生成文本时，每个 token 触发 | 逐字显示输出，实现打字机效果                     |
   > | `thinking_delta` | 推理模型输出思考过程时触发      | 展示模型的推理链（如 o1、Claude thinking）       |
   > | `toolcall_start` | 模型开始请求调用工具时触发      | 通知 agent runtime 准备执行工具                  |
   > | `toolcall_delta` | 工具调用参数流式到达时触发      | 逐步构建工具调用的参数 JSON                      |
   > | `toolcall_end`   | 工具调用参数接收完毕时触发      | **触发工具执行**——runtime 拿到完整参数后执行工具 |
   > | `done`           | 模型正常结束生成时触发          | 标记本轮结束，进入下一步（执行工具/返回用户）    |
   > | `error`          | 生成过程中出错时触发            | 错误处理——重试、降级或通知用户                   |
   >
   > 这些事件构成了 agent 循环的感知层：UI 层消费 `text_delta` 实时展示；agent runtime 监听 `toolcall_end` 触发工具执行并把结果放回上下文形成循环；控制层监听 `done` 的 `reason` 判断是主动结束还是被截断。模型的输出不是简单字符串，而是**结构化事件流**，这是构建响应式 agent 的基础。

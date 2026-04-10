# 第 8 章：消息格式是 agent 的基础协议

## 前置知识

本章建立在前面章节的基础上。你需要理解：

- LLM 通过上下文窗口接收输入、生成输出（第 1 章）
- Agent 是模型 + 循环 + 工具 + 状态的组合（第 2 章）
- Agent 循环的核心是"推理 → 工具调用 → 工具结果 → 继续推理"（第 3 章）
- 工具调用由 tool schema、tool call、tool result 三部分组成（第 4 章）
- `packages/ai` 通过统一接口屏蔽了不同 provider 的差异（第 7 章）

如果这些概念还不清楚，建议先回顾对应章节。

## 本章聚焦的层次

本章聚焦于 agent 系统中最基础的数据结构——**消息**。消息是模型和外部世界之间唯一的通信方式。模型通过消息接收指令，通过消息输出回复，通过消息请求工具调用，通过消息接收工具结果。

消息格式的设计，直接决定了 agent 能做什么、不能做什么。

在 pi-mono 的分层架构中，本章横跨两个包：

- `packages/ai`：定义了 LLM 层面的三种基础消息类型（`UserMessage`、`AssistantMessage`、`ToolResultMessage`）
- `packages/agent`：在基础消息之上扩展了 `AgentMessage`，支持应用层自定义消息类型

## 为什么消息格式如此重要

在 agent 系统中，所有信息的流动都通过消息。消息不只是"聊天记录"——它是一套协议。

考虑一下 agent 循环中发生的事情：

1. 用户发送一条消息（"帮我读取 config.json"）
2. 这条消息和历史消息一起，作为上下文发送给模型
3. 模型返回一条助手消息，其中包含工具调用请求
4. 工具执行后，结果作为一条工具结果消息加入上下文
5. 上下文再次发送给模型，模型继续推理

每一步都在操作消息。消息的结构决定了：

- **模型能看到什么**：消息中包含哪些字段，模型就能利用哪些信息
- **工具调用怎么关联**：工具调用和工具结果通过 ID 关联，ID 格式不对就会断链
- **跨模型切换是否可行**：不同 provider 对消息格式有不同要求，消息结构要能适配
- **上下文成本怎么控制**：消息中的每个字段都占用 token，冗余字段浪费成本
- **会话能否持久化和恢复**：消息要能序列化存储，也要能反序列化后继续使用

## LLM 层的三种消息类型

在 `packages/ai/src/types.ts` 中，pi-mono 定义了 LLM 能理解的三种消息类型：

```typescript
// packages/ai/src/types.ts
export type Message = UserMessage | AssistantMessage | ToolResultMessage;
```

这三种类型对应了对话中的三个角色。让我们逐一深入。

### UserMessage：用户说的话

```typescript
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number; // Unix timestamp in milliseconds
}
```

`UserMessage` 是最简单的消息类型。它有三个字段：

**role**：固定为 `"user"`，标识这是用户发送的消息。

**content**：消息内容，支持两种格式：

- 纯字符串：`"帮我读取 config.json"`
- 内容块数组：`[{ type: "text", text: "分析这张图片" }, { type: "image", data: "...", mimeType: "image/png" }]`

为什么要支持两种格式？因为纯文本场景下，字符串更简洁；但当用户需要发送图片时，必须用内容块数组。这种设计让简单场景保持简单，复杂场景也能处理。

**timestamp**：消息创建时间。这个字段在 LLM 调用时不会被发送给模型（模型不关心时间戳），但在应用层非常有用——排序、去重、显示时间、会话持久化都需要它。

内容块的类型定义：

```typescript
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string; // provider 特定的元数据
}

export interface ImageContent {
  type: "image";
  data: string; // base64 编码的图片数据
  mimeType: string; // 如 "image/jpeg", "image/png"
}
```

`TextContent` 中的 `textSignature` 是一个可选字段，用于存储 provider 特定的元数据（比如 OpenAI Responses API 的消息 ID）。这个字段在跨 provider 消息转换时会被处理。

`ImageContent` 使用 base64 编码存储图片数据。这意味着图片会直接嵌入消息中，而不是通过 URL 引用。好处是消息自包含，可以直接序列化；代价是消息体积会变大。

### AssistantMessage：模型的回复

```typescript
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: Provider;
  model: string;
  responseId?: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  timestamp: number;
}
```

`AssistantMessage` 是三种消息中最复杂的。它不只是"模型说了什么"，还记录了"模型是怎么说的"。

**content**：内容块数组，可以包含三种类型：

- `TextContent`：模型生成的文本
- `ThinkingContent`：模型的推理过程（thinking/reasoning）
- `ToolCall`：模型请求调用的工具

一条助手消息可以同时包含多种内容块。比如模型可能先输出一段思考过程，然后输出一段文本，最后请求调用两个工具：

```typescript
const message: AssistantMessage = {
  role: "assistant",
  content: [
    { type: "thinking", thinking: "用户想读文件，我需要调用 read_file..." },
    { type: "text", text: "好的，我来帮你读取文件。" },
    {
      type: "toolCall",
      id: "call_1",
      name: "read_file",
      arguments: { path: "config.json" },
    },
    {
      type: "toolCall",
      id: "call_2",
      name: "read_file",
      arguments: { path: "package.json" },
    },
  ],
  // ...其他字段
};
```

**ThinkingContent** 的定义：

```typescript
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string; // 加密签名，用于多轮推理连续性
  redacted?: boolean; // 是否被安全过滤器编辑
}
```

`thinkingSignature` 是一个重要的细节。某些模型（如 OpenAI 的推理模型）会对思考内容进行加密，返回一个不透明的签名。在后续轮次中，这个签名需要原样传回模型，以保持推理的连续性。如果跨模型切换（比如从 OpenAI 切到 Anthropic），这个签名就失效了，需要被丢弃。

`redacted` 标记表示思考内容被安全过滤器编辑过。此时 `thinking` 字段可能为空，但 `thinkingSignature` 中存储了加密的原始内容，仍然需要传回同一模型。

**ToolCall** 的定义：

```typescript
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string; // Google 特有：思考上下文签名
}
```

`id` 是工具调用的唯一标识符，用于将工具调用和工具结果关联起来。这个 ID 由模型（或 provider API）生成，格式因 provider 而异：

- OpenAI Chat Completions：`call_abc123`（较短，字母数字）
- OpenAI Responses：`call_id|item_id`（可能超过 450 个字符，包含 `|` 等特殊字符）
- Anthropic：`toolu_abc123`（匹配 `^[a-zA-Z0-9_-]+$`，最长 64 字符）
- Google Gemini：早期版本没有 ID，需要自己生成

这种 ID 格式的不兼容是跨 provider 消息转换中最棘手的问题之一，后面会详细讨论。

**元数据字段**：

- `api`：使用的 API 类型（如 `"anthropic-messages"`、`"openai-completions"`）
- `provider`：模型提供商（如 `"anthropic"`、`"openai"`）
- `model`：模型 ID（如 `"claude-sonnet-4-20250514"`）
- `responseId`：provider 返回的响应标识符

这些元数据在运行时看起来不起眼，但在跨 provider 消息转换时至关重要。`transformMessages` 函数通过比较 `provider`、`api`、`model` 三个字段来判断一条历史消息是否来自当前模型，从而决定是否需要转换 thinking 块和工具调用 ID。

**usage**：token 使用量和费用统计。

```typescript
export interface Usage {
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

每次模型调用的 token 消耗都记录在这里。这不是可选的装饰——在真实 agent 系统中，成本监控是核心需求。一个失控的 agent 循环可能在几分钟内消耗大量 token。

**stopReason**：模型停止生成的原因。

```typescript
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
```

- `"stop"`：模型主动结束（认为回复完成了）
- `"length"`：达到了 `maxTokens` 限制，被截断
- `"toolUse"`：模型请求了工具调用，等待工具结果
- `"error"`：发生错误（网络、API 限流等）
- `"aborted"`：被用户或程序中断

`stopReason` 直接驱动 agent 循环的控制流：

- `"toolUse"` → 执行工具，把结果加入上下文，继续调用模型
- `"stop"` → 检查是否有 follow-up 消息，没有则结束
- `"error"` / `"aborted"` → 结束循环，发出错误事件
- `"length"` → 模型被截断，可能需要继续或提示用户

### ToolResultMessage：工具执行的结果

```typescript
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

`ToolResultMessage` 是工具执行后产生的消息，它将工具的输出反馈给模型。

**toolCallId**：关联到对应的 `ToolCall.id`。这是工具调用和工具结果之间的纽带。如果这个 ID 不匹配，模型就不知道这个结果对应哪个工具调用，API 会报错。

**toolName**：工具名称。虽然可以通过 `toolCallId` 反查到工具名，但冗余存储让日志和 UI 更方便。

**content**：工具返回给模型的内容。注意这里支持图片——比如截图工具可以返回屏幕截图，模型可以"看到"图片内容。

**details**：结构化的详情数据，泛型参数 `TDetails` 允许每个工具定义自己的详情类型。这个字段**不会**发送给模型——它只用于日志记录和 UI 渲染。这是一个重要的设计决策：

- `content` 进入上下文，占用 token，模型会看到
- `details` 不进入上下文，不占用 token，只给应用层用

比如 `read_file` 工具可能返回：

```typescript
{
  content: [{ type: "text", text: "文件内容..." }],  // 模型看到的
  details: { path: "/config.json", size: 1024, encoding: "utf-8" },  // UI 显示的
}
```

**isError**：标记工具执行是否失败。模型看到 `isError: true` 的结果后，通常会尝试修正参数重试，或者告诉用户出了什么问题。

## 三种消息如何构成对话协议

三种消息类型构成了一个严格的对话协议。在一次典型的 agent 交互中，消息序列遵循特定的模式：

```
UserMessage          → 用户发起请求
AssistantMessage     → 模型回复（可能包含工具调用）
ToolResultMessage    → 工具执行结果（如果有工具调用）
ToolResultMessage    → 工具执行结果（如果有多个工具调用）
AssistantMessage     → 模型根据工具结果继续回复
UserMessage          → 用户追问
AssistantMessage     → 模型回复
...
```

这个序列有几个硬性约束：

**1. ToolResultMessage 必须紧跟在包含 ToolCall 的 AssistantMessage 之后**

如果助手消息请求了工具调用，下一条消息必须是对应的工具结果。不能在中间插入用户消息。这是所有 LLM provider 的共同要求。

**2. 每个 ToolCall 必须有对应的 ToolResultMessage**

如果助手消息包含 3 个工具调用，就必须有 3 条工具结果消息。缺少任何一个，API 都会报错。

pi-mono 的 `transformMessages` 函数专门处理了"孤儿工具调用"的情况——如果历史消息中有工具调用但没有对应的结果（比如因为中断），它会自动插入合成的错误结果：

```typescript
// packages/ai/src/providers/transform-messages.ts
// 如果有未匹配的工具调用，插入合成的错误结果
if (pendingToolCalls.length > 0) {
  for (const tc of pendingToolCalls) {
    if (!existingToolResultIds.has(tc.id)) {
      result.push({
        role: "toolResult",
        toolCallId: tc.id,
        toolName: tc.name,
        content: [{ type: "text", text: "No result provided" }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }
}
```

**3. 错误或中断的助手消息应该被跳过**

如果一条助手消息的 `stopReason` 是 `"error"` 或 `"aborted"`，它可能包含不完整的内容（比如只有推理过程没有实际回复，或者工具调用参数不完整）。把这样的消息发给模型可能导致 API 错误。`transformMessages` 会自动跳过这类消息：

```typescript
// 跳过错误/中断的助手消息
const assistantMsg = msg as AssistantMessage;
if (
  assistantMsg.stopReason === "error" ||
  assistantMsg.stopReason === "aborted"
) {
  continue;
}
```

## 从 LLM Message 到 AgentMessage

LLM 只理解三种消息角色。但在真实的 agent 应用中，你需要更多的消息类型。

### 为什么需要扩展

考虑 `packages/coding-agent` 的场景：

- 用户在终端执行了一条 bash 命令（`! ls -la`），这个命令的输出需要作为上下文告诉模型
- Agent 对历史消息做了压缩（compaction），压缩摘要需要作为消息保存
- 用户从一个会话分支回退，分支摘要需要作为消息保存
- 扩展（extension）注入了自定义消息

这些都不是标准的 `user`/`assistant`/`toolResult` 消息。如果强行塞进这三种类型，代码会变得混乱：

```typescript
// 反面示例：把所有东西都塞进 UserMessage
const bashResult: UserMessage = {
  role: "user",
  content: "[BASH_EXECUTION] ls -la\n...", // 用前缀区分？脆弱
  timestamp: Date.now(),
};
```

### AgentMessage 的设计

pi-mono 的解决方案是在 `packages/agent` 中引入 `AgentMessage` 类型：

```typescript
// packages/agent/src/types.ts

// 应用通过声明合并扩展
export interface CustomAgentMessages {
  // 默认为空
}

// AgentMessage = LLM 消息 + 自定义消息
export type AgentMessage =
  | Message
  | CustomAgentMessages[keyof CustomAgentMessages];
```

应用层通过 TypeScript 的**声明合并**（declaration merging）添加自定义消息类型。以 `packages/coding-agent` 为例：

```typescript
// packages/coding-agent/src/core/messages.ts

// 定义自定义消息类型
export interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  timestamp: number;
  excludeFromContext?: boolean;
}

export interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

export interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string;
  timestamp: number;
}

export interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: T;
  timestamp: number;
}

// 通过声明合并注册到 AgentMessage
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    bashExecution: BashExecutionMessage;
    custom: CustomMessage;
    branchSummary: BranchSummaryMessage;
    compactionSummary: CompactionSummaryMessage;
  }
}
```

声明合并之后，`AgentMessage` 自动变成了：

```typescript
type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

而且是**类型安全**的——TypeScript 编译器知道所有可能的消息类型，你可以用 `switch (message.role)` 做穷举检查。

### convertToLlm：从 AgentMessage 到 LLM Message

LLM 不认识 `bashExecution` 或 `compactionSummary`。在调用模型之前，必须把 `AgentMessage[]` 转换为 `Message[]`。这就是 `convertToLlm` 的职责。

`packages/coding-agent` 的实现：

```typescript
// packages/coding-agent/src/core/messages.ts
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      switch (m.role) {
        case "bashExecution":
          // 排除标记为不进入上下文的消息
          if (m.excludeFromContext) return undefined;
          // 转换为 UserMessage
          return {
            role: "user",
            content: [{ type: "text", text: bashExecutionToText(m) }],
            timestamp: m.timestamp,
          };

        case "custom": {
          // 自定义消息转换为 UserMessage
          const content =
            typeof m.content === "string"
              ? [{ type: "text" as const, text: m.content }]
              : m.content;
          return { role: "user", content, timestamp: m.timestamp };
        }

        case "branchSummary":
          // 分支摘要包装成特定格式的 UserMessage
          return {
            role: "user",
            content: [
              {
                type: "text",
                text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX,
              },
            ],
            timestamp: m.timestamp,
          };

        case "compactionSummary":
          // 压缩摘要包装成特定格式的 UserMessage
          return {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  COMPACTION_SUMMARY_PREFIX +
                  m.summary +
                  COMPACTION_SUMMARY_SUFFIX,
              },
            ],
            timestamp: m.timestamp,
          };

        case "user":
        case "assistant":
        case "toolResult":
          // 标准 LLM 消息直接透传
          return m;

        default:
          return undefined;
      }
    })
    .filter((m) => m !== undefined);
}
```

注意几个设计要点：

**1. 自定义消息通常转换为 UserMessage**。因为 LLM 只有三种角色，而自定义消息大多是"给模型看的额外信息"，放在 `user` 角色最合适。

**2. 有些消息会被过滤掉**。比如 `excludeFromContext: true` 的 bash 执行消息——用户用 `!!` 前缀执行的命令不需要告诉模型。

**3. 转换时会添加结构化标记**。比如压缩摘要用 `<summary>` 标签包裹，让模型知道这是历史摘要而不是用户的新消息。

### 消息转换的完整流程

在 agent 循环中，每次调用模型之前，消息会经过两步转换：

```
AgentMessage[]
    ↓ transformContext()    // 可选：裁剪、注入外部上下文
AgentMessage[]
    ↓ convertToLlm()       // 必须：过滤自定义消息，转换为 LLM 格式
Message[]
    ↓ transformMessages()  // 在 provider 内部：跨 provider 兼容性处理
Provider-specific format
    ↓ 发送给 LLM API
```

这个流程在 `agent-loop.ts` 的 `streamAssistantResponse` 函数中实现：

```typescript
// packages/agent/src/agent-loop.ts
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  // 第一步：transformContext（AgentMessage[] → AgentMessage[]）
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // 第二步：convertToLlm（AgentMessage[] → Message[]）
  const llmMessages = await config.convertToLlm(messages);

  // 构建 LLM 上下文
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  // 调用模型（内部会执行 transformMessages）
  const response = await streamFunction(config.model, llmContext, { ... });
  // ...
}
```

第三步 `transformMessages` 发生在各 provider 的实现内部（如 `openai-completions.ts`、`anthropic.ts`），对上层代码透明。

## 跨 Provider 消息转换

当用户在 agent 运行过程中切换模型（比如从 Claude 切换到 GPT-4o），历史消息中可能包含由不同 provider 生成的助手消息。这些消息需要适配新模型的要求。

`packages/ai/src/providers/transform-messages.ts` 中的 `transformMessages` 函数处理这个问题。

### Thinking 块的处理

不同模型对 thinking 块的处理方式不同：

```typescript
if (block.type === "thinking") {
  // 加密的 thinking 只对同一模型有效
  if (block.redacted) {
    return isSameModel ? block : []; // 跨模型时丢弃
  }

  // 同一模型且有签名：保留（用于推理连续性）
  if (isSameModel && block.thinkingSignature) return block;

  // 空的 thinking 块：丢弃
  if (!block.thinking || block.thinking.trim() === "") return [];

  // 同一模型：保留原样
  if (isSameModel) return block;

  // 跨模型：转换为普通文本
  return { type: "text" as const, text: block.thinking };
}
```

逻辑很清晰：

- **同一模型**：保留 thinking 块原样，包括签名（模型需要签名来维持推理连续性）
- **跨模型**：thinking 内容转为普通文本（新模型可以看到推理过程，但不需要签名）
- **加密/编辑的 thinking**：跨模型时直接丢弃（加密内容对其他模型无意义）

### 工具调用 ID 的归一化

这是跨 provider 消息转换中最棘手的问题。不同 provider 生成的工具调用 ID 格式完全不兼容：

| Provider                | ID 格式                            | 示例                         |
| ----------------------- | ---------------------------------- | ---------------------------- |
| OpenAI Chat Completions | 短字母数字                         | `call_abc123`                |
| OpenAI Responses        | `call_id\|item_id`，可能 450+ 字符 | `call_abc\|resp_item_xyz...` |
| Anthropic               | `^[a-zA-Z0-9_-]+$`，最长 64 字符   | `toolu_01ABC`                |
| Google Gemini           | 各版本不一致                       | 自动生成                     |

如果用户先用 OpenAI Responses API 生成了一条包含工具调用的助手消息，然后切换到 Anthropic，Anthropic API 会拒绝那个 450+ 字符的 ID。

`transformMessages` 通过 `normalizeToolCallId` 回调解决这个问题：

```typescript
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
    // ...
    if (block.type === "toolCall") {
      if (!isSameModel && normalizeToolCallId) {
        const normalizedId = normalizeToolCallId(
          toolCall.id,
          model,
          assistantMsg,
        );
        if (normalizedId !== toolCall.id) {
          toolCallIdMap.set(toolCall.id, normalizedId); // 记录映射
          normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
        }
      }
      return normalizedToolCall;
    }
    // ...
  });
  // ...
}
```

关键设计：`toolCallIdMap` 记录了原始 ID 到归一化 ID 的映射。当后续遇到 `ToolResultMessage` 时，它的 `toolCallId` 也会被同步更新：

```typescript
if (msg.role === "toolResult") {
  const normalizedId = toolCallIdMap.get(msg.toolCallId);
  if (normalizedId && normalizedId !== msg.toolCallId) {
    return { ...msg, toolCallId: normalizedId };
  }
  return msg;
}
```

这保证了工具调用和工具结果的 ID 始终一致，即使经过了归一化。

每个 provider 提供自己的归一化逻辑。比如 OpenAI Completions：

```typescript
// packages/ai/src/providers/openai-completions.ts
const normalizeToolCallId = (id: string): string => {
  // 处理 Responses API 的 pipe 分隔 ID
  if (id.includes("|")) {
    const [callId] = id.split("|");
    return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
  }
  if (model.provider === "openai") return id.length > 40 ? id.slice(0, 40) : id;
  return id;
};
```

### Provider 特有的消息格式差异

即使经过 `transformMessages` 的统一处理，各 provider 在最终构造 API 请求时仍有大量差异需要处理。

**Anthropic 的工具结果合并**：

Anthropic API 要求所有连续的工具结果必须合并到同一条 `user` 消息中：

```typescript
// packages/ai/src/providers/anthropic.ts
} else if (msg.role === "toolResult") {
  const toolResults: ContentBlockParam[] = [];

  // 添加当前工具结果
  toolResults.push({
    type: "tool_result",
    tool_use_id: msg.toolCallId,
    content: convertContentBlocks(msg.content),
    is_error: msg.isError,
  });

  // 向前看，收集所有连续的工具结果
  let j = i + 1;
  while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
    const nextMsg = transformedMessages[j] as ToolResultMessage;
    toolResults.push({ ... });
    j++;
  }
  i = j - 1;  // 跳过已处理的消息

  // 合并为一条 user 消息
  params.push({ role: "user", content: toolResults });
}
```

**OpenAI Completions 的合成助手消息**：

某些 OpenAI 兼容 provider 不允许用户消息直接跟在工具结果后面，需要插入一条合成的助手消息作为桥接：

```typescript
// packages/ai/src/providers/openai-completions.ts
if (
  compat.requiresAssistantAfterToolResult &&
  lastRole === "toolResult" &&
  msg.role === "user"
) {
  params.push({
    role: "assistant",
    content: "I have processed the tool results.",
  });
}
```

**OpenAI Completions 的 thinking 块处理**：

某些 provider 不支持原生的 thinking 块，需要将其转换为带 `<thinking>` 标签的普通文本：

```typescript
if (compat.requiresThinkingAsText) {
  // 将 thinking 块转换为 <thinking>...</thinking> 格式的文本
}
```

这些差异说明了为什么消息格式的设计如此重要——它必须足够灵活，能够适配各种 provider 的特殊要求，同时保持上层代码的统一性。

## 消息的生命周期

一条消息从创建到最终被模型消费，经历了多个阶段。以一条用户消息为例：

```
1. 创建
   用户输入 "帮我读取 config.json"
   → UserMessage { role: "user", content: "帮我读取 config.json", timestamp: Date.now() }

2. 进入 Agent 状态
   agent.state.messages.push(userMessage)
   → 触发 message_start / message_end 事件

3. transformContext
   可能被裁剪（如果历史太长）
   可能被注入额外上下文

4. convertToLlm
   UserMessage 直接透传（不需要转换）

5. transformMessages（provider 内部）
   UserMessage 直接透传（不需要转换）

6. Provider 格式化
   OpenAI: { role: "user", content: "帮我读取 config.json" }
   Anthropic: { role: "user", content: "帮我读取 config.json" }
   Google: { role: "user", parts: [{ text: "帮我读取 config.json" }] }

7. 发送给 LLM API
```

助手消息的生命周期更复杂，因为它是流式构建的：

```
1. 流开始
   → start 事件，创建空的 AssistantMessage

2. 流式填充
   → text_delta / thinking_delta / toolcall_delta 事件
   → AssistantMessage.content 逐步增长

3. 流结束
   → done 事件，AssistantMessage 完成
   → 加入 agent.state.messages

4. 如果包含工具调用
   → 执行工具
   → 创建 ToolResultMessage
   → 加入 agent.state.messages
   → 回到步骤 1（新一轮模型调用）
```

## 设计后果与权衡

### 为什么 content 是数组而不是字符串

`AssistantMessage.content` 是 `(TextContent | ThinkingContent | ToolCall)[]` 而不是简单的字符串。这是因为模型的一次回复可能包含多种类型的内容——先思考，再说话，再调用工具。数组结构让每种内容块都有明确的类型标记，方便 UI 分别渲染（思考过程用灰色折叠，文本正常显示，工具调用用特殊样式）。

代价是处理起来比字符串复杂。如果你只想拿到模型说的文本，需要过滤：

```typescript
const text = message.content
  .filter((b) => b.type === "text")
  .map((b) => b.text)
  .join("");
```

### 为什么 ToolResultMessage 独立于 UserMessage

有些 LLM provider（如 Anthropic）在 API 层面把工具结果放在 `user` 角色的消息中。但 pi-mono 选择让 `ToolResultMessage` 成为独立的消息类型。

原因是语义不同：

- `UserMessage` 是人类用户主动发送的
- `ToolResultMessage` 是程序自动生成的工具执行结果

把它们混在一起会导致：

- 无法区分"用户说的话"和"工具返回的结果"
- `details` 字段无处安放（UserMessage 没有 details）
- `isError` 标记无处安放
- `toolCallId` 关联无处安放

在发送给 provider 时，各 provider 的实现会根据需要把 `ToolResultMessage` 转换为对应的格式（Anthropic 放在 `user` 消息中，OpenAI 用 `tool` 角色）。

### 为什么 timestamp 不发送给模型

`timestamp` 存在于所有消息类型中，但不会作为上下文的一部分发送给模型。这是因为：

1. 模型不需要知道消息的精确时间来完成任务
2. 时间戳会占用 token
3. 模型可能会对时间信息产生不必要的推理（"这条消息是 3 小时前的，可能已经过时了"）

但 timestamp 在应用层不可或缺：消息排序、会话持久化、UI 显示、调试日志都依赖它。

### 为什么 AssistantMessage 携带 provider 元数据

`AssistantMessage` 中的 `api`、`provider`、`model` 字段看起来是冗余的——调用时已经知道用的是哪个模型。但这些字段在以下场景中至关重要：

1. **跨 provider 消息转换**：`transformMessages` 通过比较这些字段判断消息是否来自当前模型
2. **会话持久化和恢复**：恢复会话时，需要知道每条助手消息是哪个模型生成的
3. **成本统计**：不同模型的价格不同，需要知道每条消息用的是哪个模型
4. **调试**：排查问题时，知道每条回复来自哪个模型非常有用

## 后续章节预告

本章深入讨论了消息格式的设计——从 LLM 层的三种基础类型，到 agent 层的扩展机制，再到跨 provider 的兼容性处理。

下一章（第 9 章：流式输出与事件流）会在此基础上讨论消息是如何被**流式构建**的。你会看到 `AssistantMessage` 不是一次性创建的，而是通过一系列事件（`text_delta`、`toolcall_delta` 等）逐步填充的。这个事件流机制是 agent 实时交互的基础。

## 小练习

1. **追踪一条消息的转换路径**：假设 `packages/coding-agent` 中有一条 `BashExecutionMessage`（用户执行了 `! git status`），追踪它从创建到被模型消费的完整路径。它在 `convertToLlm` 中变成了什么？在 Anthropic provider 中又变成了什么格式？

   > **关键信息**：完整路径如下：
   >
   > 1. **创建**：用户在终端输入 `! git status`，coding-agent 执行命令后创建 `BashExecutionMessage`：
   >    ```typescript
   >    {
   >      role: "bashExecution",
   >      command: "git status",
   >      output: "On branch main\nnothing to commit...",
   >      exitCode: 0,
   >      cancelled: false,
   >      truncated: false,
   >      timestamp: 1712345678000,
   >    }
   >    ```
   > 2. **convertToLlm**：`bashExecutionToText()` 将其转换为格式化文本，然后包装成 `UserMessage`：
   >    ````typescript
   >    {
   >      role: "user",
   >      content: [{ type: "text", text: "Ran `git status`\n```\nOn branch main\nnothing to commit...\n```" }],
   >      timestamp: 1712345678000,
   >    }
   >    ````
   > 3. **transformMessages**：`UserMessage` 直接透传，不做任何转换。
   > 4. **Anthropic provider 格式化**：转换为 Anthropic API 的 `MessageParam` 格式：
   >    ````typescript
   >    {
   >      role: "user",
   >      content: "Ran `git status`\n```\nOn branch main\nnothing to commit...\n```",
   >    }
   >    ````
   >    注意 Anthropic 的 `convertContentBlocks` 在只有文本块时会将内容块数组简化为纯字符串。
   >
   > 如果 `excludeFromContext` 为 `true`（用户用 `!!` 前缀执行），`convertToLlm` 会返回 `undefined`，这条消息完全不会进入 LLM 上下文。

2. **设计一个自定义消息类型**：假设你要为 agent 添加一个"网页截图"功能，用户可以让 agent 截取网页并分析。设计一个 `ScreenshotMessage` 类型，思考：它应该包含哪些字段？在 `convertToLlm` 中应该怎么转换？

   > **关键信息**：
   >
   > ```typescript
   > export interface ScreenshotMessage {
   >   role: "screenshot";
   >   url: string; // 截图的网页 URL
   >   imageData: string; // base64 编码的截图数据
   >   mimeType: string; // 如 "image/png"
   >   viewportSize: { width: number; height: number }; // 视口大小
   >   timestamp: number;
   > }
   >
   > declare module "@mariozechner/pi-agent-core" {
   >   interface CustomAgentMessages {
   >     screenshot: ScreenshotMessage;
   >   }
   > }
   > ```
   >
   > 在 `convertToLlm` 中的转换：
   >
   > ```typescript
   > case "screenshot":
   >   return {
   >     role: "user",
   >     content: [
   >       { type: "text", text: `Screenshot of ${m.url} (${m.viewportSize.width}x${m.viewportSize.height}):` },
   >       { type: "image", data: m.imageData, mimeType: m.mimeType },
   >     ],
   >     timestamp: m.timestamp,
   >   };
   > ```
   >
   > 设计要点：
   >
   > - 转换为 `UserMessage`，因为这是"给模型看的输入信息"
   > - 同时包含文本说明和图片内容，让模型知道图片是什么
   > - `url` 和 `viewportSize` 作为文本告诉模型，而不是放在 `details` 中（因为模型需要知道截图来源）
   > - 如果模型不支持图片输入（`model.input` 不包含 `"image"`），provider 层会自动过滤掉图片块，只保留文本说明

3. **理解 ID 归一化**：阅读 `packages/ai/src/providers/transform-messages.ts`，思考：如果没有 `toolCallIdMap` 这个映射机制，跨 provider 切换时会发生什么？

   > **关键信息**：如果没有 `toolCallIdMap`，会出现以下问题：
   >
   > 假设用户先用 OpenAI Responses API，模型生成了一个工具调用，ID 为 `call_abc|resp_item_xyz_very_long_id_450_chars...`。工具执行后，`ToolResultMessage` 的 `toolCallId` 也是这个长 ID。
   >
   > 现在用户切换到 Anthropic。`transformMessages` 会归一化助手消息中的工具调用 ID（比如截断为 `call_abc`）。但如果没有 `toolCallIdMap`，`ToolResultMessage` 的 `toolCallId` 仍然是原始的长 ID。
   >
   > 结果：助手消息中的工具调用 ID 是 `call_abc`，但工具结果中的 ID 是 `call_abc|resp_item_xyz...`——**ID 不匹配**。Anthropic API 会报错："tool_result references unknown tool_use_id"。
   >
   > `toolCallIdMap` 的作用就是在归一化工具调用 ID 的同时，记录映射关系，然后同步更新后续 `ToolResultMessage` 的 `toolCallId`，保证两者始终一致。这是一个典型的"看起来简单但缺了就会崩"的工程细节。

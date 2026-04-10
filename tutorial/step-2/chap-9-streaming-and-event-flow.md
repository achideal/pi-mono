# 第 9 章：流式输出与事件流

## 前置知识

本章建立在前面章节的基础上。你需要理解：

- LLM 的输出是逐 token 生成的，不是一次性返回完整结果（第 1 章）
- Agent 通过循环驱动模型调用和工具执行（第 2、3 章）
- 工具调用是模型输出的一部分，需要被检测和执行（第 4 章）
- 消息格式定义了 agent 系统的通信协议（第 8 章）

如果这些概念还不清楚，建议先回顾对应章节。

## 本章聚焦的层次

本章聚焦于 LLM 接口层和 agent runtime 之间的**事件传递机制**。我们要搞清楚：模型的输出是怎样从"一坨 token"变成结构化事件的，这些事件又是怎样驱动 agent 循环和 UI 渲染的。

在 pi-mono 的分层架构中，本章横跨 `packages/ai`（事件流的生产端）和 `packages/agent`（事件流的消费端）。

## 为什么不能等模型说完再处理

先从一个直觉开始：如果你用 LLM 写一个简单的聊天程序，最朴素的做法是——发送请求，等模型生成完毕，拿到完整回复，显示给用户。

这在简单场景下没问题。但在 agent 场景中，这种"等完再处理"的方式有三个致命问题：

### 问题一：用户体验不可接受

模型生成一段回复可能需要 5-30 秒。如果用户在这段时间里只看到一个加载动画，体验会非常差。

流式输出让用户可以**逐字看到模型的回复**，就像看一个人在实时打字。这不只是"好看"——它让用户可以在模型还没说完的时候就开始理解内容，甚至提前判断方向是否正确。

### 问题二：工具调用检测被延迟

Agent 的核心循环是"模型推理 → 检测工具调用 → 执行工具 → 继续推理"。如果等模型完全生成完毕才开始检测工具调用，那工具执行就被白白延迟了。

流式输出让 agent runtime 可以**在模型还在生成的过程中就检测到工具调用**，提前做好执行准备。虽然 pi-mono 当前的实现是等 `toolcall_end` 事件才真正执行工具（因为需要完整的参数 JSON），但流式事件让 UI 可以提前显示"正在准备调用工具..."，也为未来的提前执行优化留下了空间。

### 问题三：无法中途中断

如果模型正在生成一段很长的、明显错误的回复，用户想要中断它。在"等完再处理"的模式下，你只能等它说完，浪费 token 和时间。

流式输出配合 `AbortSignal`，让用户可以**在任意时刻中断模型生成**，立即停止 token 消耗。

## 两层事件系统

pi-mono 的事件系统分为两层：

```
LLM 层事件（AssistantMessageEvent）
    ↓ 由 packages/ai 的各 provider 生产
    ↓ 由 packages/agent 的 agent-loop 消费
Agent 层事件（AgentEvent）
    ↓ 由 packages/agent 的 agent-loop 生产
    ↓ 由 UI / 日志 / 扩展消费
```

**LLM 层事件**描述的是"模型正在输出什么"——文本片段、思考片段、工具调用片段。

**Agent 层事件**描述的是"agent 正在做什么"——开始新一轮、消息生命周期、工具执行生命周期。

Agent 层事件**包裹**了 LLM 层事件。当 agent-loop 收到一个 `text_delta` 的 LLM 事件时，它会把它包装成一个 `message_update` 的 Agent 事件，附带当前的 `AssistantMessageEvent`，然后发送给外部监听器。

这种两层设计的好处是：

- **UI 层不需要直接和 LLM 打交道**。它只需要监听 Agent 事件，就能知道 agent 的完整状态。
- **Agent 层可以添加 LLM 层没有的事件**。比如 `tool_execution_start`、`turn_end` 这些事件，是 agent runtime 自己产生的，和 LLM 无关。
- **LLM 层可以独立演进**。如果某个 provider 新增了一种事件类型，只需要在 provider 实现中处理，不影响 agent 层的事件协议。

## LLM 层：AssistantMessageEvent

### 12 种事件类型

`AssistantMessageEvent` 定义了 LLM 输出流的完整事件协议：

```typescript
// packages/ai/src/types.ts
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "text_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "text_end";
      contentIndex: number;
      content: string;
      partial: AssistantMessage;
    }
  | { type: "thinking_start"; contentIndex: number; partial: AssistantMessage }
  | {
      type: "thinking_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | {
      type: "thinking_end";
      contentIndex: number;
      content: string;
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
```

这 12 种事件可以分为四组：

**流生命周期**（1 种）：

- `start`：流开始，携带初始的空 `AssistantMessage`

**文本内容**（3 种）：

- `text_start`：一个新的文本块开始
- `text_delta`：文本增量到达，`delta` 是新增的文本片段
- `text_end`：文本块结束，`content` 是完整的文本内容

**思考内容**（3 种）：

- `thinking_start`：一个新的思考块开始
- `thinking_delta`：思考增量到达
- `thinking_end`：思考块结束

**工具调用**（3 种）：

- `toolcall_start`：一个新的工具调用开始
- `toolcall_delta`：工具调用参数的 JSON 片段到达
- `toolcall_end`：工具调用完成，`toolCall` 包含完整的名称和参数

**终止事件**（2 种）：

- `done`：流正常结束
- `error`：流异常结束（错误或中断）

### 事件的时序保证

这些事件有严格的时序约束：

1. `start` 必须是第一个事件
2. 每种内容块（text/thinking/toolcall）遵循 `_start` → `_delta`\* → `_end` 的顺序
3. `done` 或 `error` 必须是最后一个事件，且二者互斥
4. 每个事件都携带 `partial`——当前时刻的 `AssistantMessage` 快照

一个典型的事件序列（模型先输出文本，再调用工具）：

```
start           { partial: { content: [] } }
text_start      { contentIndex: 0 }
text_delta      { contentIndex: 0, delta: "我来帮你" }
text_delta      { contentIndex: 0, delta: "读取这个文件" }
text_end        { contentIndex: 0, content: "我来帮你读取这个文件" }
toolcall_start  { contentIndex: 1 }
toolcall_delta  { contentIndex: 1, delta: '{"path":' }
toolcall_delta  { contentIndex: 1, delta: '"config.json"}' }
toolcall_end    { contentIndex: 1, toolCall: { name: "read_file", arguments: { path: "config.json" } } }
done            { reason: "toolUse", message: { ... } }
```

注意 `contentIndex`——它标识的是 `AssistantMessage.content` 数组中的位置。文本块在 index 0，工具调用在 index 1。这让消费者可以精确地知道每个增量属于哪个内容块。

### partial 的作用

每个事件都携带一个 `partial` 字段，它是当前时刻 `AssistantMessage` 的**累积快照**。

这意味着消费者不需要自己维护状态。如果你只关心"当前模型输出了什么"，直接读 `partial` 就行：

```typescript
for await (const event of stream) {
  if (event.type === "text_delta") {
    // event.delta 是增量
    // event.partial.content[event.contentIndex].text 是到目前为止的完整文本
  }
}
```

`partial` 是一个可变对象——每次事件到来时，provider 代码直接修改同一个 `AssistantMessage` 对象的内容，然后把它作为 `partial` 传出去。这意味着如果你需要保存某个时刻的快照，必须深拷贝。

## EventStream：事件流的基础设施

在深入 provider 实现之前，先看看事件流本身是怎么实现的。

pi-mono 用一个通用的 `EventStream` 类来实现异步事件流：

```typescript
// packages/ai/src/utils/event-stream.ts
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T): void {
    /* ... */
  }
  end(result?: R): void {
    /* ... */
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    /* ... */
  }
  result(): Promise<R> {
    return this.finalResultPromise;
  }
}
```

`EventStream` 的核心设计是**生产者-消费者模式**：

- **生产者**（provider 代码）调用 `push(event)` 往流里放事件
- **消费者**（agent-loop 或用户代码）通过 `for await...of` 从流里取事件
- 如果消费者还没准备好，事件会被**缓冲**在 `queue` 中
- 如果消费者在等待，事件会**直接交付**给等待中的 consumer

这是一个经典的异步队列实现。关键在于 `push` 和 `[Symbol.asyncIterator]` 之间的协调：

```typescript
push(event: T): void {
  if (this.done) return;

  if (this.isComplete(event)) {
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));
  }

  // 有消费者在等？直接交付。没有？放入队列。
  const waiter = this.waiting.shift();
  if (waiter) {
    waiter({ value: event, done: false });
  } else {
    this.queue.push(event);
  }
}

async *[Symbol.asyncIterator](): AsyncIterator<T> {
  while (true) {
    if (this.queue.length > 0) {
      yield this.queue.shift()!;        // 队列有数据，直接取
    } else if (this.done) {
      return;                            // 流已结束，退出
    } else {
      // 队列空且流未结束，等待新事件
      const result = await new Promise<IteratorResult<T>>(
        (resolve) => this.waiting.push(resolve)
      );
      if (result.done) return;
      yield result.value;
    }
  }
}
```

`EventStream` 还提供了 `result()` 方法，返回一个 Promise，在流结束时 resolve 为最终结果。对于 `AssistantMessageEventStream`，最终结果就是完整的 `AssistantMessage`。

`AssistantMessageEventStream` 是 `EventStream` 的特化版本：

```typescript
// packages/ai/src/utils/event-stream.ts
export class AssistantMessageEventStream extends EventStream<
  AssistantMessageEvent,
  AssistantMessage
> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}
```

它告诉 `EventStream`：当收到 `done` 或 `error` 事件时，流就完成了；最终结果从这两种事件中提取 `AssistantMessage`。

这意味着你可以用两种方式消费流：

```typescript
// 方式一：逐事件处理（流式）
const s = stream(model, context);
for await (const event of s) {
  // 处理每个事件
}

// 方式二：只要最终结果（非流式）
const s = stream(model, context);
const message = await s.result();
// 等价于 complete(model, context)
```

`complete` 函数就是方式二的封装：

```typescript
// packages/ai/src/stream.ts
export async function complete<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): Promise<AssistantMessage> {
  const s = stream(model, context, options);
  return s.result();
}
```

## Provider 如何生产事件

每个 provider 的职责是：**把供应商 API 返回的原始流，翻译成统一的 `AssistantMessageEvent` 序列**。

让我们以 Anthropic 和 OpenAI 两个 provider 为例，看看这个翻译过程。

### Anthropic 的事件翻译

Anthropic 的原始流是一系列类型化事件：`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`。

pi-mono 的 Anthropic provider（`packages/ai/src/providers/anthropic.ts`）这样翻译它们：

```typescript
const streamAnthropic: StreamFunction<"anthropic-messages", AnthropicOptions> = (
  model, context, options,
): AssistantMessageEventStream => {
  const stream = new AssistantMessageEventStream();

  (async () => {
    // 1. 初始化空的 AssistantMessage
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      // ... 初始化 usage、stopReason 等
    };

    try {
      // 2. 创建 Anthropic SDK 客户端，发起流式请求
      const anthropicStream = client.messages.stream({ ...params, stream: true });
      stream.push({ type: "start", partial: output });

      // 3. 逐事件翻译
      for await (const event of anthropicStream) {
        if (event.type === "message_start") {
          // 捕获 token 使用量
          output.usage.input = event.message.usage.input_tokens || 0;
          // ...
        } else if (event.type === "content_block_start") {
          if (event.content_block.type === "text") {
            output.content.push({ type: "text", text: "" });
            stream.push({ type: "text_start", contentIndex: ..., partial: output });
          } else if (event.content_block.type === "thinking") {
            output.content.push({ type: "thinking", thinking: "" });
            stream.push({ type: "thinking_start", contentIndex: ..., partial: output });
          } else if (event.content_block.type === "tool_use") {
            output.content.push({ type: "toolCall", id: ..., name: ..., arguments: {} });
            stream.push({ type: "toolcall_start", contentIndex: ..., partial: output });
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            block.text += event.delta.text;
            stream.push({ type: "text_delta", delta: event.delta.text, ... });
          } else if (event.delta.type === "thinking_delta") {
            block.thinking += event.delta.thinking;
            stream.push({ type: "thinking_delta", delta: event.delta.thinking, ... });
          } else if (event.delta.type === "input_json_delta") {
            block.partialJson += event.delta.partial_json;
            block.arguments = parseStreamingJson(block.partialJson);
            stream.push({ type: "toolcall_delta", delta: event.delta.partial_json, ... });
          }
        } else if (event.type === "content_block_stop") {
          // 根据块类型 push 对应的 _end 事件
          if (block.type === "text") {
            stream.push({ type: "text_end", content: block.text, ... });
          } else if (block.type === "toolCall") {
            stream.push({ type: "toolcall_end", toolCall: block, ... });
          }
        } else if (event.type === "message_delta") {
          // 更新 stopReason 和最终 usage
        }
      }

      // 4. 流正常结束
      stream.push({ type: "done", reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      // 5. 流异常结束
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error.message;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;  // 立即返回，异步填充事件
};
```

几个关键细节：

**立即返回，异步填充**。`streamAnthropic` 创建 `AssistantMessageEventStream` 后立即返回，然后在一个 `(async () => { ... })()` 自执行异步函数中填充事件。这意味着调用者拿到流对象后就可以开始消费，不需要等待网络请求完成。

**累积式更新**。每次收到增量事件，provider 代码先更新 `output` 对象（累积文本、参数等），然后把 `output` 作为 `partial` 传出去。这样消费者在任何时刻都能通过 `partial` 看到完整的累积状态。

**JSON 流式解析**。工具调用的参数是 JSON 格式，但它是分片到达的。比如先到 `{"path":` 再到 `"config.json"}`。pi-mono 使用 `parseStreamingJson` 来处理不完整的 JSON——它会尽力解析已到达的部分，对于不完整的值返回合理的默认值。

**错误统一处理**。无论是网络错误、API 错误还是用户中断（`AbortSignal`），都被统一转换为 `error` 事件。这让消费者不需要区分错误来源——它只需要处理 `done` 和 `error` 两种终止状态。

### OpenAI Completions 的事件翻译

OpenAI 的原始流是 `ChatCompletionChunk` 对象序列。和 Anthropic 不同，OpenAI 没有显式的 `content_block_start` / `content_block_stop` 事件——你需要自己维护状态机来判断"新块开始了"还是"旧块在继续"。

pi-mono 的 OpenAI Completions provider（`packages/ai/src/providers/openai-completions.ts`）用一个 `currentBlock` 变量来跟踪当前正在构建的内容块：

```typescript
let currentBlock: TextContent | ThinkingContent | (ToolCall & { partialArgs?: string }) | null = null;

for await (const chunk of openaiStream) {
  const choice = chunk.choices[0];
  if (!choice) continue;

  const delta = choice.delta;

  // 文本增量
  if (delta.content) {
    if (!currentBlock || currentBlock.type !== "text") {
      finishCurrentBlock(currentBlock);  // 结束上一个块
      currentBlock = { type: "text", text: "" };
      blocks.push(currentBlock);
      stream.push({ type: "text_start", ... });
    }
    currentBlock.text += delta.content;
    stream.push({ type: "text_delta", delta: delta.content, ... });
  }

  // 工具调用增量
  if (delta.tool_calls) {
    for (const tc of delta.tool_calls) {
      // 新工具调用开始
      if (tc.function?.name) {
        finishCurrentBlock(currentBlock);
        currentBlock = { type: "toolCall", id: tc.id, name: tc.function.name, arguments: {} };
        blocks.push(currentBlock);
        stream.push({ type: "toolcall_start", ... });
      }
      // 参数增量
      if (tc.function?.arguments) {
        currentBlock.partialArgs += tc.function.arguments;
        currentBlock.arguments = parseStreamingJson(currentBlock.partialArgs);
        stream.push({ type: "toolcall_delta", delta: tc.function.arguments, ... });
      }
    }
  }
}

// 流结束，关闭最后一个块
finishCurrentBlock(currentBlock);
```

对比两个 provider 的实现，可以看到：

| 维度         | Anthropic                           | OpenAI Completions                     |
| ------------ | ----------------------------------- | -------------------------------------- |
| 原始事件粒度 | 细粒度（有显式的 block start/stop） | 粗粒度（只有 delta，需要自己判断边界） |
| 状态管理     | 用 `event.index` 匹配块             | 用 `currentBlock` 变量跟踪             |
| 工具调用参数 | `input_json_delta` 专用事件         | 混在 `delta.tool_calls` 里             |
| 思考内容     | 原生支持 `thinking` 类型            | 部分模型通过 `reasoning_content` 支持  |

但最终，两者都产出**完全相同格式的 `AssistantMessageEvent` 序列**。这就是统一接口层的价值——上层代码完全不需要知道底层用的是哪个 provider。

## Agent 层：从 LLM 事件到 Agent 事件

### streamAssistantResponse：桥接两层事件

`packages/agent/src/agent-loop.ts` 中的 `streamAssistantResponse` 函数是两层事件系统的桥梁。它消费 LLM 层的 `AssistantMessageEvent`，产出 Agent 层的 `AgentEvent`：

```typescript
// packages/agent/src/agent-loop.ts（简化）
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<AssistantMessage> {
  // 1. 转换上下文（AgentMessage[] → Message[]）
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);

  // 2. 调用模型，获取 LLM 事件流
  const response = await streamFunction(config.model, llmContext, {
    ...config,
    signal,
  });

  // 3. 逐事件翻译为 Agent 事件
  let partialMessage: AssistantMessage | null = null;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        // 所有中间事件都包装成 message_update
        partialMessage = event.partial;
        context.messages[context.messages.length - 1] = partialMessage;
        await emit({
          type: "message_update",
          assistantMessageEvent: event, // 原始 LLM 事件被嵌入
          message: { ...partialMessage },
        });
        break;

      case "done":
      case "error":
        const finalMessage = await response.result();
        context.messages[context.messages.length - 1] = finalMessage;
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
    }
  }
}
```

关键设计决策：

**LLM 事件被嵌入而非替换**。`message_update` 事件同时携带了 Agent 层的 `message`（当前完整消息）和 LLM 层的 `assistantMessageEvent`（原始事件）。这让 UI 层可以根据需要选择粒度——如果只想显示文本，看 `message`；如果想区分文本和思考，看 `assistantMessageEvent.type`。

**9 种 LLM 中间事件合并为 1 种 Agent 事件**。`text_start`、`text_delta`、`text_end`、`thinking_start` 等 9 种事件在 Agent 层都变成了 `message_update`。这是有意的简化——Agent 层关心的是"消息在变化"，而不是"哪种内容块在变化"。如果 UI 需要更细的粒度，它可以从 `assistantMessageEvent` 中获取。

**实时更新上下文**。每次收到事件，`streamAssistantResponse` 都会更新 `context.messages` 中的最后一条消息。这意味着如果在流式输出过程中需要中断并检查上下文，上下文中的助手消息是最新的（虽然不完整）。

### Agent 事件的完整协议

Agent 层的事件协议比 LLM 层更丰富，因为它还包含了工具执行和生命周期管理：

```typescript
// packages/agent/src/types.ts
export type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期
  | { type: "turn_start" }
  | {
      type: "turn_end";
      message: AgentMessage;
      toolResults: ToolResultMessage[];
    }
  // 消息生命周期
  | { type: "message_start"; message: AgentMessage }
  | {
      type: "message_update";
      message: AgentMessage;
      assistantMessageEvent: AssistantMessageEvent;
    }
  | { type: "message_end"; message: AgentMessage }
  // 工具执行生命周期
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: any;
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: any;
      partialResult: any;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: any;
      isError: boolean;
    };
```

这些事件形成了三个嵌套的生命周期：

```
agent_start
├── turn_start
│   ├── message_start (user message)
│   ├── message_end
│   ├── message_start (assistant message - streaming)
│   ├── message_update × N
│   ├── message_end
│   ├── tool_execution_start
│   ├── tool_execution_update × N (可选)
│   ├── tool_execution_end
│   ├── message_start (tool result)
│   ├── message_end
│   └── turn_end
├── turn_start (第二轮)
│   ├── message_start (assistant message)
│   ├── message_update × N
│   ├── message_end
│   └── turn_end
└── agent_end
```

**Agent 级别**（`agent_start` → `agent_end`）：一次完整的 agent 运行。从用户发送 prompt 到 agent 完全停止。`agent_end` 携带本次运行产生的所有新消息。

**Turn 级别**（`turn_start` → `turn_end`）：一个 turn 包含一次模型调用和随后的工具执行。一次 agent 运行通常包含多个 turn——模型调用工具后继续推理，就是一个新的 turn。`turn_end` 携带本轮的助手消息和工具结果。

**消息/工具级别**：单条消息或单次工具执行的生命周期。`message_start` / `message_end` 成对出现；`tool_execution_start` / `tool_execution_end` 成对出现。

### Agent 类如何消费事件

`Agent` 类通过 `processEvents` 方法消费 agent-loop 产出的事件，更新内部状态，然后通知外部监听器：

```typescript
// packages/agent/src/agent.ts
private async processEvents(event: AgentEvent): Promise<void> {
  // 1. 先更新内部状态
  switch (event.type) {
    case "message_start":
      this._state.streamingMessage = event.message;
      break;
    case "message_update":
      this._state.streamingMessage = event.message;
      break;
    case "message_end":
      this._state.streamingMessage = undefined;
      this._state.messages.push(event.message);
      break;
    case "tool_execution_start": {
      const pendingToolCalls = new Set(this._state.pendingToolCalls);
      pendingToolCalls.add(event.toolCallId);
      this._state.pendingToolCalls = pendingToolCalls;
      break;
    }
    case "tool_execution_end": {
      const pendingToolCalls = new Set(this._state.pendingToolCalls);
      pendingToolCalls.delete(event.toolCallId);
      this._state.pendingToolCalls = pendingToolCalls;
      break;
    }
    // ...
  }

  // 2. 再通知所有监听器
  for (const listener of this.listeners) {
    await listener(event, signal);
  }
}
```

几个值得注意的设计细节：

**不可变更新模式**。`pendingToolCalls` 每次都创建新的 `Set`，而不是直接 `add` / `delete`。这是为了让外部代码（比如 React UI）能通过引用比较检测到状态变化。如果直接修改原 Set，`state.pendingToolCalls === oldState.pendingToolCalls` 永远为 `true`，UI 不会重渲染。

**先更新状态，再通知监听器**。这保证了监听器被调用时，`state` 已经是最新的。监听器可以安全地读取 `agent.state` 来获取当前状态。

**监听器是 await 的**。每个监听器都被 `await`，意味着监听器可以做异步操作（比如保存会话到磁盘），agent 会等待这些操作完成后才继续。这在 `agent_end` 事件中特别重要——确保持久化操作完成后 agent 才标记为空闲。

## 流式输出的工程挑战

### 挑战一：JSON 流式解析

工具调用的参数是 JSON 格式，但 JSON 是分片到达的。比如：

```
第 1 片: {"path":
第 2 片: "config
第 3 片: .json","li
第 4 片: mit":10}
```

在第 1 片到达时，`{"path":` 不是合法的 JSON。但 UI 可能想提前显示"正在调用 read_file，参数：path = ..."。

pi-mono 使用 `parseStreamingJson` 来处理这个问题。它会尽力解析不完整的 JSON，对于截断的字符串值返回已到达的部分，对于缺失的值返回合理的默认值。这让 UI 可以在参数还没完全到达时就开始显示部分信息。

### 挑战二：中断处理

当用户调用 `agent.abort()` 时，需要干净地中断整个流式链路：

```
用户调用 abort()
  → AbortController.abort()
    → AbortSignal 传播到 provider
      → provider 取消 HTTP 请求
        → 原始流抛出错误
          → provider catch 错误，push error 事件
            → agent-loop 收到 error，emit agent_end
              → Agent 类清理状态
```

关键是 `AbortSignal` 的传播。它从 `Agent` 类一路传递到 provider 的 HTTP 请求：

```typescript
// Agent 类创建 AbortController
const abortController = new AbortController();

// 传递给 agent-loop
await runAgentLoop(messages, context, config, emit, abortController.signal);

// agent-loop 传递给 streamFunction
const response = await streamFunction(config.model, llmContext, {
  ...config,
  signal,
});

// provider 传递给 HTTP 客户端
const anthropicStream = client.messages.stream(params, {
  signal: options?.signal,
});
```

当 `abort()` 被调用时，整条链路上的所有异步操作都会被取消。provider 的 `catch` 块会检测到 `signal.aborted`，把 `stopReason` 设为 `"aborted"` 而不是 `"error"`，让上层代码能区分"用户主动中断"和"真正的错误"。

### 挑战三：背压控制

如果 provider 产出事件的速度快于消费者处理的速度，会发生什么？

在 pi-mono 的设计中，`EventStream` 的 `push` 方法是同步的——它不会等待消费者处理完毕。多余的事件会被缓冲在 `queue` 中。

但在 agent-loop 中，事件消费是 `await` 的：

```typescript
for await (const event of response) {
  // 每个事件都被 await 处理
  await emit({ type: "message_update", ... });
}
```

`emit` 函数最终会调用 `Agent.processEvents`，它会 `await` 所有监听器。这意味着如果某个监听器很慢（比如写磁盘），整个事件处理链路都会被阻塞。

这是一个有意的设计权衡：

- **优点**：保证事件处理的顺序性，不会出现"后面的事件先处理完"的情况
- **缺点**：慢监听器会拖慢整个 agent 循环

在实践中，这通常不是问题，因为 LLM 的生成速度（几十到几百 token/秒）远低于本地代码的处理速度。但如果你的监听器需要做耗时操作（比如网络请求），应该考虑把它放到后台执行，而不是在监听器中 `await`。

## stream vs streamSimple

pi-mono 提供了两套流式 API：

```typescript
// 精确控制版——接受 provider 特定的选项
export function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: ProviderStreamOptions,
): AssistantMessageEventStream {
  const provider = resolveApiProvider(model.api);
  return provider.stream(model, context, options as StreamOptions);
}

// 简化版——接受统一的选项，自动映射到各 provider
export function streamSimple<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const provider = resolveApiProvider(model.api);
  return provider.streamSimple(model, context, options);
}
```

区别在于选项类型：

- `stream` 接受 `ProviderStreamOptions`（`StreamOptions` + 任意额外字段）。你可以传入 Anthropic 的 `thinkingBudgetTokens`、OpenAI 的 `reasoningEffort` 等 provider 特有的选项。
- `streamSimple` 接受 `SimpleStreamOptions`，其中 `reasoning` 字段是统一的 `ThinkingLevel`（`"minimal"` | `"low"` | `"medium"` | `"high"` | `"xhigh"`）。库会自动把它映射到各 provider 的具体参数。

Agent 层默认使用 `streamSimple`，因为 agent 不应该关心底层 provider 的细节。如果你需要精细控制，可以通过 `Agent` 的 `streamFn` 选项注入自定义的流函数。

## 设计后果与权衡

### 为什么事件是 push 模式而不是 pull 模式

`EventStream` 使用 push 模式——provider 主动 `push` 事件，消费者被动接收。另一种选择是 pull 模式——消费者主动请求下一个事件。

Push 模式的优势在于：provider 可以按照自己的节奏产出事件，不需要等待消费者。这和 HTTP SSE（Server-Sent Events）的语义天然匹配——服务器推送事件，客户端接收。

但 push 模式需要缓冲机制来处理速度不匹配。`EventStream` 的 `queue` 就是这个缓冲区。

### 为什么 partial 是可变对象

每个事件的 `partial` 都指向同一个 `AssistantMessage` 对象。这意味着如果你保存了一个早期事件的 `partial` 引用，它的内容会随着后续事件的到来而变化。

这是一个性能优化——避免每个事件都创建新的 `AssistantMessage` 对象。在高频事件（每秒几十到几百个 `text_delta`）的场景下，对象创建的开销不可忽视。

代价是：如果你需要保存某个时刻的快照，必须手动深拷贝。`Agent` 类在 `processEvents` 中就是这样做的——`{ ...partialMessage }` 创建了一个浅拷贝。

### 为什么 agent-loop 的 emit 是 await 的

Agent-loop 的 `emit` 函数是异步的，而且每次调用都被 `await`：

```typescript
await emit({ type: "message_update", ... });
```

这意味着事件处理是**串行**的——前一个事件的所有监听器处理完毕后，才会处理下一个事件。

另一种选择是"fire and forget"——`emit` 不 `await`，事件处理和事件产出并行进行。这会更快，但会引入竞态条件：`agent_end` 的监听器可能还没执行完，agent 就已经标记为空闲了。

pi-mono 选择了安全性优先：保证事件处理的顺序性和完整性，代价是可能的延迟。

## 后续章节预告

本章深入了流式输出和事件流的实现机制。你现在应该理解了：

- 为什么 agent 需要流式输出而不是等待完整结果
- `EventStream` 如何实现异步生产者-消费者模式
- Provider 如何把各自格式的原始流翻译成统一事件
- Agent 层如何在 LLM 事件之上构建更丰富的生命周期事件

下一章（第 10 章：Schema、校验与结构化参数）会聚焦于工具调用中的另一个关键环节——参数的定义、校验和结构化。你会看到为什么"不校验的工具调用在工程里一定会变脆"，以及 pi-mono 如何用 TypeBox schema 来保证工具参数的类型安全。

## 小练习

1. **追踪一个 text_delta 的完整路径**：从 Anthropic API 返回的原始 `content_block_delta` 事件开始，追踪它如何变成 `AssistantMessageEvent.text_delta`，再变成 `AgentEvent.message_update`，最终被 `Agent.processEvents` 消费并更新 `state.streamingMessage`。画出完整的调用链。

   > **关键信息**：完整路径如下：
   >
   > ```
   > Anthropic API 返回 SSE 事件
   >   → Anthropic SDK 解析为 { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } }
   >     → anthropic.ts 的 for-await 循环捕获事件
   >       → 更新 output.content[index].text += "Hello"
   >       → stream.push({ type: "text_delta", contentIndex: index, delta: "Hello", partial: output })
   >         → EventStream.push() 将事件交付给等待中的消费者
   >           → agent-loop.ts 的 streamAssistantResponse 中 for-await 循环收到事件
   >             → 更新 context.messages[last] = event.partial
   >             → await emit({ type: "message_update", assistantMessageEvent: event, message: {...partialMessage} })
   >               → Agent.processEvents() 被调用
   >                 → this._state.streamingMessage = event.message（状态更新）
   >                 → for (const listener of this.listeners) await listener(event, signal)（通知 UI）
   > ```
   >
   > 关键观察：这条路径跨越了 4 个层次（Anthropic SDK → provider 实现 → agent-loop → Agent 类），每一层都做了自己的翻译和状态更新。整条链路是同步阻塞的——每个 `await` 都会等待下游处理完毕后才继续处理下一个事件。

2. **理解 EventStream 的缓冲机制**：假设 provider 在 1ms 内连续 push 了 10 个 `text_delta` 事件，但消费者的 `for await` 循环每次迭代需要 5ms（因为 `emit` 要 await 监听器）。描述这 10 个事件是如何被处理的——哪些被直接交付，哪些被缓冲？

   > **关键信息**：
   >
   > - 第 1 个事件：消费者正在等待（`this.waiting` 中有一个 resolver），直接交付，消费者开始处理（耗时 5ms）
   > - 第 2-10 个事件：消费者正在处理第 1 个事件，`this.waiting` 为空，这 9 个事件被放入 `this.queue` 缓冲
   > - 5ms 后，消费者处理完第 1 个事件，进入下一次迭代，从 `queue` 中取出第 2 个事件（同步 yield，无需等待）
   > - 处理第 2 个事件（5ms），然后取第 3 个...以此类推
   > - 总耗时约 50ms（10 × 5ms），而不是 10ms（如果并行处理的话）
   >
   > 这说明 `EventStream` 的缓冲机制保证了事件不会丢失，但处理是严格串行的。如果监听器很慢，会形成"事件积压"——queue 中的事件越来越多。在实践中，LLM 的生成速度（约 50-100 token/秒，即每 10-20ms 一个事件）通常远慢于本地处理速度，所以积压很少发生。

3. **对比两种消费方式**：写两段伪代码，分别用 `stream` + `for await` 和 `complete` 来调用模型。思考：在什么场景下你会选择 `complete` 而不是 `stream`？

   > **关键信息**：
   >
   > ```typescript
   > // 方式一：流式消费
   > const s = stream(model, context);
   > for await (const event of s) {
   >   if (event.type === "text_delta") {
   >     process.stdout.write(event.delta); // 逐字显示
   >   }
   >   if (event.type === "toolcall_end") {
   >     console.log(`Tool call: ${event.toolCall.name}`); // 实时检测工具调用
   >   }
   > }
   >
   > // 方式二：一次性获取结果
   > const message = await complete(model, context);
   > console.log(message.content); // 一次性显示全部内容
   > ```
   >
   > 选择 `complete` 的场景：
   >
   > - **批处理任务**：不需要实时反馈，比如批量翻译 100 个文件
   > - **内部调用**：agent 内部的辅助模型调用（比如用小模型做摘要），结果不需要展示给用户
   > - **测试代码**：单元测试中验证模型输出，不关心中间过程
   > - **简单脚本**：一次性脚本，不需要 UI 交互
   >
   > 在 agent 的主循环中，几乎总是使用 `stream`，因为需要实时检测工具调用、支持中断、提供用户反馈。

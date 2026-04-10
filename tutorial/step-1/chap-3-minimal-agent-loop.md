# 第 3 章：Agent 的最小闭环

## 前置知识

本章建立在前两章的基础上。你需要理解：

- LLM 是一个基于 token 的文本生成器，本身不能执行任何外部动作（第 1 章）
- Agent = 模型 + 循环 + 工具 + 状态（第 2 章）
- Agent 通过双层循环驱动：内层处理工具调用和 steering，外层处理 follow-up（第 2 章）
- 模型的输出是事件流（`text_delta`、`toolcall_end`、`done` 等），不是一个完整字符串（第 1 章）

如果这些概念还不清楚，建议先回顾前两章。

## 本章聚焦的层次

本章聚焦于 agent 循环的**一次完整执行**——从用户发出一条消息，到 agent 完成所有工作并停下来。我们要用一个最小的例子，逐步走完整个闭环，看清楚每一步在代码中是怎么发生的。

在 pi-mono 的分层架构中，本章横跨 `packages/ai`（模型调用）和 `packages/agent`（循环控制），重点在两者的交界处——agent 如何消费模型的事件流，如何决定"继续"还是"停止"。

## 什么是"最小闭环"

Agent 的最小闭环是指：

> **用户消息 → 模型推理 → 工具调用 → 工具执行 → 结果喂回模型 → 模型继续推理 → 最终回复**

这是所有 agent 形态的共同骨架。无论是 coding agent、Slack bot 还是自动化助手，底层都在重复这个循环。

用一个具体场景来说明。用户说："帮我看看 `package.json` 里的 `name` 字段是什么。"

Agent 的执行过程：

1. 用户消息进入上下文
2. 模型看到消息和可用工具列表，决定调用 `read_file` 工具
3. Agent runtime 执行 `read_file`，读取 `package.json` 的内容
4. 执行结果作为 `toolResult` 消息加入上下文
5. 模型看到文件内容，提取 `name` 字段，生成最终回复
6. 模型不再请求工具调用，循环结束

这个过程涉及**两次模型调用**（第一次产生工具调用，第二次产生最终回复）和**一次工具执行**。这就是最小闭环——再少一步都不完整。

## 从代码层面走一遍闭环

现在我们从代码层面，逐步追踪这个闭环是怎么发生的。

### 第一步：用户发起 prompt

一切从 `Agent.prompt()` 开始：

```typescript
const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    tools: [readFileTool],
  },
});

await agent.prompt("帮我看看 package.json 里的 name 字段是什么");
```

`prompt()` 方法做了什么？它把用户输入转换成标准的 `UserMessage`，然后启动 agent 循环：

```typescript
// packages/agent/src/agent.ts（简化）
async prompt(input: string | AgentMessage | AgentMessage[]): Promise<void> {
  const messages = this.normalizePromptInput(input);
  await this.runPromptMessages(messages);
}
```

`normalizePromptInput` 把字符串转换成 `UserMessage`：

```typescript
private normalizePromptInput(input: string): AgentMessage[] {
  const content = [{ type: "text", text: input }];
  return [{ role: "user", content, timestamp: Date.now() }];
}
```

然后 `runPromptMessages` 调用底层的 `runAgentLoop`：

```typescript
private async runPromptMessages(messages: AgentMessage[]): Promise<void> {
  await this.runWithLifecycle(async (signal) => {
    await runAgentLoop(
      messages,
      this.createContextSnapshot(),
      this.createLoopConfig(),
      (event) => this.processEvents(event),
      signal,
      this.streamFn,
    );
  });
}
```

注意这里的几个关键参数：

- `messages`：用户消息数组
- `this.createContextSnapshot()`：当前上下文的快照（包含 systemPrompt、历史消息、工具列表）
- `this.createLoopConfig()`：循环配置（包含 `convertToLlm`、`transformContext`、`beforeToolCall` 等）
- `(event) => this.processEvents(event)`：事件处理回调
- `signal`：中断信号

### 第二步：进入 agent 循环

`runAgentLoop` 是底层循环的入口。它做三件事：

1. 把用户消息加入上下文
2. 发出生命周期事件
3. 进入主循环

```typescript
// packages/agent/src/agent-loop.ts（简化）
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}
```

此时上下文中包含：

- `systemPrompt`："You are a helpful assistant."
- `messages`：`[{ role: "user", content: "帮我看看 package.json 里的 name 字段是什么" }]`
- `tools`：`[readFileTool]`

### 第三步：主循环的第一次迭代

进入 `runLoop`，这是第 2 章介绍过的双层循环：

```typescript
async function runLoop(
  currentContext,
  newMessages,
  config,
  signal,
  emit,
  streamFn,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  while (true) {
    // 外层循环
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      // 内层循环
      // ...
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
        streamFn,
      );
      // ...
    }
    // ...
  }
}
```

第一次进入内层循环时，没有 pending messages（用户没有在 agent 启动前插话），所以直接调用 `streamAssistantResponse`。

### 第四步：调用模型（第一次）

`streamAssistantResponse` 是 agent 循环和 LLM 的交界处。它做三件事：

1. **转换上下文**：`AgentMessage[]` → `Message[]`
2. **调用模型**：发送请求，获取事件流
3. **消费事件流**：逐个处理事件，更新上下文

```typescript
async function streamAssistantResponse(
  context,
  config,
  signal,
  emit,
  streamFn,
): Promise<AssistantMessage> {
  // 1. 转换上下文
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }
  const llmMessages = await config.convertToLlm(messages);

  // 2. 构建 LLM 上下文
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  // 3. 调用模型
  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  // 4. 消费事件流
  for await (const event of response) {
    switch (event.type) {
      case "start":
        // 模型开始输出
        break;
      case "text_delta":
      case "toolcall_delta":
        // 流式更新
        break;
      case "done":
      case "error":
        // 流结束，返回最终消息
        return finalMessage;
    }
  }
}
```

在我们的场景中，模型看到了：

- 系统提示词："You are a helpful assistant."
- 用户消息："帮我看看 package.json 里的 name 字段是什么"
- 可用工具：`read_file`（接受 `path` 参数）

模型判断需要读取文件，于是生成一个工具调用请求。事件流大致是：

```
start → text_delta("好的") → toolcall_start → toolcall_delta('{"path":') →
toolcall_delta('"package.json"}') → toolcall_end({ name: "read_file", arguments: { path: "package.json" } }) → done
```

`streamAssistantResponse` 返回的 `AssistantMessage` 包含：

```typescript
{
  role: "assistant",
  content: [
    { type: "text", text: "好的，我来帮你查看。" },
    { type: "toolCall", id: "call_abc", name: "read_file", arguments: { path: "package.json" } }
  ],
  stopReason: "toolUse",
  // ...
}
```

注意 `stopReason` 是 `"toolUse"`——这告诉循环"模型还没说完，它在等工具结果"。

### 第五步：检测工具调用

回到 `runLoop`，模型响应返回后，循环检查是否有工具调用：

```typescript
const toolCalls = message.content.filter((c) => c.type === "toolCall");
hasMoreToolCalls = toolCalls.length > 0;
```

在我们的场景中，`toolCalls` 包含一个 `read_file` 调用，所以 `hasMoreToolCalls = true`。

### 第六步：执行工具

循环调用 `executeToolCalls` 执行工具：

```typescript
if (hasMoreToolCalls) {
  toolResults.push(
    ...(await executeToolCalls(currentContext, message, config, signal, emit)),
  );

  for (const result of toolResults) {
    currentContext.messages.push(result);
    newMessages.push(result);
  }
}
```

`executeToolCalls` 的执行流程（以默认的并行模式为例）：

1. **发出 `tool_execution_start` 事件**：通知 UI "正在执行 read_file"
2. **准备工具调用**（`prepareToolCall`）：
   - 查找工具定义：在 `context.tools` 中找到 `read_file`
   - 验证参数：用 schema 校验 `{ path: "package.json" }` 是否合法
   - 执行 `beforeToolCall` 钩子：检查是否需要拦截（比如危险操作需要用户确认）
3. **执行工具**（`executePreparedToolCall`）：调用 `readFileTool.execute("call_abc", { path: "package.json" })`
4. **后处理**（`finalizeExecutedToolCall`）：执行 `afterToolCall` 钩子，可以修改结果
5. **发出 `tool_execution_end` 事件**：通知 UI 工具执行完毕

工具执行的结果被包装成 `ToolResultMessage`：

```typescript
{
  role: "toolResult",
  toolCallId: "call_abc",
  toolName: "read_file",
  content: [{ type: "text", text: '{ "name": "my-project", "version": "1.0.0", ... }' }],
  isError: false,
  timestamp: 1712345678000,
}
```

这条消息被加入上下文。此时上下文中的消息序列是：

```
[UserMessage] → [AssistantMessage(含 toolCall)] → [ToolResultMessage]
```

### 第七步：内层循环的第二次迭代

`turn_end` 事件发出后，内层循环检查条件：

- `hasMoreToolCalls`：上一轮有工具调用，所以仍然是 `true`（循环会继续）
- `pendingMessages`：检查 steering 队列，没有新消息

等等——`hasMoreToolCalls` 为什么还是 `true`？因为它记录的是**上一轮**是否有工具调用。循环的逻辑是：只要上一轮有工具调用，就再调用一次模型，让模型看到工具结果后决定下一步。

### 第八步：调用模型（第二次）

再次进入 `streamAssistantResponse`。这次上下文中包含：

- 系统提示词
- 用户消息："帮我看看 package.json 里的 name 字段是什么"
- 助手消息（含工具调用）
- 工具结果：`package.json` 的内容

模型看到文件内容后，提取 `name` 字段，生成最终回复：

```typescript
{
  role: "assistant",
  content: [
    { type: "text", text: "package.json 的 name 字段是 \"my-project\"。" }
  ],
  stopReason: "stop",
  // ...
}
```

注意 `stopReason` 是 `"stop"`——模型认为任务完成了，没有更多工具调用。

### 第九步：循环结束

回到 `runLoop`，检查工具调用：

```typescript
const toolCalls = message.content.filter((c) => c.type === "toolCall");
hasMoreToolCalls = toolCalls.length > 0; // false
```

没有工具调用了。`turn_end` 事件发出后，内层循环检查条件：

- `hasMoreToolCalls`：`false`
- `pendingMessages`：检查 steering 队列，没有新消息

两个条件都不满足，内层循环退出。

然后外层循环检查 follow-up 队列：

```typescript
const followUpMessages = (await config.getFollowUpMessages?.()) || [];
if (followUpMessages.length > 0) {
  pendingMessages = followUpMessages;
  continue;
}
break;
```

没有 follow-up 消息，外层循环也退出。

最后发出 `agent_end` 事件，整个闭环完成。

## 完整的事件序列

把上面的过程用事件序列表示：

```
agent_start
├─ turn_start                                          ← 第一个 turn 开始
│  ├─ message_start  { userMessage }                   ← 用户消息
│  ├─ message_end    { userMessage }
│  ├─ message_start  { assistantMessage: 开始流式输出 } ← 模型第一次回复
│  ├─ message_update { text_delta: "好的，我来帮你查看。" }
│  ├─ message_update { toolcall_start }
│  ├─ message_update { toolcall_delta: '{"path":"package.json"}' }
│  ├─ message_update { toolcall_end: read_file }
│  ├─ message_end    { assistantMessage }
│  ├─ tool_execution_start { read_file }               ← 工具执行
│  ├─ tool_execution_end   { result: 文件内容 }
│  ├─ message_start  { toolResultMessage }             ← 工具结果
│  ├─ message_end    { toolResultMessage }
│  └─ turn_end                                         ← 第一个 turn 结束
├─ turn_start                                          ← 第二个 turn 开始
│  ├─ message_start  { assistantMessage: 开始流式输出 } ← 模型第二次回复
│  ├─ message_update { text_delta: "package.json 的 name 字段是..." }
│  ├─ message_end    { assistantMessage }
│  └─ turn_end                                         ← 第二个 turn 结束
└─ agent_end                                           ← 循环结束
```

两个 turn，两次模型调用，一次工具执行。这就是最小闭环的完整事件序列。

## 循环终止的条件

理解了闭环之后，一个自然的问题是：**循环什么时候停下来？**

在 pi-mono 中，循环终止有三种情况：

### 1. 模型不再请求工具调用（正常结束）

这是最常见的情况。模型认为任务完成了，回复中不包含 `toolCall` 内容块，`stopReason` 为 `"stop"`。

```typescript
const toolCalls = message.content.filter((c) => c.type === "toolCall");
hasMoreToolCalls = toolCalls.length > 0; // false → 循环退出
```

### 2. 模型返回错误或被中断

如果模型调用失败（网络错误、API 限流等），或者用户调用了 `agent.abort()`，`streamAssistantResponse` 返回的消息会有 `stopReason` 为 `"error"` 或 `"aborted"`：

```typescript
if (message.stopReason === "error" || message.stopReason === "aborted") {
  await emit({ type: "turn_end", message, toolResults: [] });
  await emit({ type: "agent_end", messages: newMessages });
  return; // 直接退出，不再继续
}
```

### 3. 模型输出被截断（length）

如果模型的输出超过了 `maxTokens` 限制，`stopReason` 会是 `"length"`。在当前实现中，这不会导致循环立即退出——如果截断的输出中包含工具调用，循环仍然会尝试执行。但如果截断导致工具调用参数不完整（JSON 解析失败），工具执行会返回错误结果，模型在下一轮可能会重试或放弃。

## 上下文是怎么一步步增长的

理解闭环的另一个关键视角是：**上下文在每一步是怎么变化的**。

```
初始状态：
  messages: []

用户发送 prompt 后：
  messages: [UserMessage]

模型第一次回复后：
  messages: [UserMessage, AssistantMessage(含 toolCall)]

工具执行后：
  messages: [UserMessage, AssistantMessage(含 toolCall), ToolResultMessage]

模型第二次回复后：
  messages: [UserMessage, AssistantMessage(含 toolCall), ToolResultMessage, AssistantMessage(最终回复)]
```

每次模型调用时，**整个消息数组**（经过 `transformContext` 和 `convertToLlm` 处理后）都会作为上下文发送给模型。这意味着：

- 模型在第二次调用时，能看到自己第一次的回复和工具结果
- 上下文会随着对话进行不断增长
- 如果不做裁剪，最终会撑满上下文窗口

这就是为什么第 5 章会专门讨论上下文管理——它是 agent 能否长期稳定工作的关键。

## 多工具调用的闭环

上面的例子只涉及一个工具调用。但模型可以在一次回复中请求多个工具调用。

假设用户说："帮我同时看看 `package.json` 和 `tsconfig.json` 的内容。"

模型可能生成：

```typescript
{
  role: "assistant",
  content: [
    { type: "text", text: "好的，我来同时读取这两个文件。" },
    { type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "package.json" } },
    { type: "toolCall", id: "call_2", name: "read_file", arguments: { path: "tsconfig.json" } }
  ],
  stopReason: "toolUse",
}
```

在默认的并行执行模式下，`executeToolCallsParallel` 会：

1. **顺序准备**：逐个验证参数、执行 `beforeToolCall`
2. **并发执行**：所有通过检查的工具同时执行
3. **按原始顺序返回**：结果按工具调用在助手消息中的顺序排列

```typescript
// packages/agent/src/agent-loop.ts（简化）
async function executeToolCallsParallel(
  currentContext, assistantMessage, toolCalls, config, signal, emit
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];
  const runnableCalls: PreparedToolCall[] = [];

  // 顺序准备
  for (const toolCall of toolCalls) {
    const preparation = await prepareToolCall(...);
    if (preparation.kind === "immediate") {
      results.push(/* 错误结果 */);
    } else {
      runnableCalls.push(preparation);
    }
  }

  // 并发执行
  const runningCalls = runnableCalls.map((prepared) => ({
    prepared,
    execution: executePreparedToolCall(prepared, signal, emit),
  }));

  // 按顺序收集结果
  for (const running of runningCalls) {
    const executed = await running.execution;
    results.push(await finalizeExecutedToolCall(...));
  }

  return results;
}
```

为什么准备阶段是顺序的？因为 `beforeToolCall` 钩子可能有副作用（比如弹出确认对话框），顺序执行更可预测。

为什么执行阶段是并发的？因为两个 `read_file` 调用之间没有依赖关系，并发执行可以节省时间。

为什么结果按原始顺序返回？因为模型期望工具结果的顺序和它请求的顺序一致。如果顺序乱了，模型可能会混淆哪个结果对应哪个调用。

## 闭环中的错误处理

真实场景中，闭环的每一步都可能出错。pi-mono 的处理策略是：**把错误当成正常的工具结果喂回模型，让模型决定怎么办**。

### 工具未找到

如果模型请求了一个不存在的工具：

```typescript
const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
if (!tool) {
  return {
    kind: "immediate",
    result: createErrorToolResult(`Tool ${toolCall.name} not found`),
    isError: true,
  };
}
```

错误信息作为 `ToolResultMessage`（`isError: true`）返回给模型。模型看到后，通常会换一种方式完成任务。

### 参数验证失败

如果模型生成的参数不符合 schema：

```typescript
try {
  const validatedArgs = validateToolArguments(tool, preparedToolCall);
  // ...
} catch (error) {
  return {
    kind: "immediate",
    result: createErrorToolResult(error.message),
    isError: true,
  };
}
```

同样作为错误结果返回。模型通常会修正参数重试。

### 工具执行失败

如果工具的 `execute` 函数抛出异常：

```typescript
try {
  const result = await prepared.tool.execute(
    prepared.toolCall.id,
    prepared.args,
    signal,
    onUpdate,
  );
  return { result, isError: false };
} catch (error) {
  return {
    result: createErrorToolResult(error.message),
    isError: true,
  };
}
```

异常被捕获，转换为错误结果。模型看到错误后，可能会重试、换一种方法、或者告诉用户"这个操作失败了"。

### 被 beforeToolCall 拦截

如果 `beforeToolCall` 钩子阻止了工具执行：

```typescript
if (beforeResult?.block) {
  return {
    kind: "immediate",
    result: createErrorToolResult(
      beforeResult.reason || "Tool execution was blocked",
    ),
    isError: true,
  };
}
```

模型会看到"工具被阻止"的消息，通常会告知用户或尝试其他方式。

这种"错误即结果"的设计有一个重要好处：**循环不会因为单个工具失败而崩溃**。模型作为"决策者"，可以根据错误信息做出合理的后续决策。这比硬编码的错误处理逻辑更灵活。

## 从 Agent 类的视角看闭环

上面我们从底层 `runLoop` 的视角走了一遍闭环。现在从 `Agent` 类的视角看，它在闭环过程中做了什么额外的事情。

`Agent` 类通过 `processEvents` 方法消费循环产生的事件，更新自身状态：

```typescript
// packages/agent/src/agent.ts（简化）
private async processEvents(event: AgentEvent): Promise<void> {
  switch (event.type) {
    case "message_start":
      this._state.streamingMessage = event.message;
      break;

    case "message_end":
      this._state.streamingMessage = undefined;
      this._state.messages.push(event.message);
      break;

    case "tool_execution_start":
      const pending = new Set(this._state.pendingToolCalls);
      pending.add(event.toolCallId);
      this._state.pendingToolCalls = pending;
      break;

    case "tool_execution_end":
      const pending2 = new Set(this._state.pendingToolCalls);
      pending2.delete(event.toolCallId);
      this._state.pendingToolCalls = pending2;
      break;

    case "agent_end":
      this._state.streamingMessage = undefined;
      break;
  }

  // 通知所有监听器
  for (const listener of this.listeners) {
    await listener(event, signal);
  }
}
```

注意两个关键设计：

1. **`message_start` 和 `message_end` 的配对**：`message_start` 时设置 `streamingMessage`，`message_end` 时清除 `streamingMessage` 并把消息 push 到 `messages` 数组。这意味着在流式输出过程中，UI 可以通过 `state.streamingMessage` 实时渲染正在生成的内容。

2. **`pendingToolCalls` 的不可变更新**：每次都创建新的 `Set` 而不是直接修改原 Set。这是为了让 UI 框架（如 React）能检测到状态变化并触发重渲染。

## 底层循环 vs Agent 类的消息管理

这里有一个微妙但重要的细节：底层 `runLoop` 和 `Agent` 类**各自维护了一份消息列表**。

- `runLoop` 内部的 `currentContext.messages`：底层循环的工作副本，用于构建 LLM 上下文
- `Agent._state.messages`：Agent 类的公开状态，通过 `processEvents` 中的 `message_end` 事件逐步追加

`Agent.createContextSnapshot()` 在启动循环时创建了上下文的快照：

```typescript
private createContextSnapshot(): AgentContext {
  return {
    systemPrompt: this._state.systemPrompt,
    messages: this._state.messages.slice(), // 复制一份
    tools: this._state.tools.slice(),
  };
}
```

这意味着循环启动后，底层的 `currentContext.messages` 和 `Agent._state.messages` 是两个独立的数组。底层循环直接往 `currentContext.messages` 里 push 消息（用于下一次模型调用），而 `Agent._state.messages` 通过事件回调异步更新。

为什么要这样设计？因为 `Agent._state.messages` 是公开的，外部代码（UI、持久化逻辑）可能在任何时候读取它。如果底层循环直接修改它，可能导致竞态条件。通过事件驱动的更新，状态变更是可预测的、有序的。

## 设计后果与权衡

### 为什么闭环是同步等待的

`agent.prompt()` 返回一个 Promise，调用者需要 `await` 它。这意味着在闭环完成之前，调用者被阻塞。

这是有意为之的。如果 `prompt()` 立即返回，调用者需要自己管理"agent 还在工作"的状态，容易出错。通过 `await`，调用者可以确定：当 `prompt()` resolve 时，agent 已经完全停止，所有事件都已发出，所有监听器都已执行完毕。

如果需要在 agent 工作时做其他事情，可以通过事件监听器实现，而不是让 `prompt()` 提前返回。

### 为什么错误不中断循环

把工具错误当成结果喂回模型，而不是抛出异常中断循环，这是一个重要的设计选择。

好处：

- 模型可以自主恢复——看到错误后换一种方式
- 单个工具失败不影响其他工具
- 用户不需要手动重试

代价：

- 模型可能陷入重试循环（反复调用失败的工具）
- 错误信息占用上下文窗口
- 模型的错误恢复能力取决于模型本身的质量

在实践中，好的 agent 产品会通过 `beforeToolCall` 或 `afterToolCall` 钩子来限制重试次数，避免无限循环。

### 为什么上下文快照是复制的

`createContextSnapshot()` 使用 `.slice()` 复制消息数组。这确保了底层循环的修改不会影响 `Agent._state.messages`，反之亦然。

代价是内存开销——每次启动循环都会复制一份完整的消息数组。但这个代价通常可以接受，因为消息数组的大小远小于消息内容本身（数组只存引用，不复制消息对象）。

## 后续章节预告

本章用一个最小的例子走完了 agent 的完整闭环。你现在应该能清楚地回答：

- 用户消息是怎么进入上下文的
- 模型是怎么被调用的
- 工具调用是怎么被检测和执行的
- 工具结果是怎么喂回模型的
- 循环是怎么终止的

下一章（第 4 章：为什么工具调用是分水岭）会深入工具调用本身——tool schema 的结构、模型是怎么生成工具调用的、参数验证是怎么工作的。工具调用是 agent 从"会说"到"会做"的关键转折点。

## 小练习

1. **追踪消息数量**：假设用户说"帮我读取 a.txt 和 b.txt 的内容，然后告诉我哪个文件更大"。模型先调用两次 `read_file`（在同一次回复中），然后生成最终回复。问：整个过程中 `Agent._state.messages` 最终包含多少条消息？分别是什么角色？

   > **关键信息**：最终包含 **5 条消息**：
   >
   > | 序号 | 角色         | 内容                                                    |
   > | ---- | ------------ | ------------------------------------------------------- |
   > | 1    | `user`       | "帮我读取 a.txt 和 b.txt 的内容..."                     |
   > | 2    | `assistant`  | 包含两个 `toolCall`（read_file a.txt, read_file b.txt） |
   > | 3    | `toolResult` | a.txt 的内容                                            |
   > | 4    | `toolResult` | b.txt 的内容                                            |
   > | 5    | `assistant`  | "a.txt 有 1024 字节，b.txt 有 512 字节，a.txt 更大"     |
   >
   > 注意两个 `toolResult` 消息是分开的——每个工具调用对应一个独立的 `ToolResultMessage`，通过 `toolCallId` 和助手消息中的 `toolCall.id` 关联。

2. **理解并行执行**：在上面的例子中，两个 `read_file` 调用是并行执行的。如果改成 `toolExecution: "sequential"`，行为会有什么不同？在什么场景下你会选择串行执行？

   > **关键信息**：
   >
   > **并行模式**（默认）：两个 `read_file` 同时发起文件读取，总耗时约等于较慢的那个文件的读取时间。事件序列是：`tool_execution_start(a.txt)` → `tool_execution_start(b.txt)` → `tool_execution_end(a.txt)` → `tool_execution_end(b.txt)`（结束顺序取决于哪个先完成，但结果按原始顺序返回）。
   >
   > **串行模式**：先完整执行 `read_file(a.txt)`（从 start 到 end），再开始 `read_file(b.txt)`。总耗时是两个文件读取时间之和。
   >
   > 选择串行执行的场景：
   >
   > - **工具之间有副作用依赖**：比如第一个工具 `write_file` 写入文件，第二个工具 `read_file` 读取同一个文件——必须先写后读。
   > - **资源竞争**：比如两个工具都需要独占某个锁或连接。
   > - **调试和可观察性**：串行执行的日志更容易阅读和排查问题。
   >
   > 在 pi-mono 的 coding agent 中，默认使用并行模式，因为大多数工具调用（读文件、搜索代码、执行命令）之间没有依赖关系。

3. **看代码**：阅读 `packages/agent/src/agent-loop.ts` 中的 `streamAssistantResponse` 函数，注意它是如何处理 `start` 事件的——为什么要在 `start` 时就把 `partialMessage` push 到 `context.messages` 中？如果不这样做，会有什么问题？

   > **关键信息**：`streamAssistantResponse` 在收到 `start` 事件时立即把 `partialMessage` push 到 `context.messages`：
   >
   > ```typescript
   > case "start":
   >   partialMessage = event.partial;
   >   context.messages.push(partialMessage);
   >   addedPartial = true;
   >   break;
   > ```
   >
   > 然后在后续的 `text_delta`、`toolcall_delta` 等事件中，通过替换数组最后一个元素来更新：
   >
   > ```typescript
   > context.messages[context.messages.length - 1] = partialMessage;
   > ```
   >
   > 为什么要这样做？因为 `context.messages` 是 `Agent._state.messages` 的工作副本，而 `processEvents` 中的 `message_start` 事件会设置 `streamingMessage`。如果不在 `start` 时就 push，那么在流式输出过程中，`context.messages` 和 `Agent._state` 之间的消息数量会不一致。
   >
   > 更重要的是，这种"先 push 再原地更新"的模式避免了在流式输出完成后再做一次 push——如果流中途出错或被中断，`context.messages` 中已经有了部分消息，不需要额外的清理逻辑。最终在 `done` 或 `error` 事件中，用完整的 `finalMessage` 替换掉部分消息即可。

# 第 2 章：什么是 Agent

## 前置知识

本章建立在第 1 章的基础上。你需要理解：

- LLM 是一个基于 token 的文本生成器
- LLM 本身不能读文件、执行命令、记住状态
- pi-mono 通过 `packages/ai` 提供了统一的模型调用接口（`stream`、`complete`）
- 模型的输出是一系列事件（`text_delta`、`toolcall_end`、`done` 等）

如果这些概念还不清楚，建议先回顾第 1 章。

## 本章聚焦的层次

本章聚焦于 LLM 之上的第一层——**agent runtime**。我们要搞清楚：agent 到底是什么、它和普通聊天程序有什么区别、它的核心结构长什么样。

在 pi-mono 的分层架构中，本章对应的是 `packages/agent`，它负责"怎么把模型变成会工作的循环"。它依赖 `packages/ai`（模型调用），并被 `packages/coding-agent`（产品层）所使用。

## 从一个问题开始

假设你用 LLM 写了一个聊天程序。用户输入一句话，模型返回一段回复，显示在屏幕上。这已经很有用了。

但现在用户说："帮我看看当前目录下有哪些文件，然后把 `config.json` 的内容读出来。"

模型可以理解这个请求，甚至可以生成一段"假装在读文件"的回复。但它**真的读不了文件**——第 1 章已经讲过，LLM 只是一个生成器，它没有文件系统访问能力。

要让模型"真的做事"，你需要在模型外面包一层系统：

1. 让模型能**请求**执行某个动作（比如"读文件"）
2. 有一段程序**真正执行**这个动作
3. 把执行结果**喂回**模型
4. 让模型根据结果**继续推理**

这个"包在模型外面的系统"，就是 agent。

## 三种程序形态的区别

在理解 agent 之前，先把三种容易混淆的程序形态区分清楚。

### 聊天助手（Chat Assistant）

最简单的形态。核心逻辑只有一步：

```
用户输入 → 模型生成 → 显示回复
```

每次交互都是独立的一轮。模型不会主动做任何事，也不会调用任何外部系统。你问它一个问题，它给你一个回答，结束。

聊天助手的特点：

- **单轮**：一问一答
- **无动作**：模型只输出文本，不触发任何外部操作
- **无状态**：每次调用之间没有持续的状态（除非你手动把历史消息塞回上下文）

大多数"套壳 ChatGPT"的产品都属于这个形态。

### 工作流（Workflow）

比聊天助手复杂一步。程序员提前定义好一系列步骤，按顺序执行：

```
步骤 1：读取用户输入
步骤 2：调用模型总结
步骤 3：把总结发邮件
步骤 4：记录日志
```

Workflow 的特点：

- **多步骤**：有明确的执行序列
- **有动作**：可以调用外部系统（发邮件、写数据库）
- **流程固定**：每一步做什么、什么顺序，都是程序员写死的

Workflow 中模型的角色是"被调用的工具"——程序决定什么时候调用模型、用什么输入、怎么处理输出。模型不参与流程决策。

### Agent

Agent 和 workflow 的关键区别在于：**谁来决定下一步做什么**。

在 workflow 中，程序员决定。在 agent 中，模型参与决定。

```
用户输入 → 模型推理 → 模型决定调用工具 → 执行工具 → 结果喂回模型 → 模型继续推理 → ...
```

Agent 的特点：

- **动态决策**：模型根据当前上下文决定是否调用工具、调用哪个工具、用什么参数
- **循环执行**：不是一次调用就结束，而是"推理 → 动作 → 观察 → 推理"的循环
- **有状态**：需要维护消息历史、工具结果、执行状态

一个具体的对比：

|              | 聊天助手         | Workflow           | Agent               |
| ------------ | ---------------- | ------------------ | ------------------- |
| 谁决定下一步 | 无（只有一步）   | 程序员             | 模型                |
| 能否调用工具 | 不能             | 能（程序员指定）   | 能（模型请求）      |
| 执行流程     | 固定（一问一答） | 固定（预定义步骤） | 动态（模型驱动）    |
| 循环         | 无               | 无（或固定循环）   | 有（推理-动作循环） |

### 一个例子说明区别

用户请求："帮我找到项目里所有的 TODO 注释，然后生成一份报告。"

**聊天助手**的做法：

> "你可以用 `grep -r 'TODO' .` 命令来查找所有 TODO 注释，然后手动整理成报告。"

它只能告诉你怎么做，不能真的做。

**Workflow**的做法：

```
1. 执行 grep -r 'TODO' .
2. 把结果传给模型
3. 让模型生成报告
4. 保存报告到文件
```

每一步都是程序员写死的。如果 grep 没找到结果，workflow 不会自动换一种搜索方式。

**Agent**的做法：

```
模型思考："我需要先搜索 TODO 注释"
→ 调用 grep 工具搜索 'TODO'
→ 发现结果太多，决定按文件分组
→ 调用 read_file 读取几个关键文件的上下文
→ 综合所有信息，生成报告
→ 调用 write_file 保存报告
→ 告诉用户："报告已保存到 todo-report.md"
```

模型在每一步都根据上一步的结果决定下一步做什么。如果搜索没结果，它可能会换关键词重试；如果文件太大，它可能会只读前几行。这种动态决策能力，就是 agent 的核心。

## Agent 的四个组成部分

大纲中提到过：Agent = 模型 + 循环 + 工具 + 状态。现在我们逐一展开，并对应到 pi-mono 的代码。

### 1. 模型（Model）

模型是 agent 的"大脑"。它负责理解上下文、做出决策、生成文本和工具调用请求。

在 pi-mono 中，模型通过 `packages/ai` 的 `Model` 类型表示，agent 通过 `AgentState` 持有当前使用的模型：

```typescript
// packages/agent/src/types.ts
export interface AgentState {
  /** Active model used for future turns. */
  model: Model<any>;
  // ...
}
```

模型可以在运行时切换。比如用户可以从 Claude 切换到 GPT-4o，agent 的下一轮推理就会使用新模型。这在 `packages/coding-agent` 中通过 `cycleModel()` 实现。

### 2. 循环（Loop）

循环是 agent 的"心跳"。它决定了 agent 什么时候调用模型、什么时候执行工具、什么时候停下来。

这是 agent 和聊天助手最本质的区别。聊天助手调用一次模型就结束了。Agent 会反复调用模型，直到模型认为任务完成（不再请求工具调用）。

在 pi-mono 中，循环的核心实现在 `packages/agent/src/agent-loop.ts` 的 `runLoop` 函数中。它的基本结构是：

```
while (true) {
    while (还有工具调用 || 还有待处理消息) {
        // 1. 处理待注入的消息（steering messages）
        // 2. 调用模型，获取助手回复
        // 3. 如果模型出错或被中断，结束
        // 4. 如果模型请求了工具调用，执行工具
        // 5. 把工具结果加入上下文
        // 6. 检查是否有新的 steering messages
    }

    // 内层循环结束，检查是否有 follow-up messages
    // 如果有，继续外层循环
    // 如果没有，退出
}
```

让我们看看实际代码中这个循环的关键部分：

```typescript
// packages/agent/src/agent-loop.ts（简化版）
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages: AgentMessage[] =
    (await config.getSteeringMessages?.()) || [];

  // 外层循环：处理 follow-up messages
  while (true) {
    let hasMoreToolCalls = true;

    // 内层循环：处理工具调用和 steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      // 注入 pending messages
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
      }

      // 调用模型
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
      );
      newMessages.push(message);

      // 错误或中断，直接退出
      if (message.stopReason === "error" || message.stopReason === "aborted") {
        return;
      }

      // 检查工具调用
      const toolCalls = message.content.filter((c) => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;

      // 执行工具，把结果加入上下文
      if (hasMoreToolCalls) {
        const toolResults = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
        );
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      // 检查 steering messages
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // 检查 follow-up messages
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }

    break;
  }
}
```

注意这个循环有两层：

- **内层循环**：处理一轮对话中的工具调用。模型可能一次请求多个工具调用，执行完后再次调用模型，模型可能又请求新的工具调用，如此反复。
- **外层循环**：处理 follow-up messages。当内层循环结束（模型不再请求工具调用），检查是否有后续消息需要处理。如果有，注入消息后重新进入内层循环。

这个双层循环结构是 pi-mono agent 的核心控制流。后续章节会详细讨论 steering 和 follow-up 的机制。可以先读一份补充说明：[《补充：从使用者视角理解 Agent Loop》](./chap-2-agent-loop-faq.md)。
### 3. 工具（Tools）

工具是 agent 与外部世界交互的接口。没有工具，agent 就只是一个会循环的聊天助手。

在 pi-mono 中，工具通过 `AgentTool` 接口定义：

```typescript
// packages/agent/src/types.ts
export interface AgentTool<
  TParameters extends TSchema = TSchema,
  TDetails = any,
> extends Tool<TParameters> {
  /** 人类可读的标签，用于 UI 显示 */
  label: string;
  /** 可选的参数预处理 */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** 执行工具调用 */
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
}
```

一个工具需要定义四样东西：

1. **name**：工具名称，模型通过这个名字来请求调用
2. **description**：工具描述，告诉模型这个工具能做什么
3. **parameters**：参数 schema，定义工具接受什么输入
4. **execute**：执行函数，真正做事的代码

举个例子，`packages/coding-agent` 中的 `read_file` 工具大致是这样的：

```typescript
const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  execute: async (toolCallId, params, signal) => {
    const content = await fs.readFile(params.path, "utf-8");
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};
```

工具的执行结果（`AgentToolResult`）包含两部分：

- `content`：返回给模型的内容（文本或图片），模型会看到这些内容并据此继续推理
- `details`：结构化的详情数据，用于日志记录或 UI 渲染，模型不会看到

这个区分很重要。`content` 会占用上下文窗口，所以要控制大小；`details` 不进入上下文，可以包含更丰富的信息。

### 4. 状态（State）

状态是 agent 的"记忆"。它保存了当前对话的所有信息。

在 pi-mono 中，agent 状态通过 `AgentState` 接口定义：

```typescript
// packages/agent/src/types.ts
export interface AgentState {
  /** 系统提示词 */
  systemPrompt: string;
  /** 当前使用的模型 */
  model: Model<any>;
  /** 推理级别 */
  thinkingLevel: ThinkingLevel;
  /** 可用工具列表 */
  tools: AgentTool<any>[];
  /** 对话记录 */
  messages: AgentMessage[];
  /** 是否正在处理中 */
  readonly isStreaming: boolean;
  /** 当前正在流式输出的消息 */
  readonly streamingMessage?: AgentMessage;
  /** 正在执行的工具调用 ID */
  readonly pendingToolCalls: ReadonlySet<string>;
  /** 最近一次错误信息 */
  readonly errorMessage?: string;
}
```

其中最重要的是 `messages`——对话记录。它包含了所有的用户消息、助手回复和工具结果。每次调用模型时，这些消息（经过转换和过滤）会作为上下文发送给模型。

注意 `messages` 的类型是 `AgentMessage[]`，而不是 LLM 的 `Message[]`。这是一个重要的设计决策，下一节会详细讨论。

## AgentMessage vs LLM Message

这是 pi-mono agent 层最重要的设计决策之一。

第 1 章介绍过，LLM 只理解三种消息角色：`user`、`assistant`、`toolResult`。但在真实的 agent 应用中，你可能需要更多的消息类型：

- 系统通知（"模型已切换到 GPT-4o"）
- UI 状态消息（"正在搜索文件..."）
- 用户的图片附件
- 会话恢复标记
- 自定义的应用消息

如果把这些都塞进 LLM 的三种消息类型里，代码会变得混乱且脆弱。

pi-mono 的解决方案是引入 `AgentMessage` 类型：

```typescript
// packages/agent/src/types.ts

// 应用可以通过声明合并扩展自定义消息类型
export interface CustomAgentMessages {
  // 默认为空，应用通过声明合并扩展
}

// AgentMessage = LLM 消息 + 自定义消息
export type AgentMessage =
  | Message
  | CustomAgentMessages[keyof CustomAgentMessages];
```

应用层可以通过 TypeScript 的声明合并（declaration merging）添加自定义消息类型：

```typescript
// 在你的应用代码中
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    notification: {
      role: "notification";
      text: string;
      timestamp: number;
    };
  }
}
```

这样 `AgentMessage` 就自动包含了 `notification` 类型，而且是类型安全的。

但 LLM 不认识 `notification` 消息。所以在调用模型之前，需要一个转换步骤。这就是 `convertToLlm` 的作用：

```typescript
// packages/agent/src/types.ts
export interface AgentLoopConfig {
  /**
   * 把 AgentMessage[] 转换为 LLM 兼容的 Message[]。
   * 不能转换的消息（如 UI 通知）应该被过滤掉。
   */
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  // ...
}
```

整个消息流转过程是：

```
AgentMessage[]
    ↓ transformContext()    // 可选：裁剪、注入外部上下文
AgentMessage[]
    ↓ convertToLlm()       // 必须：过滤自定义消息，转换为 LLM 格式
Message[]
    ↓ 发送给 LLM
```

这个两步转换的设计让 agent 层和 LLM 层彻底解耦：

- Agent 层用 `AgentMessage` 工作，可以包含任意应用消息
- LLM 层只看到标准的 `Message`，不需要知道应用层的消息类型
- 转换逻辑集中在 `convertToLlm` 一个函数中，而不是散落在各处

## 事件系统

Agent 在运行过程中会发出一系列事件，让外部代码（UI、日志、扩展）能够观察和响应 agent 的行为。

```typescript
// packages/agent/src/types.ts
export type AgentEvent =
  // Agent 生命周期
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn 生命周期（一个 turn = 一次助手回复 + 工具执行）
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
  | { type: "tool_execution_update"; toolCallId: string; partialResult: any }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      result: any;
      isError: boolean;
    };
```

这些事件形成了三个层次的生命周期：

**Agent 级别**：`agent_start` → ... → `agent_end`

一次完整的 agent 运行，从用户发送 prompt 到 agent 完全停止。

**Turn 级别**：`turn_start` → ... → `turn_end`

一个 turn 包含一次模型调用和随后的工具执行。一次 agent 运行可能包含多个 turn（模型调用工具后继续推理，就是一个新的 turn）。

**消息/工具级别**：`message_start` → `message_update` → `message_end`，`tool_execution_start` → `tool_execution_end`

单条消息或单次工具执行的生命周期。

用一个实际的例子来说明。当用户说"读取 config.json 的内容"时，事件序列大致是：

```
agent_start
├─ turn_start
│  ├─ message_start    { userMessage: "读取 config.json 的内容" }
│  ├─ message_end      { userMessage }
│  ├─ message_start    { assistantMessage: 开始流式输出 }
│  ├─ message_update   { thinking_delta: "用户想读文件..." }
│  ├─ message_update   { toolcall_delta: "read_file..." }
│  ├─ message_end      { assistantMessage: 包含 toolCall }
│  ├─ tool_execution_start  { toolName: "read_file" }
│  ├─ tool_execution_end    { result: 文件内容 }
│  ├─ message_start    { toolResultMessage }
│  ├─ message_end      { toolResultMessage }
│  └─ turn_end
├─ turn_start
│  ├─ message_start    { assistantMessage: 开始第二轮回复 }
│  ├─ message_update   { text_delta: "config.json 的内容是..." }
│  ├─ message_end      { assistantMessage: 最终回复 }
│  └─ turn_end
└─ agent_end
```

第一个 turn：模型决定调用 `read_file` 工具，工具执行后返回结果。
第二个 turn：模型看到文件内容，生成最终回复，不再调用工具，循环结束。

这个事件系统的设计让 UI 可以精确地知道 agent 在做什么：

- `message_update` 中的 `text_delta` 让 UI 逐字显示模型输出
- `tool_execution_start` 让 UI 显示"正在读取文件..."
- `tool_execution_end` 让 UI 显示工具执行结果
- `agent_end` 让 UI 知道可以接受新的用户输入了

## Agent 类：把一切组装起来

`packages/agent` 提供了两个层次的 API：

1. **低层 API**：`agentLoop` / `agentLoopContinue` 函数，直接操作上下文和配置
2. **高层 API**：`Agent` 类，封装了状态管理、事件分发、队列等

大多数情况下你会使用 `Agent` 类。它的核心用法非常简洁：

```typescript
import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model: getModel("anthropic", "claude-sonnet-4-20250514"),
    tools: [readFileTool, bashTool],
  },
});

// 订阅事件
agent.subscribe((event) => {
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

// 发送 prompt，等待完成
await agent.prompt("What files are in the current directory?");
```

`agent.prompt()` 做了以下事情：

1. 把用户消息加入状态
2. 启动 agent 循环
3. 循环中反复调用模型、执行工具
4. 通过事件通知订阅者
5. 循环结束后，promise resolve

### Steering 和 Follow-up

真实的交互不是"用户说一句，等 agent 做完，再说下一句"。用户可能在 agent 工作的过程中想要插话或补充。

`Agent` 类提供了两种机制：

**Steering**（转向）：在 agent 工作过程中注入消息。

```typescript
// agent 正在执行工具...
agent.steer({
  role: "user",
  content: [{ type: "text", text: "等等，先别改那个文件" }],
  timestamp: Date.now(),
});
```

Steering 消息会在当前 turn 的工具执行完成后、下一次模型调用之前被注入。模型会看到这条消息，并据此调整行为。

**Follow-up**（后续）：在 agent 即将停止时注入消息。

```typescript
agent.followUp({
  role: "user",
  content: [{ type: "text", text: "顺便也总结一下结果" }],
  timestamp: Date.now(),
});
```

Follow-up 消息只在 agent 没有更多工具调用、也没有 steering 消息时才会被处理。它让你可以在 agent 完成当前任务后，无缝地追加新任务。

这两种机制对应了 `runLoop` 中的两层循环：

- 内层循环处理 steering messages
- 外层循环处理 follow-up messages

### 中断与恢复

Agent 支持中途中断：

```typescript
agent.abort(); // 取消当前运行
```

调用 `abort()` 后，当前的模型调用会被取消（通过 `AbortSignal`），agent 会发出 `agent_end` 事件并停止。

中断后可以通过 `continue()` 恢复：

```typescript
await agent.continue(); // 从当前上下文继续
```

`continue()` 不会添加新消息，而是从现有上下文的最后一条消息继续。这对于错误重试特别有用——如果模型调用失败了，你可以直接 `continue()` 让 agent 重试。

## 工具执行的细节

工具执行不是简单的"调用函数，返回结果"。pi-mono 的工具执行流程包含多个阶段：

### 1. 参数验证

模型生成的工具调用参数可能不符合 schema。在执行之前，agent 会用 `validateToolArguments` 验证参数：

```typescript
const validatedArgs = validateToolArguments(tool, preparedToolCall);
```

如果验证失败，工具不会执行，而是返回一个错误结果给模型。模型看到错误后，通常会修正参数重试。

### 2. beforeToolCall 拦截

在工具执行之前，可以通过 `beforeToolCall` 钩子拦截：

```typescript
const agent = new Agent({
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash" && args.command.includes("rm -rf")) {
      return { block: true, reason: "危险命令已被阻止" };
    }
  },
});
```

返回 `{ block: true }` 会阻止工具执行，agent 会把 `reason` 作为错误结果返回给模型。

这是一个关键的安全控制点。在 `packages/coding-agent` 中，它被用来实现用户确认机制——某些危险操作需要用户手动批准才能执行。

### 3. 执行

工具的 `execute` 函数被调用。执行过程中可以通过 `onUpdate` 回调流式报告进度：

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  onUpdate?.({
    content: [{ type: "text", text: "正在搜索..." }],
    details: { progress: 0.5 },
  });
  // ... 实际执行 ...
  return { content: [...], details: {...} };
},
```

### 4. afterToolCall 后处理

工具执行完成后，可以通过 `afterToolCall` 钩子修改结果：

```typescript
const agent = new Agent({
  afterToolCall: async ({ toolCall, result, isError }) => {
    // 截断过长的工具结果，避免撑爆上下文
    if (
      result.content[0]?.type === "text" &&
      result.content[0].text.length > 10000
    ) {
      return {
        content: [
          {
            type: "text",
            text: result.content[0].text.slice(0, 10000) + "\n...(truncated)",
          },
        ],
      };
    }
  },
});
```

### 5. 并行 vs 串行

模型可能在一次回复中请求多个工具调用。pi-mono 支持两种执行模式：

- **parallel**（默认）：先按顺序做参数验证和 `beforeToolCall` 检查，然后并发执行所有通过检查的工具，最后按原始顺序返回结果
- **sequential**：逐个执行，每个工具完成后才开始下一个

```typescript
const agent = new Agent({
  toolExecution: "parallel", // 或 "sequential"
});
```

并行执行更快，但有些场景需要串行——比如后一个工具依赖前一个工具的副作用。

## 上下文转换

在调用模型之前，agent 会对上下文进行两步转换：

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[]
```

**transformContext**（可选）：在 `AgentMessage` 层面操作。典型用途：

- 裁剪过旧的消息，控制上下文大小
- 注入外部上下文（比如项目规则文件）
- 压缩历史消息

```typescript
const agent = new Agent({
  transformContext: async (messages) => {
    if (estimateTokens(messages) > MAX_TOKENS) {
      return pruneOldMessages(messages);
    }
    return messages;
  },
});
```

**convertToLlm**（必须）：把 `AgentMessage[]` 转换为 LLM 能理解的 `Message[]`。默认实现只保留 `user`、`assistant`、`toolResult` 三种角色的消息：

```typescript
// packages/agent/src/agent.ts
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (message) =>
      message.role === "user" ||
      message.role === "assistant" ||
      message.role === "toolResult",
  );
}
```

如果你有自定义消息类型，需要提供自己的 `convertToLlm` 实现。

## 设计后果与权衡

### 为什么是双层循环而不是单层

单层循环（只处理工具调用）在简单场景下够用。但真实产品中，用户会在 agent 工作时插话（steering），也会在 agent 完成后追加任务（follow-up）。双层循环让这两种场景都能自然处理，而不需要在外部重新启动 agent。

### 为什么工具执行默认并行

在 coding agent 场景中，模型经常同时请求多个独立的操作——比如同时读取三个文件。并行执行可以显著减少等待时间。串行执行作为选项保留，是因为某些工具之间确实有依赖关系。

### 为什么 Agent 类和 agentLoop 分开

`agentLoop` 是纯函数式的——给它上下文和配置，它返回事件流。这让它容易测试、容易组合。

`Agent` 类在 `agentLoop` 之上添加了状态管理（持有 messages、tools 等）、事件分发（subscribe）、队列（steer、followUp）和生命周期控制（abort、waitForIdle）。这些是构建产品时必需的，但不应该和核心循环逻辑耦合。

这种分层让你可以根据需要选择抽象级别：

- 需要完全控制？用 `agentLoop`
- 需要开箱即用的状态管理？用 `Agent` 类
- 需要产品级功能（会话、压缩、扩展）？用 `packages/coding-agent` 的 `AgentSession`

### 事件系统为什么是 await 的

`Agent` 类的事件监听器是 `async` 的，而且 agent 会 `await` 每个监听器：

```typescript
for (const listener of this.listeners) {
  await listener(event, signal);
}
```

这意味着监听器可以做异步操作（比如写文件、发网络请求），而且 agent 会等待这些操作完成后才继续。这在 `agent_end` 事件中特别重要——你可以在监听器中保存会话状态，确保在 agent 标记为"空闲"之前，所有持久化操作都已完成。

代价是：如果监听器很慢，会拖慢整个 agent 循环。所以监听器应该尽量快，或者把耗时操作放到后台。

## 后续章节预告

本章建立了对 agent 的基本认知：它是模型 + 循环 + 工具 + 状态的组合，通过动态决策驱动外部动作。

下一章（第 3 章：Agent 的最小闭环）会在此基础上，用一个最小的例子走完 agent 的完整流程：用户消息 → 模型响应 → 工具调用 → 工具结果 → 继续推理。你会看到这个闭环是如何在代码中一步步发生的。

## 小练习

1. **理解事件序列**：假设用户说"帮我创建一个 hello.txt 文件，内容是 Hello World"，模型决定调用 `write_file` 工具。画出完整的事件序列（从 `agent_start` 到 `agent_end`），标注每个事件的类型和关键数据。

   > **关键信息**：完整的事件序列如下：
   >
   > ```
   > agent_start
   > ├─ turn_start
   > │  ├─ message_start    { message: userMessage("帮我创建一个 hello.txt...") }
   > │  ├─ message_end      { message: userMessage }
   > │  ├─ message_start    { message: assistantMessage(开始流式输出) }
   > │  ├─ message_update   { assistantMessageEvent: { type: "text_delta", delta: "好的，我来帮你创建..." } }
   > │  ├─ message_update   { assistantMessageEvent: { type: "toolcall_start" } }
   > │  ├─ message_update   { assistantMessageEvent: { type: "toolcall_delta", delta: '{"path":"hello.txt"...' } }
   > │  ├─ message_update   { assistantMessageEvent: { type: "toolcall_end", toolCall: { name: "write_file", arguments: { path: "hello.txt", content: "Hello World" } } } }
   > │  ├─ message_end      { message: assistantMessage(包含 toolCall 块) }
   > │  ├─ tool_execution_start  { toolCallId: "call_xxx", toolName: "write_file", args: { path: "hello.txt", content: "Hello World" } }
   > │  ├─ tool_execution_end    { toolCallId: "call_xxx", result: { content: [{ type: "text", text: "File created" }] }, isError: false }
   > │  ├─ message_start    { message: toolResultMessage(工具执行结果) }
   > │  ├─ message_end      { message: toolResultMessage }
   > │  └─ turn_end         { message: assistantMessage, toolResults: [toolResultMessage] }
   > ├─ turn_start
   > │  ├─ message_start    { message: assistantMessage(第二轮回复开始) }
   > │  ├─ message_update   { assistantMessageEvent: { type: "text_delta", delta: "已经帮你创建了 hello.txt..." } }
   > │  ├─ message_end      { message: assistantMessage(最终回复，无工具调用) }
   > │  └─ turn_end         { message: assistantMessage, toolResults: [] }
   > └─ agent_end           { messages: [userMessage, assistantMessage1, toolResultMessage, assistantMessage2] }
   > ```
   >
   > 关键观察点：
   >
   > - **两个 turn**：第一个 turn 包含模型的工具调用请求和工具执行；第二个 turn 是模型看到工具结果后生成最终回复。循环在第二个 turn 结束，因为模型不再请求工具调用。
   > - **message_start/end 成对出现**：每条消息（用户消息、助手消息、工具结果消息）都有完整的生命周期。`message_start` 时 `streamingMessage` 被设置，`message_end` 时 `streamingMessage` 被清除并将消息 push 到 `messages` 数组。
   > - **tool_execution_start/end 嵌套在 turn 内**：工具执行发生在助手消息结束之后、工具结果消息之前。这段时间内 `pendingToolCalls` 集合非空，UI 可以据此显示"正在执行工具..."。
   > - **agent_end 携带完整消息列表**：外部代码可以用它来持久化本次会话的所有新消息。

2. **对比三种形态**：用你自己的话，分别描述聊天助手、workflow 和 agent 处理"把这段代码翻译成 Python"这个请求时的行为差异。思考：在什么情况下 workflow 比 agent 更合适？

   > **关键信息**：
   >
   > **聊天助手**的做法：用户把代码贴进对话框，模型直接在回复中输出翻译后的 Python 代码。整个过程是一问一答，模型不会去读原始文件，也不会把翻译结果写到任何地方。如果代码太长超出上下文窗口，它无能为力。
   >
   > **Workflow**的做法：程序员预先定义好固定步骤——(1) 读取指定的源文件 (2) 把内容发给模型并要求翻译成 Python (3) 把模型输出写入 `output.py` (4) 运行 linter 检查语法。每一步做什么、什么顺序，都是写死的。如果源文件不存在，workflow 会直接报错退出，不会尝试其他方案。
   >
   > **Agent**的做法：模型先分析请求，决定需要读取哪个文件（可能先调用 `list_files` 看看目录结构），然后调用 `read_file` 读取源代码，理解代码逻辑后生成 Python 翻译，调用 `write_file` 写入文件，甚至可能调用 `bash` 运行 `python -c "import ast; ast.parse(open('output.py').read())"` 来验证语法是否正确。如果验证失败，模型会自行修正并重试。整个流程是动态的——模型在每一步根据上一步的结果决定下一步做什么。
   >
   > **Workflow 比 Agent 更合适的场景**：
   >
   > - **流程完全确定且不需要判断**：比如"每天凌晨把数据库备份发到 S3"，步骤固定，不需要模型参与决策。
   > - **对成本和延迟敏感**：Workflow 不调用 LLM（或只调用一次），成本可预测；Agent 的循环次数不确定，可能调用模型多次。
   > - **需要严格的可审计性**：Workflow 的每一步都是程序员写死的，行为完全可预测；Agent 的行为取决于模型的动态决策，可能每次运行路径不同。
   > - **批量处理同构任务**：比如"把 100 个 JSON 文件转成 CSV"，每个文件的处理逻辑完全相同，用 workflow 更高效。

3. **看代码**：阅读 `packages/agent/src/agent.ts` 中的 `processEvents` 方法，理解它是如何根据不同事件类型更新 `_state` 的。特别注意 `message_start`、`message_end` 和 `tool_execution_start`、`tool_execution_end` 这四个事件对状态的影响。

   > **关键信息**：`processEvents` 方法是 `Agent` 类的私有方法，它是事件系统和状态管理之间的桥梁。每当 agent 循环产生一个事件，都会经过这个方法，先更新内部状态，再通知所有外部监听器。以下是各事件对 `_state` 的影响：
   >
   > | 事件类型               | 状态变更                                                                     | 含义                                                                                                                                                             |
   > | ---------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   > | `message_start`        | `_state.streamingMessage = event.message`                                    | 标记"当前有一条消息正在流式生成中"。UI 可以通过 `state.streamingMessage` 实时渲染正在生成的内容。                                                                |
   > | `message_update`       | `_state.streamingMessage = event.message`                                    | 更新流式消息的引用（消息对象内部的 content 在持续变化）。                                                                                                        |
   > | `message_end`          | `_state.streamingMessage = undefined`；`_state.messages.push(event.message)` | **关键转换点**：消息从"正在生成"变为"已完成"。`streamingMessage` 被清除，完整消息被追加到 `messages` 数组中，成为持久化的对话历史的一部分。                      |
   > | `tool_execution_start` | 创建新 Set，`add(event.toolCallId)`，赋值给 `_state.pendingToolCalls`        | 将工具调用 ID 加入"正在执行"集合。UI 可以据此显示哪些工具正在运行。注意这里每次都创建新的 Set 而不是直接修改原 Set——这是为了触发状态变更检测（不可变更新模式）。 |
   > | `tool_execution_end`   | 创建新 Set，`delete(event.toolCallId)`，赋值给 `_state.pendingToolCalls`     | 将工具调用 ID 从"正在执行"集合中移除。当集合为空时，表示所有工具都已执行完毕。同样使用不可变更新模式。                                                           |
   > | `turn_end`             | 如果助手消息包含 `errorMessage`，设置 `_state.errorMessage`                  | 记录错误信息，供 UI 显示或后续逻辑判断。                                                                                                                         |
   > | `agent_end`            | `_state.streamingMessage = undefined`                                        | 清理流式状态，确保 agent 停止后不会残留"正在生成"的假象。                                                                                                        |
   >
   > 几个值得注意的设计细节：
   >
   > - **不可变更新模式**：`pendingToolCalls` 每次都创建新的 `Set` 而不是直接 `add/delete`。这是 React 等 UI 框架常用的模式——通过引用变化来触发重渲染。如果直接修改原 Set，外部代码可能检测不到变化。
   > - **先更新状态，再通知监听器**：`processEvents` 先执行 `switch` 更新 `_state`，然后才遍历 `this.listeners` 调用每个监听器。这保证了监听器在被调用时，`_state` 已经是最新的。
   > - **监听器是 await 的**：`for (const listener of this.listeners) { await listener(event, signal); }`——监听器可以做异步操作，agent 会等待所有监听器完成后才继续。这在 `agent_end` 时特别重要，确保持久化操作完成后 agent 才标记为空闲。
   > - **`agent_start` 和 `turn_start` 没有状态变更**：这两个事件只是通知性的，不修改任何状态。它们的价值在于让外部监听器知道"新的运行/轮次开始了"。

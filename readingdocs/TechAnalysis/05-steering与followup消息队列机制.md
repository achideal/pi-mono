# 05 · steering / follow-up 消息队列：两种"不阻塞主流程地注入用户意图"的模式

> 位置：`packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts`（`runLoop` 主循环）
>
> 提炼点：**把"agent 正在跑工具，用户还想说话"和"agent 跑完了，用户又想让它继续做一件事"两种诉求抽象成两条独立队列，由主循环在**精确位置**拉取，实现极其自然的交互体验。**

---

## 1. 用户的真实诉求

传统的"对话式 AI"只能一问一答：你等它把话说完、把工具跑完，才能打字。但真实用户经常会在以下两个时刻想"插话"：

1. **Steering（干预）**：Agent 正在调用 `bash` 跑一个长命令，你突然想说"算了，改成 `npm test`"。
2. **Follow-up（追加）**：Agent 刚说了一段分析，准备结束对话，但你想在它 idle 之前让它"顺便把报告写到 REPORT.md"。

在不支持并发编辑 LLM 上下文的语义下（LLM 还在流式过程中，不能改它上一句），这两种诉求要做得自然非常难。pi-agent 用两条队列 + 主循环内的两个 poll 点把它做成了默认行为。

---

## 2. API 层的设计：两条队列，对称接口

`Agent` 类暴露：

```ts
agent.steer(message);          // 排队 steering
agent.followUp(message);       // 排队 follow-up
agent.steeringMode  = "all" | "one-at-a-time";
agent.followUpMode  = "all" | "one-at-a-time";
agent.clearSteeringQueue();
agent.clearFollowUpQueue();
```

内部用同一个 `PendingMessageQueue` 类承担：

```ts
class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  constructor(public mode: QueueMode) {}

  enqueue(message) { this.messages.push(message); }
  hasItems() { return this.messages.length > 0; }

  drain(): AgentMessage[] {
    if (this.mode === "all") {
      const drained = this.messages.slice();
      this.messages = [];
      return drained;
    }
    const first = this.messages[0];
    if (!first) return [];
    this.messages = this.messages.slice(1);
    return [first];
  }

  clear() { this.messages = []; }
}
```

这里有三个决策值得学：

### 2.1 `mode = "one-at-a-time" | "all"`

- `one-at-a-time`（默认）：每轮只吃一条队首消息，让 LLM 先回应它再吃下一条。对应用户"一句一句说、等回应"的习惯。
- `all`：一次性全部推进上下文，一次 response 解决所有问题。批量总结场景更合适。

两种模式的区别在 `drain()` 一个方法里一次写清楚，API 不会膨胀。

### 2.2 两条队列独立，不合并

理论上可以做成一条"pending queue"加 tag。拆成两条的原因是——**消费的时机不一样**：

- steering 在"Agent 还在做事"时注入（精确地说：在 tool_call 全跑完、下一次 LLM 调用之前）。
- follow-up 在"Agent 本来要 agent_end 了"时注入（把本该结束的 run 再拉一个回合）。

混成一条队列会迫使主循环区分两种语义、反而更复杂。

### 2.3 `enqueue` 是同步的

用户可能在任何时候按下 Enter。`enqueue` 不能 async，否则按 Enter 的事件处理可能卡住 UI。用户 API 简单、内部由主循环轮询消费，是这种"随时可写入、定点消费"问题的标准解。

---

## 3. 主循环里的两个"拉取点"

看 `agent-loop.ts` 中 `runLoop` 的骨架（简化后）：

```ts
async function runLoop(...) {
  let firstTurn = true;

  // ① 启动时就 drain 一次 steering（用户可能已经输了一句在等待）
  let pendingMessages = (await config.getSteeringMessages?.()) || [];

  while (true) {
    let hasMoreToolCalls = true;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) await emit({ type: "turn_start" });
      else firstTurn = false;

      // ② 把 pending 注入成 user messages
      if (pendingMessages.length > 0) {
        for (const m of pendingMessages) {
          await emit({ type: "message_start", message: m });
          await emit({ type: "message_end",   message: m });
          currentContext.messages.push(m);
          newMessages.push(m);
        }
        pendingMessages = [];
      }

      // ③ 流式拿 assistant 回应
      const message = await streamAssistantResponse(...);
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // ④ 执行 tool calls（如果有）
      const toolCalls = message.content.filter(c => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;
      const toolResults = [];
      if (hasMoreToolCalls) toolResults.push(...(await executeToolCalls(...)));
      for (const r of toolResults) { currentContext.messages.push(r); newMessages.push(r); }
      await emit({ type: "turn_end", message, toolResults });

      // ⑤ steering poll（每轮 turn 结束后）
      pendingMessages = (await config.getSteeringMessages?.()) || [];
    }

    // ⑥ 到这里 agent 本来要 stop 了，但先看看 follow-up
    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;      // 回到内层 while，开新一轮
    }
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}
```

三个"拉取点"①⑤⑥刚好对应用户的三种诉求：

| 点 | 时机 | 能处理什么 |
| --- | --- | --- |
| ① 主循环一开始 | 用户在发 prompt 之前已经按 Enter 排队了后续消息 | 把它视作 steering 提前注入 |
| ⑤ 每轮 `turn_end` 后 | Agent 刚跑完 tool_calls、还没开下一轮 | steering：改变下一轮 LLM 要看到的上下文 |
| ⑥ 本该 agent_end 之前 | Agent 已经没 tool_call 可跑、即将停 | follow-up：让它再干一件事 |

没有这两个 poll，"随时打断"只能靠取消重跑，用户体验和 token 成本都不可接受。

### 3.1 为什么 steering poll 选"turn_end 之后"

- 因为 tool_call 正在跑时不能 inject user message（会破坏 tool_call / tool_result 的配对，详见第 3 篇）。
- turn_end 时刻代表：**assistant 已经 `message_end`、所有 tool_result 已经落到 context**。这是 context "结构最干净"的瞬间。任何插入都不会破坏合法性。

### 3.2 为什么 follow-up poll 选"要 agent_end 之前"

- 因为如果 agent 已经触发 `agent_end`，外层 prompt() 已经在等 resolve，再往 loop 里塞就要重新启一个 run，带来状态污染。
- 在内层 while 退出之后、外层 while 的 continue 之前检查，是"还能延续当前 run、不破坏事件语义"的最后一扇窗。

---

## 4. 与 `continue()` 的打通

`Agent.continue()` 专门处理"上一次失败、或上一次因用户中断后想续"的场景：

```ts
async continue(): Promise<void> {
  const lastMessage = this._state.messages[this._state.messages.length - 1];
  if (lastMessage.role === "assistant") {
    const queuedSteering = this.steeringQueue.drain();
    if (queuedSteering.length > 0) {
      await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
      return;
    }
    const queuedFollowUps = this.followUpQueue.drain();
    if (queuedFollowUps.length > 0) {
      await this.runPromptMessages(queuedFollowUps);
      return;
    }
    throw new Error("Cannot continue from message role: assistant");
  }
  await this.runContinuation();
}
```

注意这里的两个聪明点：

- **如果 last message 是 assistant（LLM 自己结束了，但又有积压的 steering/follow-up）**：把队列 drain 当作新 prompt 发起。既保留用户已有输入，又不违反"continue 必须从 user / toolResult 开始"的协议约束。
- `skipInitialSteeringPoll: true` 告诉主循环"第一次的 ① poll 点跳过"，因为消息已经作为 prompts 被显式传入；不跳过就会 drain 两遍重复注入。

`createLoopConfig` 里靠一个闭包 flag 翻转一次：

```ts
let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
return {
  ...,
  getSteeringMessages: async () => {
    if (skipInitialSteeringPoll) { skipInitialSteeringPoll = false; return []; }
    return this.steeringQueue.drain();
  },
};
```

用闭包而不是类字段来控制"只跳一次"，是 JS 里最地道的实现。

---

## 5. 与交互层的绑定（以 pi 的 TUI 为例）

在 `interactive-mode` 里，Editor 上的按键映射：

- `Enter` → `agent.steer(message)` / 如果 agent 空闲则 `agent.prompt(message)`。
- `Alt+Enter` → `agent.followUp(message)`。
- `Escape` → `agent.abort()`，同时 `agent.clearAllQueues()` 把打字的内容回吐给 editor（见 "Escape aborts and restores queued messages to editor"）。

这让 Agent 层的抽象（两条队列 + poll 点）直接对应 UI 层的键位，职责清晰。UI 作者不需要知道主循环怎么 poll，只管 enqueue。

---

## 6. 可以直接学走的套路

1. **"随时写入、定点消费"的异步协调**：队列在 enqueue 处简单，主循环在确定的"安全点"做 poll。
2. **两条队列对称设计 + mode 开关**：统一数据结构，不同语义。
3. **找"上下文结构最干净的瞬间"注入**：tool 正在跑时不注入，避免破坏合法序列。
4. **poll 点精心选择（开头 / 每轮后 / agent_end 之前）**：每个 poll 都对应明确的用户需求，没有多余 poll。
5. **continue() 把 queue 当 prompt 处理**：协议约束"must start from user"被完美绕过。
6. **skipInitialSteeringPoll 用闭包状态**：跨函数传递"只跳一次"的语义不需要类字段。

这种"主循环 + 可安全注入的位置集"对任何长时运行的异步系统都是宝贵模板：CI pipeline、调度器、游戏帧循环、长对话机器人、媒体播放控制。你需要的是认真选择**哪些时刻外部指令可以安全地影响当前任务**，剩下的就是几十行队列代码。


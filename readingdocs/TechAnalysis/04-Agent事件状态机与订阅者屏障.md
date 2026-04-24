# 04 · Agent 事件状态机 + 订阅者屏障 (agent_end)

> 位置：`packages/agent/src/agent.ts`、`packages/agent/src/agent-loop.ts`、`packages/agent/src/types.ts`
>
> 提炼点：**Agent 不是简单的 for-loop，而是一个"分层事件机"——内部发事件、自己 reduce 状态、同时把事件广播给一串 async listener，并确保 `agent_end` 在所有 listener settle 之前 **不算** 结束。**

---

## 1. 为什么需要"事件 + 状态机"这一层

上一层 `agentLoop`（in `agent-loop.ts`）是**无状态的纯函数**：给它 messages/context/config，它返回 AgentMessage[]。但是真实应用里：

- UI 要在消息流式过程中更新（`streamingMessage`、`pendingToolCalls`）。
- 上游想随时 `abort()`，并能通过 `await agent.waitForIdle()` 等待干净结束。
- 扩展（Extension、持久化）要 `subscribe(event)`，并且往往要**异步**地处理事件：写磁盘、插入组件、刷新 SessionManager。
- 这些 async listener 必须在 `agent_end` 真正完成前被等完，否则 prompt 返回后 state 还是错的。

`Agent` 类就是在 `agentLoop` 外面加一层"状态维护 + 事件广播 + 生命周期管理"。

---

## 2. AgentEvent 的事件拓扑

看 `types.ts`：

```ts
type AgentEvent =
  | { type: "agent_start" }
  | { type: "turn_start" }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; assistantMessageEvent: AssistantMessageEvent; message: AgentMessage }
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId; toolName; args }
  | { type: "tool_execution_update"; ...; partialResult }
  | { type: "tool_execution_end"; toolCallId; toolName; result; isError }
  | { type: "turn_end"; message; toolResults }
  | { type: "agent_end"; messages: AgentMessage[] };
```

几个典型事件关系：

```
agent_start
├─ turn_start
│  ├─ message_start (user)
│  ├─ message_end   (user)
│  ├─ message_start (assistant)
│  │  ├─ message_update × N  (含底层 AssistantMessageEvent)
│  │  └─ message_end  (assistant)
│  ├─ tool_execution_start
│  │  ├─ tool_execution_update × ?
│  │  └─ tool_execution_end
│  ├─ message_start (toolResult)
│  ├─ message_end   (toolResult)
│  └─ turn_end
├─ turn_start  (下一轮)
│  ...
└─ agent_end   (整个 run 结束的信号)
```

这张嵌套图揭示两件事：

1. **事件有层级但扁平发射**。没有套 begin/end 配对的树结构，全部放在一个 stream 里，消费者通过 switch case 识别。
2. **`message_update` 把下层 AssistantMessageEvent 透传出来**。上层不想处理细节可以无视它；想做 token 级 UI 的消费者只要解包即可。

---

## 3. 状态 reduce：内部 reducer 优先 listener

看 `Agent.processEvents`：

```ts
private async processEvents(event: AgentEvent): Promise<void> {
  switch (event.type) {
    case "message_start":  this._state.streamingMessage = event.message; break;
    case "message_update": this._state.streamingMessage = event.message; break;
    case "message_end":
      this._state.streamingMessage = undefined;
      this._state.messages.push(event.message);
      break;
    case "tool_execution_start": { ... pendingToolCalls.add ... }
    case "tool_execution_end":   { ... pendingToolCalls.delete ... }
    case "turn_end":
      if (event.message.role === "assistant" && event.message.errorMessage)
        this._state.errorMessage = event.message.errorMessage;
      break;
    case "agent_end": this._state.streamingMessage = undefined; break;
  }

  const signal = this.activeRun?.abortController.signal;
  for (const listener of this.listeners) {
    await listener(event, signal);
  }
}
```

注意顺序：

1. **先 reduce 内部状态**（`_state.messages`, `pendingToolCalls`, `streamingMessage`）。
2. **再按注册顺序串行 await listener**。

这个顺序是刻意设计的：

- 第三方 listener 在收到事件时，`agent.state` 已经是"事件对应的最新状态"。他们写 `agent.state.messages.length` 看到的是把这条消息算进去之后的数字。
- 所有 listener 串行 `await`，意味着"状态的 reduce 结果不会被下一次事件覆盖"——即使某个 listener 很慢。

### 3.1 pendingToolCalls 的不可变语义

```ts
case "tool_execution_start": {
  const pendingToolCalls = new Set(this._state.pendingToolCalls);
  pendingToolCalls.add(event.toolCallId);
  this._state.pendingToolCalls = pendingToolCalls;
  break;
}
```

**没有直接 `.add`，而是 copy + add**。为什么？

- 外面的 UI 可能拿到一个 Set 引用、正在遍历。直接 mutate 会造成遍历中集合变化的 bug。
- 这样 `agent.state.pendingToolCalls` 每次都是一个新对象，React/lit 这类 UI 只要做引用比较就能判断变化，性能更好。

`messages`、`tools` 的 setter 也用了同样的"top-level copy"策略（见 `createMutableAgentState` 里的 getter/setter）。

---

## 4. `agent_end` 作为"屏障"的精髓

README 里有一段直白的说明：

> `agent_end` 意味着不会再有 loop 事件发出了，但 `await agent.waitForIdle()` 或 `await agent.prompt(...)` **只有在** awaited `agent_end` 的 listener 全部 settle 之后才 resolve。

看 `runWithLifecycle`：

```ts
private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abortController = new AbortController();
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  this.activeRun = { promise, resolve: resolvePromise, abortController };

  this._state.isStreaming = true;
  ...

  try {
    await executor(abortController.signal);   // 真正的 agentLoop 运行 + emit
  } catch (error) {
    await this.handleRunFailure(error, abortController.signal.aborted);
  } finally {
    this.finishRun();
  }
}
```

要点：

1. **`activeRun` 内部有个 Promise**，`prompt()` 返回的其实就是它。
2. **所有 `emit(event)` 都是 await 的**（看 `agentLoop` 里每一个 `await emit(...)`）。这意味着一个事件里 listener 没跑完，主循环就停着。
3. `agent_end` 是主循环最后 emit 的事件：

```ts
// agent-loop.ts
await emit({ type: "agent_end", messages: newMessages });
```

4. 这个 `await` 直到 **所有 listener 对 agent_end 的处理都结束** 才返回。
5. 只有到了 `finally { this.finishRun(); }` 里，`isStreaming` 才变 false、`activeRun.resolve()` 才被调用。
6. 调用方 `await agent.prompt(...)` 就是在等这个 resolve。

这个链路的巧妙在于**把"事件广播完成"和"prompt 返回"语义绑死**。第三方 listener（比如 SessionManager 的"写入 JSONL"）有机会在 prompt 返回前把当前 run 的所有消息落盘，不需要外部再手动同步。

### 4.1 为什么一定要这样？

想象一个场景：用户写 `await agent.prompt("..."); console.log(session.messages);`。

- 如果 listener 是 fire-and-forget 的，`console.log` 看到的可能还是旧数据。
- 如果 prompt 在 agent_end emit 之前返回，listener 根本没收到 agent_end。
- 只有"prompt 返回 ⇄ agent_end listeners settled"严格等价，上层代码才能假定"run 结束 = 所有状态已经同步完毕"。

这是写流式系统时最容易踩坑、最难调试的一类问题。`Agent` 通过在底层把所有 emit 都改成 `await` 并封装好生命周期，把这个保证做到了默认的。

---

## 5. `handleRunFailure` 把异常变回事件

```ts
private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
  const failureMessage = { role: "assistant", content: [{ type: "text", text: "" }],
    api: ..., provider: ..., model: ..., usage: EMPTY_USAGE,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  } satisfies AgentMessage;
  this._state.messages.push(failureMessage);
  this._state.errorMessage = failureMessage.errorMessage;
  await this.processEvents({ type: "agent_end", messages: [failureMessage] });
}
```

三件事都做得极有讲究：

1. **把异常变成 AgentMessage 塞进 messages**：UI 直接能渲染错误，session 也能把"这次 run 失败了"持久化。
2. **emit 一次 `agent_end`**：listener 收到的就是一个合法的生命周期闭环。没有"run 结束了但没收到 end 事件"这种分支。
3. **依然走 `processEvents`**：保证 listener 拿到的状态是最新的（含 errorMessage）。

这把"同步 throw"和"异步 event"两个世界无缝缝合了。

---

## 6. 可以直接拿走用的套路

1. **把"纯算法循环"和"状态/生命周期管理"分层**：`agentLoop` 不认识 Agent，`Agent` 组合 `agentLoop`。
2. **所有 emit 都 `await`**：让 listener 的异步工作被自然纳入主流程。
3. **reduce 优先，listener 在后**：第三方处理器看到的状态和事件一致。
4. **`agent_end` 是"所有 listener 都完成"的屏障**：prompt 返回 = 状态全部同步完成。
5. **异常 → 失败 AgentMessage → emit agent_end**：错误路径和正常路径拥有相同事件闭环。
6. **状态更新用 copy-on-write**：UI 层做引用比较即可检测变化，避免 mutate 踩坑。

任何你做的 "AI workflow / RPC loop / SSE 聚合" 都可以套用这套模板。关键是**认识到"event-driven"不等于"fire-and-forget"**：你要让事件 emit 本身是一个可等待的 await point，才能写出"结束就是结束"的系统。


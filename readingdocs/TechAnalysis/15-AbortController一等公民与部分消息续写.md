# 15 · AbortController 一等公民 + 部分消息可续写

> 位置：`packages/ai/src/types.ts`（`signal: AbortSignal`）、各 Provider 的 fetch 调用、`packages/agent/src/agent.ts` 的 `runWithLifecycle`、`packages/ai/src/providers/transform-messages.ts` 里对 `aborted` 消息的处理
>
> 提炼点：**在整个 agent stack 的每一层都把 `AbortSignal` 做成必备参数，"取消"不被当作异常错误，而是一种合法 stopReason。最终消息总是可得，部分内容不丢失，可以作为 `user` 重新续写。**

---

## 1. 问题：LLM 调用 + tool 执行 = 长时间、高消耗、可能要中途退出

一次普通的 agent run 可能包含：

- LLM 流式响应 5-30 秒。
- 多个 tool 执行，每个 0.1-60 秒。
- 某些 tool 自带子进程（bash / playwright）要跟着 abort。
- 某些 Provider 有 cleanup 需求（OpenAI Responses 的 session 绑定）。

用户按下 Esc、UI 关掉 tab、上层流程判定超时、deploy 停机——这些都要求**从 UI 一条 signal 触发，沿着栈所有 await 点干净中止**。

写得不好的 SDK 会让"取消"变成异常链抛到天上、资源泄漏、部分写入未提交。pi-ai + pi-agent 把 abort 做成了 first-class 语义。

---

## 2. `signal` 作为必备字段贯穿整个类型栈

```ts
// StreamOptions
export interface StreamOptions {
  signal?: AbortSignal;
  ...
}

// AgentTool 的 execute
execute: (
  toolCallId: string,
  params: Static<TParameters>,
  signal?: AbortSignal,        // ← tool 必然收到 signal
  onUpdate?: AgentToolUpdateCallback<TDetails>,
) => Promise<AgentToolResult<TDetails>>;

// beforeToolCall / afterToolCall 钩子也收到 signal
beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
afterToolCall?: ( ... , signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;

// Agent.subscribe 监听器也收到当前 run 的 signal
agent.subscribe(async (event, signal) => { ... });
```

注意一条很关键的设计：**信号沿着每一层传下去，每个 async API 都原生支持**。一次 cancel 不需要手动从外层 reach-down，而是所有人自动收到。

---

## 3. `Agent.runWithLifecycle`：一个 AbortController 管全局

```ts
private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const abortController = new AbortController();
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => { resolvePromise = resolve; });
  this.activeRun = { promise, resolve: resolvePromise, abortController };

  this._state.isStreaming = true;
  ...
  try {
    await executor(abortController.signal);
  } catch (error) {
    await this.handleRunFailure(error, abortController.signal.aborted);
  } finally {
    this.finishRun();
  }
}

abort(): void {
  this.activeRun?.abortController.abort();
}
```

一次 run = 一个 AbortController。`agent.abort()` 只是调用那个 controller 的 abort。信号自动向下广播到：

- streamFn（`AssistantMessageEventStream` 的 provider 实现里 fetch 的 signal）
- tool.execute 的 signal 参数
- before/afterToolCall 钩子的 signal 参数
- subscribe listener 的 signal 参数

**"一个 controller、全栈感知"**是这套架构的核心。用户的"按 Esc" → `agent.abort()` → fetch 立刻 abort、tool 子进程收到 signal、listener 也看到 aborted 状态。

---

## 4. 取消不是异常，是一种 StopReason

常见的 SDK 设计是"abort 抛出 AbortError"。pi-ai 不这么写：

```ts
// types.ts
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

// AssistantMessageEvent
| { type: "error"; reason: Extract<StopReason, "aborted" | "error">; error: AssistantMessage }
```

`aborted` 和 `error` 并列成为 StopReason 的两种"异常值"，二者都会发送 `error` 事件，但 **`reason` 字段区分哪种**。

而且注意：**`error.error` 仍然是一个合法的 `AssistantMessage`**，包含：

- `stopReason: "aborted"`
- `errorMessage: string`（提供 abort 的理由，如 "The operation was aborted"）
- `content`：**此刻已经拿到的部分文本 / thinking / tool_call**
- `usage`：已经消耗的 token 数

所以 abort 不代表"什么都没有"。UI 可以把那截已收到的文本展示出来。Session JSONL 里也是完整记录一条带 `stopReason: "aborted"` 的消息。

---

## 5. 部分消息可以续写

看 README 的"Continuing After Abort"：

```ts
// 第一次：中途 abort
const controller1 = new AbortController();
setTimeout(() => controller1.abort(), 2000);
const partial = await complete(model, context, { signal: controller1.signal });

// 直接把部分响应加入 context
context.messages.push(partial);
context.messages.push({ role: "user", content: "Please continue" });

// 再次请求
const continuation = await complete(model, context);
```

这在其他 SDK 里几乎是不可能的——大部分库要么"aborted 没有结果"、要么"partial result 格式不合法不能塞回 context"。

pi-ai 之所以能做到，是因为：

### 5.1 AssistantMessage 永远是合法的

即使内部状态是"thinking 刚开始、一个 tool_call 半截"，在流发出 `error` / `done` 事件的那一刻，Provider 实现都会**整理**成一条**合法**的 AssistantMessage——要么整个 thinking 块（可能空）、要么整个 text 块。

### 5.2 `transformMessages` 会丢弃 aborted 的 assistant

第 3 篇讲过：`transformMessages` 里遇到 `stopReason === "aborted"` 的 assistant **直接 skip**：

```ts
if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;
```

这意味着：**aborted 消息在 UI / session 里保留**，但**从不送给 LLM**。下一次 LLM 调用看到的是"用户说：请继续"，LLM 从它自己最近一次合法的 assistant 那里接着说。永远不会因为 partial 数据出错。

---

## 6. tool 层的 signal honor：tool 作者的契约

agent-loop 的 `executePreparedToolCall` 把 signal 传给 tool：

```ts
const result = await prepared.tool.execute(
  prepared.toolCall.id,
  prepared.args as never,
  signal,                     // ← 这里
  (partialResult) => { ... }
);
```

但 signal 只有 tool 内部真的"看"才有用。pi 的 builtin tools 都很自觉：

```ts
// bash tool（简化）
const result = await runBash(command, { signal });

// read tool
if (signal?.aborted) throw new Error("Aborted");
const content = await readFile(path);

// grep / find
spawnSync("grep", args, { signal });  // child_process 原生支持
```

所有网络请求 fetch、所有 child_process spawn、所有 stream pipe 都挂了 signal。

文档里明确要求 tool 作者：**"tool is responsible for honoring [the abort signal]"**。这条契约让"一按 Esc 所有跑着的 bash 都真正退出"成为现实。

---

## 7. `handleRunFailure` 统一处理取消 vs 错误

```ts
private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
  const failureMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    ...,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  } satisfies AgentMessage;
  this._state.messages.push(failureMessage);
  this._state.errorMessage = failureMessage.errorMessage;
  await this.processEvents({ type: "agent_end", messages: [failureMessage] });
}
```

仅用 `signal.aborted` 一个布尔就区分了两种失败路径，分别赋不同 stopReason。UI / session 都可以可靠区分"用户主动中止" vs "真的出错"。

---

## 8. 几个容易写错的细节（这里都做对了）

### 8.1 `AbortController` 不能复用

一个 controller abort 之后永远不能"取消取消"。所以 pi-agent **每次新 run 都 new 一个**。
如果误用旧 controller，abort 了之后下次 prompt 会立刻失败。

### 8.2 监听器也要拿到 signal

```ts
agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") await flushSessionState(signal);  // 写磁盘也要能被打断
});
```

`agent_end` 的 listener 可能在做 IO（存 session 文件）。把 signal 传过去让 listener 也能短路，**防止"agent 已经说取消，存盘还在慢慢写"的黑洞**。

### 8.3 abort 之后 event pipeline 仍要发 `agent_end`

否则 `waitForIdle()` 死锁。`handleRunFailure` 里刻意 `emit agent_end` 就是这个目的。

---

## 9. 可以直接用走的套路

1. **signal 从上到下传参，每一层 API 原生接**：不要靠 closure 捕获。
2. **abort 不是异常，是合法的 StopReason**。事件协议要有位置表达它。
3. **部分消息照样合法 + 可作为"再来一次"的起点**：partial 永远是有效 AssistantMessage。
4. **跨 Provider 投影时 skip 掉 aborted 消息**（第 3 篇）：让"续写"语义在任意 Provider 下稳定。
5. **tool 作者的契约要显式写进文档**：不 honor signal 的 tool 是 bug。
6. **一次 run = 一个 AbortController**，绝不复用。
7. **listener 也拿 signal**：长 IO 监听器也要能短路。
8. **取消路径一定要 emit 终止事件**：否则等待者死锁。

任何"长任务 + 用户可中断"的系统：长爬虫、后台 ETL、CI 步骤、游戏加载、音视频播放，套这 8 条一条不落能写出非常稳的取消逻辑。


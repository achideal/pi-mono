# 01 · 统一事件流协议 —— AssistantMessageEventStream

> 位置：`packages/ai/src/utils/event-stream.ts`、`packages/ai/src/types.ts`、`packages/agent/src/agent-loop.ts`
>
> 提炼点：**以一个"可异步迭代 + 可 await 最终结果"的小类，统一抽象所有 Provider 流，做到"实时观测"和"最终取值"零成本共存。**

---

## 1. 要解决的真问题

做一个能兼容 OpenAI / Anthropic / Google / Bedrock 等十几个 LLM 的 SDK，最容易的做法是给每家都写一套类型和回调。结果是：

- OpenAI 吐 SSE，Anthropic 吐 event-stream，Google 吐自己的 chunk，Bedrock 吐 AWS SDK Response。
- 用户有人想"边流边更新 UI"，有人想"我只要最终消息，不关心过程"。
- 流里混着 text / thinking / tool call，每种有 start / delta / end；还得有错误、abort 路径。

如果没有一层统一抽象，Agent 层就要自己写 switch，UI 层要再写一次，所有 Provider 作者都要自己维护一遍事件类型。

`pi-ai` 用 **一个事件协议 + 一个通用 `EventStream` 类**，把这些全部抹平。

---

## 2. 事件协议的一致性设计

`packages/ai/src/types.ts` 里定义的 `AssistantMessageEvent` 是这套体系的根基：

```ts
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "thinking_start" | "thinking_delta" | "thinking_end"; ... }
  | { type: "toolcall_start" | "toolcall_delta" | "toolcall_end"; ... }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };
```

这里有几个非常值得学习的设计：

### 2.1 每个事件都携带 `partial: AssistantMessage`

`start` / `text_delta` / `toolcall_delta` 都带着"当前累积到此刻的完整消息对象"。消费者不用自己维护"我已经看到了哪几段文本、哪几个工具调用被拼了多少"。
UI 可以直接 `setState(event.partial)`，永远拿到截至此事件的最新快照。

### 2.2 三元组 start / delta / end

每种内容块（text / thinking / toolCall）都严格走 `*_start → *_delta+ → *_end`。这使得：

- **UI 布局可预先占位**：收到 `text_start` 就知道要新建一个文本气泡。
- **中间态安全**：delta 不保证是完整 JSON / 完整词，`_end` 事件才给出 `content`。
- **跨 Provider 统一**：Google 不支持流式 tool call 参数，它仍然会合成一个 `toolcall_delta + toolcall_end`，消费方零感知。

### 2.3 终止一定走 `done` 或 `error`

这意味着消费者有且只有两种结束姿势。不会出现"某个 Provider 忘记发 end 事件"这种历史包袱。
`error` 也**一定会带回** `AssistantMessage`（可能是部分文本 + `stopReason: "error" | "aborted"`）。`abort` 被当作一类错误处理，和真错误走同一个口子。

---

## 3. EventStream 类的内部实现

核心只有 60 行：

```ts
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
    if (this.done) return;
    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }
    const waiter = this.waiting.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
  }
```

它把"推 / 拉"两种消费模型用极简代码统一了：

1. **生产者只知道 push**：不关心谁在消费、消费得多快。
2. **消费者两种用法同时存在**：
   - `for await (const ev of stream)` —— 实时流
   - `const msg = await stream.result()` —— 最终消息
3. **背压天然处理**：消费快、生产慢 → 消费方被 `new Promise` 挂起，等 push 叫醒；生产快、消费慢 → 事件排进 `queue`。

最精妙的是 **`isComplete` 和 `extractResult` 作为构造参数注入**：

```ts
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => (event.type === "done" ? event.message : event.error),
    );
  }
}
```

基类完全不懂 LLM，也不需要懂。任何遵循同一协议的业务都能复用。agent 包的 `createAgentStream()` 同样直接复用了这个基类：

```ts
// packages/agent/src/agent-loop.ts
function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream<AgentEvent, AgentMessage[]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}
```

同一个原语服务两个层级，只因为"结束条件"和"结果提取"是可注入的。

---

## 4. 并发语义的几个细节

### 4.1 `end()` 可不带结果

```ts
end(result?: R): void {
  this.done = true;
  if (result !== undefined) this.resolveFinalResult(result);
  while (this.waiting.length > 0) {
    const waiter = this.waiting.shift()!;
    waiter({ value: undefined as any, done: true });
  }
}
```

为什么 `end` 仍然可选参数？因为大多数情况下，最终结果已经通过 `push({ type: "done", ... })` 随最后一个事件塞进去了；`end()` 主要是**兜底**，用来在**异常路径**或**lazy-load 失败**时强行关闭流。

看 `register-builtins.ts` 里的懒加载失败分支：

```ts
.catch((error) => {
  const message = createLazyLoadErrorMessage(model, error);
  outer.push({ type: "error", reason: "error", error: message });
  outer.end(message);
});
```

先 push 一个 `error` 事件让所有观察者收到，再 `end` 去叫醒"只等 result"的消费者。

### 4.2 同一个事件既进 `queue` 也进 `waiting`？

不会。`push` 用 `queue.shift()`/`waiting.shift()` 二选一，保证事件恰好被投递到一个目的地。这避免了"事件被消费两次"。

### 4.3 `result()` 和 `for await` 可以同时存在

这是该设计最大的好处。比如 `stream.ts` 里：

```ts
export async function complete<TApi extends Api>(model, ctx, opts) {
  const s = stream(model, ctx, opts);
  return s.result();
}
```

`complete` 不需要自己 for-await 就能拿到最终消息；而调用者完全可以保留 `stream` 的引用并且 `for await` 观察过程事件。同一个对象同时承担了"promise"和"async iterable"两种身份，不需要重复消费。

---

## 5. 与 Agent 层的事件分层

注意上层 `agent` 包也用 `EventStream`，但事件不是这里的 `AssistantMessageEvent` 而是更粗粒度的 `AgentEvent`（`message_start` / `message_update` / `turn_end` / `tool_execution_*`）。
两层关系是：

```
Provider SSE chunks
      ↓
AssistantMessageEventStream (细粒度：text_delta / thinking_delta)
      ↓
agent-loop 将其翻译成 AgentEvent
      ↓
AgentEventStream (粗粒度：message_start/turn_end/tool_execution_*)
      ↓
Agent 类再 reduce 到 AgentState 并通知订阅者
```

下层"一字一字"的事件被上层"一次 message 完成"的事件吸收，UI 只需要订阅自己层级需要的那一种。

---

## 6. 可以直接学走的套路

1. **事件流 = async iterable + result promise 双身份**：一个小类解决"观察过程"与"等待终值"的冲突。
2. **事件终止条件用回调注入**：让通用原语跨业务复用。
3. **每个 delta 都带 `partial`**：消费方无需累积状态，UI 层直接渲染。
4. **错误 / abort 统一成一类事件，但最终消息永远可得**：避免"错误路径没有消息"的破坏性差异。
5. **每层 agent stack 用同一个原语分层包装**：上层不穿透下层事件，但共享同一套并发模型。

如果你以后要在自己的项目里写"SSE / WebSocket / LLM / RPC"的流处理层，这 60 行几乎是可以直接抄走的模板。


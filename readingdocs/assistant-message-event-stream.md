# AssistantMessageEventStream 从零讲解

本文面向完全不熟悉异步生成器、Promise、TypeScript 语法的读者，目标是把 `packages/ai/src/utils/event-stream.ts` 讲清楚，尤其解释下面这些问题：

- `EventStream` 到底是什么
- `AssistantMessageEventStream` 为什么要继承它
- 构造函数里传进去的两个函数是干什么的
- `waiting` 里放的函数到底是谁传进来的
- `const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));` 到底做了什么
- 一个 `AssistantMessageEventStream` 对象在实际使用时，生产者和消费者如何围绕同一个对象协作
- 它和 LLM 一边吐字一边更新 UI 的关系是什么

---

## 1. 先给一句最短总结

`AssistantMessageEventStream` 本质上是一个“支持异步等待的事件队列”。

它解决的问题是：

1. 上游大模型会不断产生事件，比如“开始了”“吐出一点文本”“吐出一点 thinking”“开始 tool call”“结束了”
2. 下游调用方希望一边收到这些事件，一边更新界面或状态
3. 上下游速度不一定一致，所以中间需要一个对象负责协调

这个负责协调的对象就是 `EventStream` / `AssistantMessageEventStream`。

你可以把它理解成一个“中间水管”或者“消息中转站”：

- 上游往里面塞事件
- 下游从里面取事件
- 如果事件先到了，就先存着
- 如果下游先来等，就把“唤醒它的方法”先记下来
- 一旦新事件到了，就立刻把等待中的下游叫醒

---

## 2. 先区分两个类：`EventStream` 和 `AssistantMessageEventStream`

在 `packages/ai/src/utils/event-stream.ts` 里，核心有两个类：

### 2.1 `EventStream<T, R = T>`

这是一个通用基础类，不知道你的业务是什么。

它只负责做这几件事：

- 存放事件
- 允许异步逐个读取事件
- 在没有事件时让读取方等待
- 在结束时交出一个“最终结果”

这里的泛型含义是：

- `T`：流中的单个事件类型
- `R`：最终结果类型

举个抽象例子：

- 如果这是一个数字流，那么 `T` 可以是 `number`
- 如果这是一个 AI 消息事件流，那么 `T` 可以是 `AssistantMessageEvent`
- 如果流结束后想拿到最终完整消息，那么 `R` 就是 `AssistantMessage`

所以：

- `EventStream` = 通用机制
- `AssistantMessageEventStream` = 这个机制在 AI 消息场景里的具体版本

### 2.2 `AssistantMessageEventStream`

它是这样定义的：

```ts
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") {
          return event.message;
        } else if (event.type === "error") {
          return event.error;
        }
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}
```

它做的事情非常少，但很关键：

- 指定流里的事件类型是 `AssistantMessageEvent`
- 指定最终结果类型是 `AssistantMessage`
- 告诉父类：哪些事件算“流结束”
- 告诉父类：结束时最终结果应该从哪里拿

---

## 3. `AssistantMessageEvent` 到底有哪些事件

在 `packages/ai/src/types.ts` 里，`AssistantMessageEvent` 大致长这样：

- `start`
- `text_start`
- `text_delta`
- `text_end`
- `thinking_start`
- `thinking_delta`
- `thinking_end`
- `toolcall_start`
- `toolcall_delta`
- `toolcall_end`
- `done`
- `error`

这说明这个流里流动的不是“纯字符串”，而是结构化事件。

也就是说，下游看到的不是简单的：

```ts
"你"
"好"
```

而是更像：

```ts
{ type: "start", partial: ... }
{ type: "text_start", contentIndex: 0, partial: ... }
{ type: "text_delta", contentIndex: 0, delta: "你", partial: ... }
{ type: "text_delta", contentIndex: 0, delta: "好", partial: ... }
{ type: "text_end", contentIndex: 0, content: "你好", partial: ... }
{ type: "done", reason: "stop", message: ... }
```

为什么要这么复杂？因为 LLM 的输出不只是“纯文本”。它可能包含：

- 普通文本
- thinking / reasoning
- tool call 参数流式生成
- 最终完整消息
- 错误结束信息

所以这里定义的是一套“事件协议”，而不是一个简单字符串流。

---

## 4. `EventStream` 的 5 个关键字段分别是什么

`EventStream` 里面最核心的状态是这几个：

```ts
private queue: T[] = [];
private waiting: ((value: IteratorResult<T>) => void)[] = [];
private done = false;
private finalResultPromise: Promise<R>;
private resolveFinalResult!: (result: R) => void;
```

下面一个个解释。

### 4.1 `queue`

这是“已经到达、但还没人拿走的事件列表”。

你可以把它理解成一个篮子：

- 如果生产者已经推了事件
- 但消费者当时没有正在等
- 那就先把事件放进 `queue`

稍后消费者来取时，就从 `queue` 里拿。

### 4.2 `waiting`

这是“正在等待下一个事件的人”的列表。

但是它存的不是“人”，而是“叫醒这个人的函数”。

这一点非常关键。`waiting` 里放的函数，其实就是 Promise 的 `resolve` 函数。这个函数不是业务层手写传进来的，而是 JavaScript 在执行 `new Promise(...)` 时自动给的。

### 4.3 `done`

表示整个流是否已经结束。

- `false`：还可能继续来事件
- `true`：不会再有新事件

### 4.4 `finalResultPromise`

这是一个“最终结果 Promise”。

流式事件是一回事，但很多时候上层还想在结束后一次性拿到完整的最终结果。于是这个类额外维护一个 Promise：

- 事件可以一条条往外流
- 最后完整消息可以通过 `result()` 一次性拿到

### 4.5 `resolveFinalResult`

这是用来“手动完成最终结果 Promise”的函数。

它会在构造函数里被赋值，流结束时调用。

---

## 5. 构造函数里为什么要传两个函数

`EventStream` 的构造函数是：

```ts
constructor(
  private isComplete: (event: T) => boolean,
  private extractResult: (event: T) => R,
)
```

很多人第一次看这里都会疑惑：为什么不直接写死？

答案是：因为 `EventStream` 是通用的，它不应该知道你的业务规则。

它只负责“机制”，不负责“业务语义”。

### 5.1 第一个函数：`isComplete`

签名是：

```ts
(event: T) => boolean
```

意思是：

“给我一个事件，你告诉我它是不是结束事件。”

对 `AssistantMessageEventStream` 来说，规则是：

```ts
(event) => event.type === "done" || event.type === "error"
```

也就是说：

- `done` 算结束
- `error` 也算结束
- 其他都不算结束

### 5.2 第二个函数：`extractResult`

签名是：

```ts
(event: T) => R
```

意思是：

“既然这是结束事件，那最终结果应该从这个事件的哪里取出来？”

在 `AssistantMessageEventStream` 里：

- 如果是 `done`，最终结果在 `event.message`
- 如果是 `error`，最终结果在 `event.error`

所以它传进去的是：

```ts
(event) => {
  if (event.type === "done") {
    return event.message;
  } else if (event.type === "error") {
    return event.error;
  }
  throw new Error("Unexpected event type for final result");
}
```

### 5.3 为什么这种设计是合理的

因为父类只想做一件事：

“当我发现一个事件满足 `isComplete(event)` 时，我就知道流该结束了，并且我应该通过 `extractResult(event)` 得到最终结果。”

于是父类可以通用，而子类只负责提供规则。

---

## 6. 构造函数里 `finalResultPromise` 是怎么建起来的

构造函数内部还有这一段：

```ts
this.finalResultPromise = new Promise((resolve) => {
  this.resolveFinalResult = resolve;
});
```

这里在做什么？

### 6.1 Promise 的最小理解

`new Promise((resolve) => { ... })` 里的 `resolve` 不是你自己传进去的，是 JavaScript 自动给你的。

你可以把它理解成：

“当未来某个时刻时机成熟时，调用这个函数，就代表这个 Promise 完成了。”

### 6.2 这里为什么要把 `resolve` 存起来

因为“最终结果什么时候出来”，不是构造函数现在就知道的，而是以后流走到 `done` / `error` 才知道。

所以这里做的事是：

- 先创建一个 Promise
- 把它的 `resolve` 存进 `this.resolveFinalResult`
- 等将来流结束时再调用

这就是一种典型的“先创建承诺，稍后兑现”的写法。

---

## 7. `push(event)` 做了什么

这是生产者往流里塞事件的方法：

```ts
push(event: T): void {
  if (this.done) return;

  if (this.isComplete(event)) {
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));
  }

  const waiter = this.waiting.shift();
  if (waiter) {
    waiter({ value: event, done: false });
  } else {
    this.queue.push(event);
  }
}
```

这段代码可以拆成 3 步：

### 7.1 如果已经结束，就直接不收了

```ts
if (this.done) return;
```

说明：

- 流结束后，后续再 `push` 没意义
- 这个保护是合理的

### 7.2 如果当前事件本身就是结束事件，就把流标记为结束

```ts
if (this.isComplete(event)) {
  this.done = true;
  this.resolveFinalResult(this.extractResult(event));
}
```

翻译成人话：

- 如果这是 `done` 或 `error`
- 那么流到此为止
- 并且把最终结果交给 `finalResultPromise`

也就是说，`result()` 之所以最终能返回完整消息，就是因为这里调用了 `resolveFinalResult(...)`。

### 7.3 如果此刻有人在等，就直接把事件递给他；否则先入队

```ts
const waiter = this.waiting.shift();
if (waiter) {
  waiter({ value: event, done: false });
} else {
  this.queue.push(event);
}
```

这一步是整个类的核心协调逻辑。

- 如果消费者已经在等待，就直接叫醒它，把事件交给它
- 如果没人等待，就先把事件放进 `queue`

这就保证了两种情况都能正常处理：

- “消费者先等，事件后到”
- “事件先到，消费者后取”

---

## 8. `waiting` 里到底存的函数是谁传进来的

这是最容易卡住的点。

看这一句：

```ts
const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
```

这里的 `resolve` 到底是谁？

答案是：**JavaScript 在执行 `new Promise(...)` 时自动传给回调函数的。**

不是：

- 用户手动传的
- provider 手动传的
- 调用方手动传的

而是 JS 引擎给 Promise executor 的标准参数。

### 8.1 最小例子

```ts
let wakeUp: (value: string) => void;

const p = new Promise<string>((resolve) => {
  wakeUp = resolve;
});

// 这里 await p 会暂停

wakeUp!("hello");
// Promise 完成，await 恢复
```

所以：

- `resolve` = “以后拿来叫醒等待者的函数”
- `waiting.push(resolve)` = “把这个叫醒按钮存起来”

### 8.2 放到 `EventStream` 里理解

在 `EventStream` 里，这句话的意思是：

“现在没有数据可给消费者，那消费者先别继续往下走。我创建一个 Promise，把它的 `resolve` 记到 `waiting` 里。以后谁拿到新事件，谁就调用这个 `resolve` 把消费者叫醒。”

这就是为什么 `waiting` 里存的是函数。

---

## 9. `const result = await new Promise(...)` 这一句到底在干嘛

原句是：

```ts
const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
```

可以拆成 4 个动作：

### 9.1 创建一个新的 Promise

这个 Promise 暂时不会立刻完成，因为里面并没有马上调用 `resolve(...)`。

### 9.2 JS 自动给出一个 `resolve`

Promise 构造器会把 `resolve` 作为参数传给回调。

### 9.3 把这个 `resolve` 存进 `waiting`

于是 `waiting` 里记录了：“有一个消费者正在等，未来拿这个函数去叫醒它。”

### 9.4 `await` 让当前异步迭代暂停

因为 Promise 还没完成，所以 `await` 会停住，直到未来某个时刻有生产者调用那个 `resolve`。

也就是说，这一整句的真实含义是：

“现在没数据，先睡着，等以后有人把新事件送来。”

---

## 10. `[Symbol.asyncIterator]()` 是什么

`EventStream` 之所以能被这样使用：

```ts
for await (const event of response) {
  ...
}
```

靠的就是这个方法：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T> {
  while (true) {
    if (this.queue.length > 0) {
      yield this.queue.shift()!;
    } else if (this.done) {
      return;
    } else {
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}
```

### 10.1 最简单理解

只要一个对象实现了 `[Symbol.asyncIterator]()`，它就可以被 `for await ... of` 遍历。

你可以把它理解成：

“这个对象会在未来不断吐值，每次吐一个，不够时可以等。”

### 10.2 这里面有三种情况

#### 情况 A：`queue` 里已经有事件

```ts
if (this.queue.length > 0) {
  yield this.queue.shift()!;
}
```

意思是：

“事件已经准备好了，直接吐一个给消费者。”

#### 情况 B：流已经结束

```ts
else if (this.done) {
  return;
}
```

意思是：

“不会再有新事件了，结束异步迭代。”

#### 情况 C：目前没事件，但未来可能会有

```ts
else {
  const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
  if (result.done) return;
  yield result.value;
}
```

意思是：

“现在没数据，那我先暂停，等生产者以后来叫醒我。”

### 10.3 一定要分清两种不同的 `done`

很多人第一次看到这里会困惑：

```ts
const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
if (result.done) return;
yield result.value;
```

疑问通常是：

“消费者不是还等着最后一个 `done` 事件吗？为什么这里一看到 `done` 就直接 `return` 了？”

关键是：这里其实有两种完全不同的 “done”。

#### 第一种：业务事件里的 `done`

也就是：

```ts
{ type: "done", reason: "stop", message: ... }
```

这是一条真正的流内事件。

它和 `text_delta`、`thinking_delta` 一样，都是消费者会收到的业务数据，只不过它表示：

- 这是最后一个业务事件
- 它里面还带着最终完整 `message`

#### 第二种：`IteratorResult.done === true`

也就是异步迭代器协议里的：

```ts
{ value: undefined, done: true }
```

这不是一条业务事件。

它的意思只是：

- 迭代结束了
- 后面已经没有下一条事件可读了

`for await ... of` 遇到这种结果时，不会把它当作事件交给你处理，而是直接结束循环。

#### 两者在时间线上是怎样发生的

假设消费者此时正卡在：

```ts
const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
```

然后生产者推来最后一条业务事件：

```ts
stream.push({ type: "done", reason: "stop", message: output });
```

`push()` 会先把流标记成结束，并完成最终结果 Promise，但它仍然会把这条业务事件正常递给等待中的消费者：

```ts
waiter({ value: event, done: false });
```

注意这里是 `done: false`，因为这仍然是一条要交付给消费者的事件。

所以消费者醒来以后，拿到的是：

```ts
{ value: doneEvent, done: false }
```

于是不会直接 `return`，而是会继续：

```ts
yield result.value;
```

也就是说，消费者确实会收到最后那条 `type: "done"` 事件。

只有当消费者下一次继续取值时，异步迭代器才会发现：

- `this.done === true`
- 队列里也没有新事件了

这时才会真正结束迭代。

所以可以把这两个阶段记成：

1. 先收到最后一条业务事件：`event.type === "done"`
2. 再收到“没有下一条了”的协议结束信号：`IteratorResult.done === true`

因此，这里的：

```ts
if (result.done) return;
```

拦截的不是最后一条业务事件，而是“流已经彻底没有下一条了”这个迭代器层信号。

---

## 11. `end(result?)` 是什么作用

`end` 的代码是：

```ts
end(result?: R): void {
  this.done = true;
  if (result !== undefined) {
    this.resolveFinalResult(result);
  }
  while (this.waiting.length > 0) {
    const waiter = this.waiting.shift()!;
    waiter({ value: undefined as any, done: true });
  }
}
```

### 11.1 它和 `push(doneEvent)` 不是完全一回事

- `push(doneEvent)` 表示“一个真正的结束事件到来了，这个事件也要作为流的一部分传出去”
- `end()` 表示“流现在彻底关门，别再让等待者一直挂着了”

### 11.2 `end()` 的两个作用

#### 作用 1：把流标记为结束

```ts
this.done = true;
```

#### 作用 2：把所有等待中的消费者叫醒，并告诉它们“结束了”

```ts
waiter({ value: undefined as any, done: true });
```

这就避免了一个问题：

如果消费者正卡在 `await new Promise(...)` 上，而你不主动唤醒它，它可能会永远等下去。

### 11.3 为什么看起来有时即使不调 `end()` 也能工作

在单消费者场景里，很多人会继续追问：

“既然 `push(doneEvent)` 已经把最后一个 `done` 事件交给消费者了，那是不是其实不需要 `end()`？”

答案是：

- **对某些单消费者路径来说，看起来确实可以跑通**
- **但从这个通用抽象的设计上说，`end()` 仍然有明确作用**

#### 为什么单消费者里看起来像是可以不调

因为 `push(doneEvent)` 里本身就会先做这件事：

```ts
if (this.isComplete(event)) {
  this.done = true;
  this.resolveFinalResult(this.extractResult(event));
}
```

也就是说，最后一个 `done` / `error` 事件一进入流，`this.done` 就已经变成 `true` 了。

于是单个消费者收到这条最后事件以后，下一轮再进异步迭代器时，只要队列也空了，就会自然退出。

#### 那为什么还要有 `end()`

因为 `end()` 负责的是“彻底关流”和“收尾所有等待者”，它至少还有这几个用途：

1. 唤醒所有已经挂起在 `waiting` 里的读取者，给它们一个真正的迭代结束信号
2. 支持 `end(result)` 这种“直接结束流并给出最终结果”的路径
3. 让“最后一个业务事件”和“迭代器关闭”这两件事在语义上清晰分离

所以更准确的理解是：

- `push(doneEvent)` / `push(errorEvent)`：发出最后一个业务事件
- `end()`：把流本身彻底关闭

在这个项目的大多数 provider 里，这两步通常都会做。

---

## 12. `result()` 是做什么的

```ts
result(): Promise<R> {
  return this.finalResultPromise;
}
```

它非常简单，就是把之前在构造函数里建好的那个 Promise 返回出去。

这个方法的意义是：

- `for await` 用来看“过程”
- `result()` 用来看“最终完整结果”

这两条通道关注点不同：

- 事件消费者关心每次更新
- 最终结果消费者关心最后的完整消息

---

## 13. 在实际使用里，一个对象通常是不是只有一个生产者和一个消费者

### 13.1 实际上通常是：1 个生产者 + 1 个事件消费者

在这个项目里，通常可以这样理解：

- **生产者**：provider 内部那段后台异步逻辑
- **事件消费者**：上层 `for await (const event of response)` 的地方，比如 `agent-loop`

这种模式是最常见、最自然的。

### 13.2 但还经常会有一个“最终结果消费者”

也就是：

```ts
await response.result()
```

它和 `for await` 不是同一种消费：

- `for await` 消费的是事件序列
- `result()` 等的是最终 Promise

所以很多地方会出现：

- 一边 `for await` 地处理中间事件
- 一边在结束时 `await response.result()` 拿最终完整消息

### 13.3 理论上能不能有多个 `for await` 消费者

理论上你可以这么写，但这个类并不是“广播给每个消费者一份副本”。

它内部只有一份共享的：

- `queue`
- `waiting`

所以如果两个地方同时 `for await` 同一个流，它们会“抢同一个事件队列”，而不是各自都收到完整一套事件。

因此从设计意图上说：

- **一个流对象，最好只有一个事件消费者**
- `result()` 倒是可以被多人等待，因为它本质是同一个 Promise

---

## 14. 真实协作例子：OpenAI provider 作为生产者

看 `packages/ai/src/providers/openai-completions.ts`。

它会先创建一个流：

```ts
const stream = new AssistantMessageEventStream();
```

然后启动一个后台异步函数，开始请求上游 OpenAI 流。

先发出开始事件：

```ts
stream.push({ type: "start", partial: output });
```

接着一边读取上游 chunk，一边不断 `push`：

- 开始文本块：`text_start`
- 文本增量：`text_delta`
- 文本结束：`text_end`
- thinking 开始 / 增量 / 结束
- toolcall 开始 / 增量 / 结束

例如当收到文本增量时，代码会大致做：

```ts
currentBlock.text += choice.delta.content;
stream.push({
  type: "text_delta",
  contentIndex: blockIndex(),
  delta: choice.delta.content,
  partial: output,
});
```

最后成功结束时：

```ts
stream.push({ type: "done", reason: output.stopReason, message: output });
stream.end();
```

失败时：

```ts
stream.push({ type: "error", reason: output.stopReason, error: output });
stream.end();
```

这说明 provider 的角色很明确：

- 从上游 LLM 网络流读取 chunk
- 解析 chunk
- 更新当前 partial output
- 把结构化事件推到 `AssistantMessageEventStream` 里

所以它就是这个流对象的生产者。

---

## 15. 真实协作例子：`agent-loop` 作为消费者

在 `packages/agent/src/agent-loop.ts` 里，可以看到典型消费方式：

```ts
for await (const event of response) {
  switch (event.type) {
    case "start":
      ...
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
      ...
      break;

    case "done":
    case "error": {
      const finalMessage = await response.result();
      ...
      return finalMessage;
    }
  }
}
```

这个消费者做的事是：

- 收到 `start`：把 assistant 的部分消息先挂到上下文里
- 收到 `text_delta` / `thinking_delta` / `toolcall_delta`：持续更新上下文和界面
- 收到 `done` / `error`：通过 `result()` 拿最终完整消息，然后做收尾

你可以看到这里的模式非常清楚：

- `for await`：处理“中间过程”
- `result()`：拿“最终交卷结果”

---

## 16. 把完整协作流程按时间线走一遍

假设模型最终回答“你好”。

### 第 1 步：provider 创建流对象

```ts
const stream = new AssistantMessageEventStream();
```

这个对象随后会同时被两边使用：

- provider 往里面 `push`
- agent-loop 从里面 `for await` 地读取

注意：它们拿的是同一个对象，不是两个副本。

### 第 2 步：消费者先开始读取

`agent-loop` 进入：

```ts
for await (const event of response) { ... }
```

如果此时还没有任何事件，`[Symbol.asyncIterator]()` 会走到：

```ts
await new Promise((resolve) => this.waiting.push(resolve))
```

意思是：

- 当前没有事件
- 那消费者先暂停
- 并把“未来叫醒它的函数”放进 `waiting`

这时状态可以想象为：

- `queue = []`
- `waiting = [resolve1]`
- `done = false`

### 第 3 步：生产者发出 `start`

provider 调用：

```ts
stream.push({ type: "start", partial: output })
```

`push()` 发现 `waiting` 里有人，于是不会把事件放进 `queue`，而是直接调用：

```ts
waiter({ value: event, done: false })
```

由于 `waiter` 本质上就是 Promise 的 `resolve`，这会立即唤醒刚才暂停的消费者。

于是消费者收到 `start`。

### 第 4 步：消费者处理 `start`

`agent-loop` 收到 `start` 后，会把 partial message 加到上下文里，并发出 `message_start`。

这对应的效果是：

“assistant 开始说话了。”

### 第 5 步：消费者继续等待下一条事件

下一轮循环开始，如果还没有新事件，它又会再次进入等待状态，再把新的 `resolve2` 存到 `waiting`。

### 第 6 步：生产者收到第一个文本增量“你”

provider 解析到 LLM 的一个 chunk，于是：

```ts
stream.push({
  type: "text_delta",
  contentIndex: 0,
  delta: "你",
  partial: output,
})
```

此时因为有等待者，所以这个事件会被直接递给消费者。

消费者收到后更新界面，界面上开始出现“你”。

### 第 7 步：生产者收到第二个文本增量“好”

同理再推一次 `text_delta`。

消费者再次收到，界面变成“你好”。

### 第 8 步：生产者发出 `done`

当上游流结束，provider 调用：

```ts
stream.push({ type: "done", reason: "stop", message: output })
```

这时 `push()` 会先发现这是一个结束事件：

- `done = true`
- `resolveFinalResult(extractResult(event))`

对 `AssistantMessageEventStream` 来说，`extractResult(event)` 会取出 `event.message`，于是 `result()` 对应的 Promise 也完成了。

然后这个 `done` 事件本身还会继续作为流中的最后一个事件交给消费者。

### 第 9 步：消费者收到 `done`

`agent-loop` 在 `done` 分支里调用：

```ts
const finalMessage = await response.result();
```

因为刚才 `push(done)` 时已经完成了最终 Promise，所以这里能拿到完整消息。

然后它做最后一次上下文更新，并发出 `message_end`。

### 第 10 步：流彻底结束

provider 接着调用：

```ts
stream.end();
```

如果此刻还有某个地方卡在等待状态，`end()` 会把它唤醒，并告诉它 `done: true`，从而安全地结束整个异步迭代。

---

## 17. 为什么 `queue` 和 `waiting` 必须同时存在

这是理解设计的关键。

### 17.1 只有 `queue` 不够

如果只靠 `queue`，那么当消费者已经在等待时，生产者新推来事件后也只能先丢进数组。消费者未必能立刻被唤醒。

### 17.2 只有 `waiting` 也不够

如果只靠 `waiting`，那么当事件先到、消费者后到时，事件就没地方存，会丢失。

### 17.3 两者配合才能覆盖两种时序

- **事件先到**：先进 `queue`
- **消费者先等**：把 `resolve` 放进 `waiting`
- **事件后到时**：直接从 `waiting` 里取出等待者并唤醒

这是一个经典的“生产者-消费者协调结构”。

---

## 18. 一定要分清：事件消费和最终结果消费不是一回事

很多初学者会把这两者混在一起。

### 18.1 事件消费

```ts
for await (const event of response) {
  ...
}
```

这是“逐个吃事件”，关注过程。

### 18.2 最终结果消费

```ts
await response.result()
```

这是“等最终完整消息”，关注终点。

### 18.3 两者可以同时存在

比如 `agent-loop` 就是典型例子：

- `for await` 处理实时更新
- `result()` 拿最终结果

这两者不冲突。

---

## 19. 多个消费者时要注意什么

### 19.1 多个 `result()` 没问题

因为 `result()` 返回的是同一个 Promise，多个地方等待它，本质上只是多人等同一张成绩单。

### 19.2 多个 `for await` 不推荐

因为 `EventStream` 不是广播模型。

它内部只有一份共享的：

- `queue`
- `waiting`

所以多个 `for await` 会争抢同一份事件，不会各自拿到完整一份事件流。

因此在设计意图上，应当把它视为：

- 单生产者 / 单事件消费者
- 额外允许若干最终结果等待者

---

## 20. 如何把这整个对象牢牢记住

如果你只想记最核心的理解，可以记下面 7 句话：

1. `EventStream` 是一个支持异步等待的事件队列。
2. `AssistantMessageEventStream` 是它在 AI 消息场景下的具体版本。
3. `queue` 用来存“已经来了但还没被消费的事件”。
4. `waiting` 用来存“正在等事件的消费者对应的 Promise resolve”。
5. `await new Promise((resolve) => this.waiting.push(resolve))` 的意思是：“现在没数据，先睡着，等未来有人叫醒我。”
6. provider 是生产者，负责 `stream.push(...)`；`agent-loop` 是事件消费者，负责 `for await ... of stream`。
7. `result()` 是另一条通道，用来在流结束后一次性拿最终完整消息。

---

## 21. 最后一句总括

`AssistantMessageEventStream` 并不神秘。它做的事情本质上是：

- 用 `queue` 处理“事件先到”的情况
- 用 `waiting` 处理“消费者先等”的情况
- 用异步迭代器把这些事件一个个吐给下游
- 用 `result()` 提供最终完整结果
- 用 `done/error` 事件把“流式过程”和“最终交卷”连接起来

如果把这个类看成“一个能让上下游在不同速度下也能顺利协作的中间队列”，它的整体设计就会非常清楚。

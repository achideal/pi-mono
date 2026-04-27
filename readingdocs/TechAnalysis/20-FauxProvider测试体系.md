# 20 · Faux Provider 测试体系：零真实 API 依赖的确定性回放

> 位置：`packages/ai/src/providers/faux.ts` 的 `registerFauxProvider` / `fauxAssistantMessage` / `fauxText` / `fauxThinking` / `fauxToolCall`；`packages/coding-agent/test/suite/harness.ts` 的集成使用
>
> 提炼点：**实现一个**同构的**第 N 家 Provider，但"请求"是查队列、"流"是按节拍吐字，让 Agent / Coding-Agent 的测试完全不依赖任何真实 LLM API、不花任何 token、结果 100% 可复现。**

---

## 1. 测试 agent 为什么那么难

你有一个复杂的 agent，想测"给定 X 指令 + 这些 tools，它会正确调用 tool Y 三次然后总结"。传统做法：

- **用真 API**：又贵、又慢、又不稳（同一个 prompt 同一个模型可能每次回的不一样）。
- **手写 fake**：每个测试 case 都要 mock 整个流，重复代码多到爆。
- **录像回放（VCR）**：需要录，录完 schema 改一改就全坏。

pi-ai 的 Faux Provider 是第四条路：**让 faux 伪装成一个真 Provider，注册到同一张注册表里，然后写测试时用 `setResponses([...])` 向它的队列里塞预设响应**。agent 代码完全不需要知道这是 fake。

---

## 2. 基本使用 pattern

```ts
import { complete, registerFauxProvider, fauxAssistantMessage, fauxText, fauxToolCall } from "@mariozechner/pi-ai";

const reg = registerFauxProvider({ tokensPerSecond: 50 });  // 每秒 50 字的流速
const model = reg.getModel();

reg.setResponses([
  fauxAssistantMessage([
    fauxThinking("Need to call echo first"),
    fauxToolCall("echo", { text: "hi" }),
  ], { stopReason: "toolUse" }),
]);

// Agent 用 model 发起请求 → 收到上面那条 assistant 回复
const first = await complete(model, ctx);

// 继续测试下一轮
reg.setResponses([fauxAssistantMessage([fauxText("done")])]);
const second = await complete(model, ctx);

reg.unregister();
```

### 2.1 工程化亮点：像真的 Provider 一样注册

```ts
registerApiProvider({
  api: "faux",
  stream: (model, ctx, options) => { ... },
  streamSimple: ...,
}, sourceId);
```

faux 用 `registerApiProvider` 加入第 2 篇讲的 ApiProvider 注册表。sdk 里所有 `stream(model, ...)` 路径（包括 `streamSimple` 的 reasoning 映射）对它**零感知**。

这意味着你的 agent 用的 `streamSimple(model, ctx, { reasoning: "medium" })` 会正确地被 faux 的 streamSimple 接住，reasoning 降级、maxTokens 计算…所有路径都跑到。测试覆盖到的行远比"手动 mock streamFn"多。

### 2.2 可注册多个模型

```ts
const reg = registerFauxProvider({
  models: [
    { id: "faux-fast", reasoning: false },
    { id: "faux-thinker", reasoning: true },
  ],
});
const thinker = reg.getModel("faux-thinker");
```

想测试"在两个 Provider / 两个 model 之间切换"的行为？registerFauxProvider 让你一次注册多个 model，全部共享同一个响应队列。你可以 drive 切模型过程 + 验证 transformMessages 正确性。

这在测试 cross-provider handoff（第 3 篇）时尤其有用。

---

## 3. 响应队列的两种形态

```ts
export type FauxResponseStep = AssistantMessage | FauxResponseFactory;

export type FauxResponseFactory = (
  context: Context,
  options: StreamOptions | undefined,
  state: { callCount: number },
  model: Model<string>,
) => AssistantMessage | Promise<AssistantMessage>;
```

### 3.1 静态 AssistantMessage

```ts
reg.setResponses([
  fauxAssistantMessage("Hi there"),
  fauxAssistantMessage([fauxToolCall("bash", { cmd: "ls" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("Final answer"),
]);
```

队列里每一项就是"下一个请求的返回"。消费顺序 = 请求顺序。

### 3.2 动态 factory

```ts
reg.setResponses([
  (ctx, opts, state) => {
    const lastUserMsg = ctx.messages.findLast(m => m.role === "user");
    if (lastUserMsg?.content === "hello") return fauxAssistantMessage("Hi!");
    return fauxAssistantMessage("Sorry, didn't catch that.");
  },
]);
```

factory 让响应**依赖输入**。用于测"如果 agent 发来的 context 里有 `/compact`，返回摘要；否则返回普通回复"。也可以在 factory 里 `throw` 来模拟错误。

两种形态混用在一个队列里，写测试时按具体 case 选最合适的。

### 3.3 队列用完怎么办

README 交代了：

> If the queue is empty, the faux provider returns an assistant error message with `errorMessage: "No more faux responses queued"`.

不抛、不卡、不崩——继续遵守第 1 篇讲的"错误即合法 AssistantMessage"契约。测试里这个错误消息很好检测，顺便让忘记 setResponses 的 bug 立刻暴露。

---

## 4. 流式是真的流式，不是 one-shot

Faux 不是"一把返回全部内容"。它按真实 Provider 的步调 emit 事件：

- 每个 content block 先 emit `*_start`。
- 文本按 `tokenSize` 切片（默认 3-5 字符一段），逐段 emit `text_delta`。
- Tool call 参数的 JSON 也被分段 emit `toolcall_delta`。
- `tokensPerSecond` 控制节拍，默认一个 chunk 一个 microtask，设了之后按真实时钟吐字。

为什么要这么"像"？因为：

- 测试 UI 的流式渲染行为（第 9 / 10 篇）需要真流。
- 测试 partial JSON 解析（第 14 篇）需要真分片。
- 测试 steering（第 5 篇）需要 "在 tool call 跑一半时" 的瞬间。

如果 faux 一次 push 整条 message，这些场景全测不到。

### 4.1 `sessionId` + `cacheRetention` 的模拟

README 说得明白：

> Usage is estimated at roughly 1 token per 4 characters. When `sessionId` is present and `cacheRetention` is not `"none"`, prompt cache reads and writes are simulated automatically.

faux 连 cache hit/miss 都模拟了。这样你能测：

- agent 是否在第二次调用时正确透传 `sessionId`。
- cacheRetention 设 "long" 是否如期走 cache。
- cost 计算是否在 cacheRead 命中时正确降低。

---

## 5. 可以直接用作"黄金路径示范"

faux.ts 本身对"怎么写一个合格 Provider"也是教学范例：

- 如何构造合法的 `AssistantMessage` / `AssistantMessageEvent` 序列。
- 如何把一条消息的 content 拆成 start/delta/end 事件。
- 如何正确地 push `done` / `error` 作为终止。
- 如何响应 `signal` 中止流。

新 Provider 的实现者对照 faux 看一遍就知道自己要 emit 哪些事件、顺序如何、何时 end。

---

## 6. harness（coding-agent）里的真实用法

`packages/coding-agent/test/suite/harness.ts` 就是这套能力在上层的集成：

- 启动一个"最小的 pi"，用 faux provider。
- 测试文件写类似：

```ts
const { pi, reg } = await createTestHarness({ ... });

reg.setResponses([
  fauxAssistantMessage([fauxToolCall("read", { path: "README.md" })], { stopReason: "toolUse" }),
  fauxAssistantMessage("I read the README, it says…"),
]);

await pi.prompt("Read README.md");
const messages = pi.session.getEntries();
expect(messages).toHaveToolCall("read");
expect(messages).toHaveAssistantMessage(/says/);
```

`AGENTS.md` 里明确要求：**`packages/coding-agent/test/suite/` 必须用 faux，不能用真 API**。这是项目策略：测试稳定性 > 真实性。

---

## 7. 和 VCR / recorded-response 的对比

| 方面 | 录像回放 | Faux Provider |
| --- | --- | --- |
| 第一次录制成本 | 需要真调用一次 | 无 |
| 场景变化时 | 重新录（多 token 费） | 改代码即可 |
| schema 升级 | 老录像可能整批失效 | 因为 faux 总是按当前 schema 构造，总是有效 |
| 模拟 abort / error / 空队列 | 录制困难 | 一行 `{ stopReason: "error" }` |
| 模拟 cache hit | 录制麻烦 | 直接走模拟逻辑 |

faux 的赢面在"**你完全掌控返回内容**"。对于 agent 这种逻辑驱动的系统，这是最经济、最明确、最可维护的测试方式。

---

## 8. 可以直接学走的套路

1. **测试用的 fake 要注册到和生产同一套注册表**：测到的路径多、接触面广、不走偏门。
2. **fake 要"真的"像**：走完整 event sequence、真分片、真节拍。
3. **helper 函数 (`fauxText` / `fauxToolCall` / `fauxAssistantMessage`)** 让每条 fixture 一行搞定。
4. **response 既可以静态、也可以 factory**：测"请求影响响应"的场景也够用。
5. **queue empty → 合法错误消息**：忘记 setResponses 的 bug 立刻暴露，而不是 hang。
6. **模拟 cache / cost / usage**：让下游关于"计费"、"cache 命中"的代码也能被测到。
7. **模拟多 model 同注册表共存**：测跨 model 切换的逻辑。
8. **对 Provider 作者也是教学**：`faux.ts` 是"怎么合规 emit 事件"的活文档。

你在写任何"有外部 API 依赖的 agent / workflow"的自动化测试时，都能把这套翻译成自己的领域——把 Stripe / Slack / GitHub / 任何 HTTP API 抽出一个 interface，挂一个 faux 实现，让测试完全自包含。

---

## 附：20 篇总览与相互关联

这是 TechAnalysis 系列的收官篇。前 19 篇的整体脉络（简化）：

```
         ┌─ 01 事件流原语 ──────┬─ 03 跨 Provider 投影
         │                     │
         │                     ├─ 12 Options 分层
         │                     │
  pi-ai  ├─ 02 Provider 注册表 ─┤
         │                     ├─ 13 OpenAI compat 探测
         │                     │
         │                     └─ 14 partial JSON
         │
         ├─ 08 TypeBox 校验
         ├─ 15 AbortController
         ├─ 19 OAuth 体系
         └─ 20 Faux 测试体系

         ┌─ 04 事件状态机
         ├─ 05 steering / follow-up
 agent   │
         ├─ 06 两阶段 convertToLlm
         └─ 07 tool 并行 / 钩子

         ┌─ 09 差分渲染 + CSI 2026
  tui    ├─ 10 Focusable + IME
         └─ 11 Overlay 栈

coding-agent
         ├─ 16 JSONL 会话树
         ├─ 17 Extension + 包管理
         └─ 18 Skills 标准
```

这个图建议配合每一篇文档回头看。每一个小抽象的价值都体现在**它和周围抽象的边界划得多干净**。把这 20 个模式印在脑子里，你以后做类似产品的架构就能少走很多弯路。


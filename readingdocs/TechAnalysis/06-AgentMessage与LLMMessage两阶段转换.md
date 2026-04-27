# 06 · AgentMessage vs LLM Message 的两阶段转换

> 位置：`packages/agent/src/types.ts`（`AgentMessage` / `CustomAgentMessages`）、`packages/agent/src/agent-loop.ts`（`streamAssistantResponse` 里的两阶段转换）
>
> 提炼点：**用"AgentMessage = LLM Message ∪ 应用自定义 Message"的结构，把"给人看/给状态用的消息"和"给模型看的消息"彻底解耦，再用 `transformContext` 和 `convertToLlm` 两步转换无损回流到 LLM。**

---

## 1. 这套设计要解决的矛盾

构建有血有肉的 agent UI，你很快会遇到这样的需求：

- 界面上要展示"系统通知：已切换模型"、"压缩摘要"、"bash 输出折叠块"、"skill 调用触发"、"用户打的 label/bookmark"等等。
- 这些消息你希望和 user/assistant/toolResult **一起进入同一条时间线**，按 timestamp 自然排序。
- 但它们**一定不能**被送给 LLM——LLM 协议里只认识 user / assistant / toolResult。

最常见的错误方案是两条队列：一条给 UI，一条给模型。每次做压缩/分支/undo 都要手动同步两份状态，任何一处漏了就出 bug。

pi-agent 的答案是：**只有一份 messages 数组（AgentMessage[]），在每次 LLM 调用之前用纯函数投影成 LLM 认识的子集**。

---

## 2. `AgentMessage` 的类型定义

```ts
// packages/agent/src/types.ts
export interface CustomAgentMessages {
  // 默认空；应用通过 declaration merging 扩展
}

export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
```

两个关键点：

### 2.1 `Message` 是 pi-ai 的 LLM 消息 union

`Message = UserMessage | AssistantMessage | ToolResultMessage`。这是 LLM 协议的合集，已经覆盖所有合法消息。

### 2.2 `CustomAgentMessages` 是一个 **空接口 + declaration merging 占位**

应用侧可以这么扩展：

```ts
declare module "@mariozechner/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
    compaction: { role: "compaction"; summary: string; timestamp: number };
    branchSummary: { role: "branchSummary"; fromId: string; summary: string; timestamp: number };
  }
}

// 之后
const msg: AgentMessage = { role: "notification", text: "切换模型到 gpt-5", timestamp: Date.now() };
```

这是 TypeScript 里最地道的"开放类型"技巧：

- `CustomAgentMessages[keyof CustomAgentMessages]` 把接口里所有字段的**值类型**全部 union 起来。
- 默认空接口 → `keyof` 为 `never` → `AgentMessage` 退化为纯 `Message`。
- 扩展后 → `AgentMessage` 自然多出那些自定义 role，类型完整、穷尽检查完整。

库作者不需要知道用户要加什么，用户也不需要 fork 库。对开发体验好到离谱。

**coding-agent 包里真实扩展的消息类型**（见 `core/messages.ts`、`core/session-manager.ts`）包括 compaction summary、branch summary、bash execution、skill invocation、custom extension message 等 7–8 种，全部靠这个机制无侵入挂进类型系统。

---

## 3. 两阶段转换：`transformContext` + `convertToLlm`

`agent-loop.ts` 的 `streamAssistantResponse`：

```ts
// 第一阶段：AgentMessage[] → AgentMessage[]
let messages = context.messages;
if (config.transformContext) {
  messages = await config.transformContext(messages, signal);
}

// 第二阶段：AgentMessage[] → Message[]
const llmMessages = await config.convertToLlm(messages);

const llmContext: Context = {
  systemPrompt: context.systemPrompt,
  messages: llmMessages,
  tools: context.tools,
};
```

把"投影"拆成两步是精妙之处。README 上的官方注释点破了分工：

- **transformContext**：仍然工作在 AgentMessage 层级，做**业务级别的改写**——上下文压缩、根据 token 估算裁剪旧消息、注入额外上下文文件。
- **convertToLlm**：把 AgentMessage[] 剪成 LLM Message[]——纯语法层的**过滤/转换**。

### 3.1 为什么不把两步合一？

两步的关注点不重叠、执行时机不同：

| 维度 | transformContext | convertToLlm |
| --- | --- | --- |
| 输入/输出类型 | `AgentMessage[] → AgentMessage[]` | `AgentMessage[] → Message[]` |
| 关心的问题 | 上下文窗口 / 语义压缩 | 协议合法性 |
| 调用方 | 通常由 Extension 注入 | 几乎总是由 Agent 持有者配置 |
| 可忽略性 | 可选 | **必填** |

分开还有一个隐藏好处：你可以**只做 transformContext 不做 convertToLlm**，比如 Extension 压缩上下文，但不需要懂任何协议细节。反之亦然。

### 3.2 convertToLlm 的默认实现只做 3 件事

```ts
function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult",
  );
}
```

也就是"保留 LLM 认识的 3 种 role，其他全部过滤"。用户什么都不传，应用依然能跑——只要你没有自定义消息，就不用写投影函数。

### 3.3 convertToLlm 支持异步

签名是 `(messages) => Message[] | Promise<Message[]>`。这个 `Promise` 支持看似冗余，但为 **"自定义消息需要异步加载实际内容"** 提供了通路。

比如 coding-agent 的 bash execution message 里只存了一个句柄，convertToLlm 时会 await 一个工具去读取 stdout/stderr 汇总再拼进上下文。这样长输出**不污染 JSONL session 文件**（文件里只存句柄），但在给 LLM 时能展开成完整文本。

---

## 4. 上层 Agent 把默认值和自定义机会全给出

```ts
// agent.ts
this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
this.transformContext = options.transformContext;
```

这两行体现了 API 设计的克制：

- 默认能用，新手不需要管这俩。
- 每个都是 `public` 字段，运行时**可以随时替换**。 `agent.convertToLlm = newFn` 就能热切换策略。
- `transformContext` 是 `undefined` 为默认，没有逻辑就完全跳过这一步的 await 开销。

这种"默认无感、扩展零成本、运行时可换"是优秀 SDK 的标志。

---

## 5. Session 文件里的消息全是 AgentMessage

这是这个设计的另一条关键受益链：

- session JSONL 文件里的每一条 `message` 都是 AgentMessage，**包含自定义消息**（compaction/branchSummary/notification 等）。
- 因为 convertToLlm 只在调用 LLM 那一刻才剪裁，UI 层重放 session 时看到的是完整时间线，和用户当时看到的完全一致。
- LLM 重新接管时，则是**最新一次**的投影，可以充分利用 compaction 去减少 token。

所以"持久化/UI/LLM 上下文"三件事的分离，全都靠这个两阶段转换来承担。如果没有这套抽象，每次写磁盘都得写两份（UI 版 + LLM 版），一致性立刻崩溃。

---

## 6. 对比那些常见的错误做法

| 错误做法 | 本项目做法 |
| --- | --- |
| UI 和 LLM 分两条队列 | 只有一份 messages，投影分离 |
| 自定义消息用 `any` 或 `Record<string, unknown>` 逃避类型 | declaration merging 维持穷尽 switch 检查 |
| 所有转换塞在一个 huge function | transformContext / convertToLlm 关注点分离 |
| convertToLlm 同步签名 | 允许异步，给 lazy-load 留扩展位 |

---

## 7. 可以直接复用的套路

1. **"内核类型 ∪ CustomXxx[keyof CustomXxx]"** 是 TS SDK 对外开放类型的最佳姿势。
2. **两阶段投影**：业务层改写 + 协议层剪裁，分别可插拔。
3. **默认实现只做最小必要事**，多出来的功能靠替换对应字段解锁。
4. **允许 convertToLlm 异步**，给"真正内容在别处"的场景留口。
5. **UI / 持久化 / LLM 上下文"三位一体的单一真源"**：永远只维护最原始的 AgentMessage 序列，靠投影函数应对不同读者。

这套抽象直接能搬到任意"要给不同读者渲染出不同形态"的日志/事件/消息系统里。邮件客户端的会话历史、多平台 IM 桥接、协作文档的 operation log……全部适用。


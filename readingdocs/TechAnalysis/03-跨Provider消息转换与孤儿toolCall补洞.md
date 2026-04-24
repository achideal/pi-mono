# 03 · 跨 Provider 消息转换与孤儿 toolCall 补洞

> 位置：`packages/ai/src/providers/transform-messages.ts`
>
> 提炼点：**一个 ~170 行的纯函数，解决了"同一份对话历史如何被任意 LLM 续写"这个在多家 API 语义不一致情况下极其棘手的问题。**

---

## 1. 场景：任意 Provider 切换，上下文要"合法又有效"

pi-ai 支持 Cross-Provider Handoffs：你可以先用 Claude 吐了一段 thinking，再切到 GPT-5 继续追问，再切到 Gemini 总结。这对用户来说很爽，但对调用方来说非常危险，因为不同家 API 对历史消息的合法性要求不一样：

- **Anthropic** 只接受自己产的 thinking 块（因为带 signature/encrypted payload），陌生家的 thinking 块直接报 400。
- **OpenAI Responses** 对 reasoning item 有严格的"紧跟下一条 message item"约束，有 reasoning 就必须有相邻的 assistant text/tool_call，否则"reasoning without following item"。
- **所有 API** 都要求 `tool_call` 和 `tool_result` 严格成对：如果 assistant 发起了 tool_call 但上下文里找不到对应的 tool_result，整段都要报错。
- **Tool call id** 的长度/字符集也不一致：OpenAI Responses 的 id 可能有 `|`、长达 450 字符；Anthropic 只接受 `^[a-zA-Z0-9_-]{1,64}$`。

历史消息里只要出现一条"其他家的 assistant"，原样送给新模型就会直接翻车。`transformMessages` 的任务就是把这份历史变成"对当前目标模型安全"的版本。

---

## 2. 两遍扫描的总体结构

```ts
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id, model, source) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();

  // 第一遍：转换内容块（thinking / text / toolCall），记录 id 映射
  const transformed = messages.map(...);

  // 第二遍：插入占位 toolResult 修复孤儿 toolCall
  ...
}
```

为什么要两遍？

- 第一遍要**先建立 tool_call id 的旧→新映射表**，因为后续的 tool_result 要跟着新 id 走。
- 第二遍要**基于已经稳定的 message 序列**做结构修复：判断某条 assistant 的 tool_call 是否有匹配的 tool_result，没有就补一个"No result provided"。

把"内容级转换"和"结构级修复"分两遍、分两种关注点处理，每一遍的逻辑都可以单独读、单独测，比写成一个大 for 循环清晰得多。

---

## 3. 第一遍：识别"自家 vs 他家"的消息

```ts
const assistantMsg = msg as AssistantMessage;
const isSameModel =
  assistantMsg.provider === model.provider &&
  assistantMsg.api === model.api &&
  assistantMsg.model === model.id;
```

**同时**匹配 provider、api、model 三者才算"自家"。为什么要三个字段都比？

- 同一个 provider (`openai`) 下可能同时用 `openai-completions` 和 `openai-responses` 两种 API——语义差异巨大。
- 同一个 API (`openai-responses`) 下可能有不同 model id（gpt-5 与 gpt-5-mini），reasoning payload 不互通。

三者 AND 是在"向后兼容最大、出错最小"之间选的最稳妥口径。

### 3.1 thinking 块的分段处理

```ts
if (block.type === "thinking") {
  if (block.redacted) return isSameModel ? block : [];
  if (isSameModel && block.thinkingSignature) return block;
  if (!block.thinking || block.thinking.trim() === "") return [];
  if (isSameModel) return block;
  return { type: "text" as const, text: block.thinking };
}
```

这里层层条件每一条都对应一种历史踩坑：

| 条件 | 背后原因 |
| --- | --- |
| `redacted` 且非同源 | Anthropic 的 redacted thinking 是加密 payload，送给别人是乱码，直接丢。 |
| 同源 + 有 signature | OpenAI Responses 的 reasoning 可能"正文空 + 带 item id"，必须保留 id 让服务端能回查上下文。 |
| 空 thinking | 不往 LLM 塞"空消息"，避免某些 API 拒绝空 content block。 |
| 非同源 | 降级成 `<thinking>` 包裹的普通文本，让别家模型"读懂"上一家的推理，但不会被当成可验证的 reasoning 块。 |

这一小段 5 条 if 的顺序非常关键，调换任意两条都会触发 bug。

### 3.2 text 块的降级

```ts
if (block.type === "text") {
  if (isSameModel) return block;
  return { type: "text" as const, text: block.text };
}
```

同源直接保留（保留 `textSignature` 等透传字段），跨源**剥掉附加元数据**只保留纯文本。这防止把 OpenAI 的 `textSignature` 塞回 Anthropic，API 不认就是 400。

### 3.3 toolCall 的 id 规范化与跨源字段清理

```ts
if (block.type === "toolCall") {
  let normalizedToolCall = toolCall;

  if (!isSameModel && toolCall.thoughtSignature) {
    normalizedToolCall = { ...toolCall };
    delete normalizedToolCall.thoughtSignature;  // Google 专属字段
  }

  if (!isSameModel && normalizeToolCallId) {
    const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
    if (normalizedId !== toolCall.id) {
      toolCallIdMap.set(toolCall.id, normalizedId);
      normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
    }
  }
  return normalizedToolCall;
}
```

关键点：

- `normalizeToolCallId` 是**每个 Provider 自己注入的回调**。Anthropic 的实现会把 `tool_xxxyyy|zzzz` 裁成 64 字符 + 替换非法字符；OpenAI 等没限制的 Provider 就不传这个参数。pi-ai 没有把 id 归一化逻辑写死，而是让每个 Provider **按需参与**。
- 只有"非同源"才规范化。同源保持原 id，否则同一通对话里 id 会变，下次把这段历史回给同一家 API 又认不出来。
- 用 `toolCallIdMap` 记录映射，下面 `toolResult` 分支会查它把 `toolCallId` 跟着改。

### 3.4 toolResult 查映射表

```ts
if (msg.role === "toolResult") {
  const normalizedId = toolCallIdMap.get(msg.toolCallId);
  if (normalizedId && normalizedId !== msg.toolCallId) {
    return { ...msg, toolCallId: normalizedId };
  }
  return msg;
}
```

简单，但必不可少。如果漏做这一步，上一步改了 toolCall id，这里不改，tool_result 就成了真·孤儿。

---

## 4. 第二遍：修复"孤儿 tool_call"

所有 LLM API 都要求 `tool_call` 必须有对应的 `tool_result`。但是历史里经常出现**孤儿**的场景：

- 用户手动中断 (`stopReason: "aborted"`)，assistant 发了 tool_call 但工具没跑完。
- 上下文压缩 (compaction) 后老消息被裁掉但新消息还留着 tool_call。
- 多 Provider 切换时，某次 assistant 是残缺的。

第二遍的核心算法：

```ts
let pendingToolCalls: ToolCall[] = [];
let existingToolResultIds = new Set<string>();

for (let i = 0; i < transformed.length; i++) {
  const msg = transformed[i];

  if (msg.role === "assistant") {
    // 新 assistant 之前，把上一轮还没配对的 tool_call 全部补洞
    if (pendingToolCalls.length > 0) { ... 插入 synthetic toolResult ... }

    // 跳过 error / aborted 的 assistant（第 5 节专门讲）
    if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;

    const toolCalls = assistantMsg.content.filter(...);
    if (toolCalls.length > 0) {
      pendingToolCalls = toolCalls;
      existingToolResultIds = new Set();
    }
    result.push(msg);
  } else if (msg.role === "toolResult") {
    existingToolResultIds.add(msg.toolCallId);
    result.push(msg);
  } else if (msg.role === "user") {
    // 用户发言打断工具流 → 先补洞再塞 user
    if (pendingToolCalls.length > 0) { ... }
    result.push(msg);
  } else result.push(msg);
}
```

几个点可以独立学习：

### 4.1 状态机只有 "pending + existing" 两个变量

- `pendingToolCalls`：上一个 assistant 发起但还没全部匹配到 result 的 tool_call 集合。
- `existingToolResultIds`：当前 pending 组里已经被后续消息覆盖的 id 集。

每当遇到"会打破工具序列"的事件（新 assistant 或 user message），就结算一轮：把 `pendingToolCalls` 里没在 `existingToolResultIds` 的 id 补一条占位 toolResult。

### 4.2 补的是 `{ text: "No result provided", isError: true }`

不是空对象，不是 `null`，而是明明白白的**错误占位**。这样：

- 所有家 API 都能合法解析。
- 下游模型读到 `isError: true + "No result provided"` 能理解"这个工具之前没跑完"。
- 便于调试：HTTP payload 里直接看见这条文本。

### 4.3 对 `user` 消息也触发补洞

容易漏的一条。如果只在"下一条 assistant"前补洞，那么"assistant 发起 tool_call → 用户直接发新消息"这种序列（典型的中断场景）就会漏。这里用 user 也作为"工具流结束"的标志。

---

## 5. 刻意丢弃 errored / aborted assistant 的重要性

```ts
if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") continue;
```

这条 `continue` 看似简单，但它修掉了一整类 bug：

- aborted 的 assistant 可能只有 reasoning 没有 message（OpenAI 会直接 400）。
- aborted 的 tool_call 参数通常只是部分 JSON，送回去会触发 schema 校验失败。
- error 的 assistant 可能带半个 thinking + 半个 tool_call，没有任何正确的后续能满足 API 要求。

这些"半截"的 assistant 在 UI 上保留（让用户知道发生了什么），但**绝不会被送回 LLM**。这一条看似苛刻，实际却是保持重试能够成功的关键。上层 Agent 的 `continue()` 重试之所以稳，很大程度依赖这里。

---

## 6. 这段 170 行代码教会了什么

1. **"历史合法性"不是上游协议的事，是 SDK 的事**。不要把"格式化历史"的职责丢给每个 Provider，统一在一处做。
2. **两遍扫描比一遍难写一点、但好读好改十倍**。第一遍做内容级变换，第二遍做结构级修复。
3. **条件顺序是纯函数里的隐形状态机**。任何跨协议代码都要逐行注释"为什么"，否则后人改起来一准崩。
4. **id 规范化做成 Provider 注入的回调**。核心代码不认识"这是 Anthropic 格式"，只认识"有人说这个 id 要变"。
5. **坏数据用明确占位符替代**，永远不要插入空的 / null 的占位。下游能识别"缺失"本身就是信息。
6. **丢弃 errored assistant 是一项功能，不是缺陷**。要写在注释里，避免后人好心补回来。

下次你做任何"历史消息要跨系统传递"的功能——IM 消息跨协议、日志跨格式转换、AST 跨语言互转——这六条都值得拿来对照。


# 第 5 章：上下文为什么总是不够用

## 前置知识

本章建立在前四章的基础上。你需要理解：

- LLM 的上下文窗口是有限的（第 1 章）
- Agent 通过循环驱动模型反复推理和执行工具（第 2 章）
- Agent 的最小闭环中，每一轮都会往上下文里追加消息（第 3 章）
- 工具调用会产生大量的输入输出数据（第 4 章）

如果这些概念还不清楚，建议先回顾前面的章节。

## 本章聚焦的层次

本章聚焦于 agent 系统中最核心的资源约束——**上下文窗口**。我们要搞清楚：上下文里到底装了什么、为什么会膨胀、膨胀之后怎么办。

在 pi-mono 的分层架构中，本章涉及两个包：

- `packages/ai`：定义了上下文的基本结构（`Context`、`Message`），以及上下文溢出的检测（`overflow.ts`）
- `packages/coding-agent`：实现了上下文压缩（compaction）机制，这是解决"上下文不够用"的核心工程方案

## 上下文里到底装了什么

第 1 章介绍过，上下文窗口是模型一次调用中能处理的最大 token 数量。但在 agent 场景中，上下文里装的东西远比你想象的多。

让我们拆解一次典型的 coding agent 调用，看看上下文里都有什么：

### 1. System Prompt

系统提示词是每次调用都会发送的固定内容。在 coding agent 中，system prompt 通常包含：

- agent 的角色定义和行为规则
- 工具使用指南
- 代码风格要求
- 安全约束
- 项目特定的规则文件（`.pi/rules` 等）

一个成熟的 coding agent 的 system prompt 可能有 **5,000-15,000 token**。这是每次调用的固定开销。

### 2. 工具定义

模型需要知道它能调用哪些工具。每个工具的定义包含名称、描述和参数 schema。

在 pi-mono 的 `packages/coding-agent` 中，内置工具包括 `read_file`、`write_file`、`edit_file`、`bash`、`grep_search`、`codebase_search` 等。每个工具的 schema 定义大约 200-500 token，十几个工具加起来就是 **3,000-6,000 token**。

### 3. 对话历史

这是上下文膨胀的主要来源。每一轮对话都会追加：

- 用户消息
- 助手回复（可能包含思考过程和工具调用请求）
- 工具执行结果
- 助手根据工具结果的后续回复

一轮"读取文件并修改"的操作，可能产生 **5,000-50,000 token** 的上下文增量——取决于文件大小和修改复杂度。

### 4. 工具结果

这是最容易被低估的部分。工具结果可以非常大：

- `read_file` 读取一个 500 行的源文件：约 **3,000-5,000 token**
- `bash` 执行 `ls -la` 或 `git log`：可能 **500-5,000 token**
- `grep_search` 搜索结果：可能 **2,000-10,000 token**
- `codebase_search` 语义搜索结果：可能 **3,000-8,000 token**

一次复杂的代码修改任务，模型可能调用 5-10 次工具，每次工具结果平均 3,000 token，光工具结果就占了 **15,000-30,000 token**。

### 一个真实的上下文构成

假设用户让 agent "重构 `auth` 模块，把登录逻辑拆分成独立的服务"。经过几轮交互后，上下文可能是这样的：

| 组成部分                                           | 估算 token  |
| -------------------------------------------------- | ----------- |
| System prompt                                      | 10,000      |
| 工具定义                                           | 4,000       |
| 第 1 轮：用户请求 + 助手分析 + 搜索代码 + 搜索结果 | 15,000      |
| 第 2 轮：助手读取 3 个文件 + 文件内容 + 修改计划   | 20,000      |
| 第 3 轮：助手编辑文件 + 编辑结果 + 创建新文件      | 12,000      |
| 第 4 轮：助手运行测试 + 测试输出 + 修复错误        | 18,000      |
| 第 5 轮：用户追加要求 + 助手继续修改               | 8,000       |
| **总计**                                           | **~87,000** |

对于 128K 上下文窗口的模型，5 轮交互就用掉了 68% 的空间。而且还要给模型的输出留空间（`maxTokens` 通常 16K-32K），实际可用的输入空间更少。

如果任务更复杂——比如涉及 10 个文件的跨模块重构——上下文很快就会撑满。

## 上下文膨胀的三个阶段

### 阶段一：舒适区（0-50% 使用率）

前几轮对话，上下文还很宽裕。模型能看到完整的历史，回复质量高，工具调用准确。

这个阶段的体验最好，也是大多数人对 agent 的第一印象。

### 阶段二：压力区（50-80% 使用率）

随着对话继续，上下文开始紧张。这时候会出现几个问题：

- **成本上升**：每次调用发送的 token 越来越多，费用线性增长
- **延迟增加**：模型处理更多 token 需要更长时间
- **缓存失效**：如果使用了 prompt caching（Anthropic、OpenAI 都支持），新增的消息可能导致缓存前缀不匹配，缓存命中率下降

但模型的回复质量通常还能维持，因为关键信息还在上下文里。

### 阶段三：危险区（80-100% 使用率）

上下文接近上限。这时候问题变得严重：

- **溢出风险**：再多一条消息就可能超出上下文窗口，导致 API 报错
- **注意力稀释**：模型需要在大量信息中找到相关内容，可能遗漏关键细节
- **输出空间不足**：`contextWindow - 当前输入 token` 就是模型能输出的最大长度，如果输入太多，输出就被压缩

## 溢出了会怎样

当上下文超出模型的窗口大小时，不同的 provider 有不同的反应。pi-mono 在 `packages/ai/src/utils/overflow.ts` 中统一处理了这些差异。

### 各 Provider 的溢出行为

**大多数 provider 会报错**，但错误消息格式各不相同：

- **Anthropic**：`"prompt is too long: 213462 tokens > 200000 maximum"`
- **OpenAI**：`"Your input exceeds the context window of this model"`
- **Google**：`"The input token count (1196265) exceeds the maximum number of tokens allowed (1048575)"`
- **xAI**：`"This model's maximum prompt length is 131072 but the request contains 537812 tokens"`
- **Groq**：`"Please reduce the length of the messages or completion"`

**少数 provider 会静默处理**：

- **z.ai**：接受溢出请求，静默截断输入，返回正常结果。只能通过 `usage.input > contextWindow` 检测
- **Ollama**：某些部署会静默截断输入，某些会返回错误

### pi-mono 的溢出检测

pi-mono 用一组正则表达式匹配各 provider 的错误消息：

```typescript
// packages/ai/src/utils/overflow.ts
const OVERFLOW_PATTERNS = [
  /prompt is too long/i, // Anthropic
  /exceeds the context window/i, // OpenAI
  /input token count.*exceeds the maximum/i, // Google
  /maximum prompt length is \d+/i, // xAI
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter
  /context window exceeds limit/i, // MiniMax
  // ... 还有十几个 provider 的模式
];
```

`isContextOverflow` 函数处理两种情况：

```typescript
// packages/ai/src/utils/overflow.ts
export function isContextOverflow(
  message: AssistantMessage,
  contextWindow?: number,
): boolean {
  // 情况 1：错误消息匹配溢出模式
  if (message.stopReason === "error" && message.errorMessage) {
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) =>
      p.test(message.errorMessage!),
    );
    if (
      !isNonOverflow &&
      OVERFLOW_PATTERNS.some((p) => p.test(message.errorMessage!))
    ) {
      return true;
    }
  }

  // 情况 2：静默溢出（z.ai 风格）——成功返回但 usage 超出窗口
  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = message.usage.input + message.usage.cacheRead;
    if (inputTokens > contextWindow) {
      return true;
    }
  }

  return false;
}
```

注意 `NON_OVERFLOW_PATTERNS` 的存在——它排除了那些看起来像溢出但实际上是其他错误的情况。比如 AWS Bedrock 的限流错误 `"Throttling error: Too many tokens"` 会匹配 `/too many tokens/i` 这个溢出模式，但它实际上是速率限制，不是上下文溢出。

这种"排除法"的设计体现了一个工程原则：**在错误检测中，误报（false positive）比漏报更危险**。如果把限流错误当成溢出处理，agent 会错误地触发压缩，丢失有用的上下文。

## 解决方案一：transformContext

在溢出发生之前，agent 可以通过 `transformContext` 在每次调用模型前对上下文进行预处理。

回顾第 2 章介绍的消息流转过程：

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
```

`transformContext` 在 `AgentMessage` 层面操作，典型用途包括：

- **裁剪旧消息**：删除最早的几轮对话
- **注入外部上下文**：添加项目规则、最近修改的文件列表等
- **压缩工具结果**：截断过长的工具输出

```typescript
// packages/agent/src/types.ts
export interface AgentLoopConfig {
  transformContext?: (
    messages: AgentMessage[],
    signal?: AbortSignal,
  ) => Promise<AgentMessage[]>;
  // ...
}
```

一个简单的裁剪示例：

```typescript
const agent = new Agent({
  transformContext: async (messages) => {
    if (estimateTokens(messages) > MAX_TOKENS) {
      // 保留最近的消息，丢弃最早的
      return messages.slice(-20);
    }
    return messages;
  },
});
```

但这种简单裁剪有明显的问题：

1. **信息丢失**：被裁剪的消息中可能包含关键的决策和上下文
2. **对话断裂**：模型突然看不到之前的讨论，可能重复已经做过的事
3. **工具结果孤立**：如果裁剪掉了工具调用但保留了工具结果（或反过来），消息序列会不合法

这就是为什么 pi-mono 在 `packages/coding-agent` 中实现了更精细的压缩机制——compaction。

## 解决方案二：Compaction（上下文压缩）

Compaction 是 pi-mono 解决上下文膨胀的核心方案。它的思路是：**用 LLM 把旧的对话历史总结成一段摘要，然后用摘要替代原始消息**。

### 什么时候触发

自动压缩在以下条件满足时触发：

```
contextTokens > contextWindow - reserveTokens
```

默认配置：

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts
export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384, // 为模型输出预留的空间
  keepRecentTokens: 20000, // 保留最近的 token 数（不被压缩）
};
```

也就是说，对于 128K 上下文窗口的模型，当上下文超过 `128000 - 16384 = 111616` token 时，自动触发压缩。

用户也可以通过 `/compact` 命令手动触发。

### 压缩的五个步骤

**第一步：找到切割点**

从最新的消息开始往回走，累加每条消息的估算 token 数，直到累计达到 `keepRecentTokens`（默认 20K）。这个位置就是切割点——切割点之后的消息保留，之前的消息被压缩。

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts
export function findCutPoint(
  entries: SessionEntry[],
  startIndex: number,
  endIndex: number,
  keepRecentTokens: number,
): CutPointResult {
  // 从最新消息往回走，累加 token
  let accumulatedTokens = 0;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry.type !== "message") continue;
    const messageTokens = estimateTokens(entry.message);
    accumulatedTokens += messageTokens;
    if (accumulatedTokens >= keepRecentTokens) {
      // 找到最近的合法切割点
      // ...
      break;
    }
  }
  // ...
}
```

切割点有规则限制——**永远不能在工具结果处切割**，因为工具结果必须跟在对应的工具调用后面。合法的切割点是用户消息、助手消息、bash 执行消息或自定义消息。

**第二步：提取要压缩的消息**

从上一次压缩的边界（或会话开头）到切割点之间的消息，就是要被压缩的部分。

**第三步：生成摘要**

调用 LLM 对这些消息生成结构化摘要。摘要使用固定的格式：

```markdown
## Goal

[用户想要完成什么]

## Constraints & Preferences

- [用户提到的约束和偏好]

## Progress

### Done

- [x] [已完成的任务]

### In Progress

- [ ] [进行中的工作]

### Blocked

- [阻塞项]

## Key Decisions

- **[决策]**: [理由]

## Next Steps

1. [下一步应该做什么]

## Critical Context

- [继续工作所需的关键信息]
```

如果之前已经有过压缩（存在 `previousSummary`），新的压缩会使用"更新模式"——在旧摘要的基础上合并新信息，而不是从头生成。

**第四步：保存压缩条目**

压缩结果被保存为一个 `CompactionEntry`，包含摘要文本、第一个保留条目的 ID、压缩前的 token 数等信息。

**第五步：重新加载会话**

会话重新加载后，LLM 看到的上下文变成了：

```
┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
│ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
└────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
     ↑         ↑      └─────────────────┬────────────────┘
  prompt   压缩摘要         保留的最近消息
```

原来可能占 80K token 的历史消息，被压缩成了一段 2-5K token 的摘要。上下文使用率从 80% 降到了 30% 左右。

### Token 估算

压缩需要知道每条消息大约占多少 token。pi-mono 使用一个简单但保守的启发式方法：

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts
export function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  // ... 根据消息类型累加字符数 ...
  return Math.ceil(chars / 4); // 4 个字符约等于 1 个 token
}
```

`chars / 4` 是一个粗略但实用的估算。它倾向于高估（保守），这意味着压缩可能会比实际需要的时机稍早触发——但这比低估导致溢出要安全得多。

对于有 `usage` 数据的助手消息（模型返回的实际 token 使用量），pi-mono 会优先使用精确数据：

```typescript
// packages/coding-agent/src/core/compaction/compaction.ts
export function estimateContextTokens(
  messages: AgentMessage[],
): ContextUsageEstimate {
  const usageInfo = getLastAssistantUsageInfo(messages);

  if (!usageInfo) {
    // 没有 usage 数据，全部用估算
    let estimated = 0;
    for (const message of messages) {
      estimated += estimateTokens(message);
    }
    return { tokens: estimated /* ... */ };
  }

  // 有 usage 数据：用精确值 + 后续消息的估算
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (let i = usageInfo.index + 1; i < messages.length; i++) {
    trailingTokens += estimateTokens(messages[i]);
  }

  return {
    tokens: usageTokens + trailingTokens,
    // ...
  };
}
```

这个设计很巧妙：最后一条助手消息的 `usage` 字段包含了模型实际消耗的 token 数（包括输入和输出），这是最准确的数据。对于 `usage` 之后新增的消息（比如用户的新输入），才用估算值补充。

### Split Turn：当一个 turn 太大

正常情况下，压缩在 turn 边界切割——一个 turn 从用户消息开始，到下一个用户消息之前结束。

但如果单个 turn 就超过了 `keepRecentTokens`（比如用户让 agent 做一个涉及大量文件的复杂任务，一个 turn 里有几十次工具调用），切割点就不得不落在 turn 内部的某个助手消息上。这就是"split turn"。

```
Split turn（一个巨大的 turn 超出预算）：

  entry:  0     1     2      3     4      5      6     7      8
        ┌─────┬─────┬─────┬──────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴──────┴──────┴─────┴──────┘
                ↑                                     ↑
         turnStart = 1                       firstKept = 7
                │                                     │
                └──── turnPrefixMessages (1-6) ───────┘
                                                      └── kept (7-8)
```

对于 split turn，pi-mono 生成两个摘要并合并：

1. **历史摘要**：之前的完整 turn 的摘要
2. **Turn 前缀摘要**：被切割的 turn 的前半部分的摘要

这样模型既知道之前做了什么，也知道当前 turn 的前半部分做了什么。

### 迭代压缩

当会话非常长时，压缩可能发生多次。每次压缩都会在上一次压缩的基础上进行：

- 第一次压缩：总结消息 1-10，保留消息 11-20
- 第二次压缩：在第一次摘要的基础上，总结消息 11-15，保留消息 16-25
- 第三次压缩：在第二次摘要的基础上，总结消息 16-20，保留消息 21-30

每次压缩都使用"更新模式"的 prompt，在旧摘要基础上合并新信息，而不是从头生成。这样可以保持摘要的连贯性，避免信息在多次压缩中逐渐丢失。

### 溢出恢复

如果上下文已经溢出（模型返回了溢出错误），pi-mono 会尝试紧急恢复：

```typescript
// packages/coding-agent/src/core/agent-session.ts（简化）
if (isContextOverflow(assistantMessage, contextWindow)) {
  if (this._overflowRecoveryAttempted) {
    // 已经尝试过一次恢复，放弃
    this._emit({
      type: "compaction_end",
      errorMessage: "Context overflow recovery failed...",
    });
    return;
  }

  this._overflowRecoveryAttempted = true;
  // 移除错误消息，触发紧急压缩
  const messages = this.agent.state.messages;
  if (messages[messages.length - 1].role === "assistant") {
    this.agent.state.messages = messages.slice(0, -1);
  }
  await this._runAutoCompaction("overflow", true);
}
```

流程是：

1. 检测到溢出错误
2. 移除导致错误的助手消息（它没有有用内容）
3. 触发紧急压缩
4. 压缩完成后自动重试模型调用
5. 如果重试后仍然溢出，放弃并通知用户

这个"压缩-重试"机制只尝试一次。如果一次压缩不够，说明问题不在历史消息太多，可能是单条消息就超出了窗口，这时候需要用户介入（比如换一个更大上下文窗口的模型）。

## 压缩的代价

Compaction 不是免费的午餐。它有明显的代价：

### 1. 信息损失

摘要再好，也不可能保留原始对话的所有细节。被压缩的消息中可能包含：

- 具体的代码片段
- 精确的错误信息
- 微妙的设计决策
- 用户的隐含偏好

这些细节在压缩后可能丢失，导致模型在后续交互中做出不一致的决策。

### 2. 额外的模型调用

生成摘要本身需要调用 LLM，这意味着额外的 token 消耗和延迟。对于 split turn，还需要两次调用（历史摘要 + turn 前缀摘要）。

### 3. 摘要质量不确定

摘要的质量取决于模型的能力。如果模型遗漏了关键信息，后续的交互质量会下降，而且这种下降很难被检测到。

### 4. 不可逆

一旦压缩完成，原始消息就不再出现在上下文中（虽然它们仍然保存在会话文件里）。如果摘要有误，没有简单的方法"撤销压缩"。

## 其他缓解策略

除了 compaction，还有一些缓解上下文压力的策略：

### 工具结果截断

在工具执行后，通过 `afterToolCall` 钩子截断过长的结果：

```typescript
const agent = new Agent({
  afterToolCall: async ({ result }) => {
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

这在源头控制了单条消息的大小，但可能导致模型看不到完整的工具输出。

### Prompt Caching

虽然不能减少上下文大小，但 prompt caching 可以显著降低重复发送相同前缀的成本。Anthropic 和 OpenAI 都支持这个特性——如果连续两次调用的上下文前缀相同，第二次调用的输入 token 费用会大幅降低。

在 pi-mono 中，`Usage` 类型的 `cacheRead` 和 `cacheWrite` 字段就是用来追踪缓存命中情况的。

### 选择更大上下文窗口的模型

最直接的方案。从 128K 换到 200K 或 1M 上下文窗口的模型，可以推迟压缩的触发时机。但更大的上下文意味着更高的成本和更长的延迟。

pi-mono 的模型注册表中记录了每个模型的 `contextWindow`，压缩逻辑会根据当前模型的窗口大小动态调整触发阈值。

## 设计后果与权衡

### 为什么用 LLM 做摘要而不是简单截断

简单截断（丢弃最早的消息）实现简单，但信息损失不可控。LLM 摘要可以提取关键信息、保留决策上下文、维持任务连贯性。代价是额外的模型调用和摘要质量的不确定性。

pi-mono 选择了 LLM 摘要，因为在 coding agent 场景中，任务连贯性比节省一次模型调用更重要。

### 为什么默认保留 20K token 的最近消息

太少（比如 5K）：模型可能看不到最近一轮工具调用的完整结果，导致重复操作。

太多（比如 50K）：压缩后释放的空间不够，很快又需要再次压缩。

20K 是一个经验值，大约能覆盖最近 2-3 轮完整的交互。用户可以通过配置文件调整。

### 为什么压缩是产品层（coding-agent）的功能而不是 agent 层的

`packages/agent` 提供了 `transformContext` 钩子，但没有内置压缩逻辑。压缩涉及：

- 会话持久化（需要知道会话文件格式）
- 摘要格式（不同产品可能需要不同的摘要结构）
- 触发策略（不同场景的阈值不同）
- 扩展点（允许插件自定义压缩行为）

这些都是产品层的关注点，不应该耦合到通用的 agent runtime 中。`packages/agent` 只提供机制（`transformContext`），`packages/coding-agent` 提供策略（compaction）。

## 后续章节预告

本章讨论了上下文窗口这个 agent 系统的核心资源约束，以及 pi-mono 如何通过 compaction 来管理它。

下一章（第 6 章：记忆、会话、状态三者的区别）会进一步讨论：当上下文被压缩后，那些"丢失"的信息去了哪里？agent 的"记忆"到底是什么？会话持久化和状态管理又是怎么回事？

## 小练习

1. **估算上下文使用量**：假设你有一个 128K 上下文窗口的模型，system prompt 占 10K token，工具定义占 4K token。你最多能进行多少轮"读取文件 + 修改文件"的交互？（假设每轮平均消耗 15K token，模型输出预留 16K token）

   > **关键信息**：可用空间 = 128K - 10K（system prompt）- 4K（工具定义）- 16K（输出预留）= 98K token。每轮 15K token，所以最多 `98K / 15K ≈ 6.5`，即 **6 轮**完整交互。第 7 轮就会触发压缩或溢出。这解释了为什么复杂任务中压缩几乎是必然的——6 轮交互对于一个跨文件重构任务来说远远不够。

2. **理解压缩触发条件**：阅读 `packages/coding-agent/src/core/compaction/compaction.ts` 中的 `shouldCompact` 函数和 `DEFAULT_COMPACTION_SETTINGS`。计算：对于 200K 上下文窗口的模型，压缩在什么时候触发？

   > **关键信息**：`shouldCompact` 的逻辑是 `contextTokens > contextWindow - reserveTokens`。默认 `reserveTokens = 16384`。所以对于 200K 模型：触发阈值 = `200000 - 16384 = 183616` token。当上下文超过 **183,616 token** 时触发压缩。这意味着 200K 模型比 128K 模型多出约 72K token 的可用空间（`183616 - 111616 = 72000`），大约能多支撑 4-5 轮交互。

3. **看代码**：阅读 `packages/ai/src/utils/overflow.ts` 中的 `isContextOverflow` 函数。思考：为什么需要 `NON_OVERFLOW_PATTERNS`？如果没有它，会发生什么？

   > **关键信息**：`NON_OVERFLOW_PATTERNS` 排除了三类误报：
   >
   > - `Throttling error:` —— AWS Bedrock 的限流错误，包含 "Too many tokens" 文本
   > - `rate limit` —— 通用速率限制
   > - `too many requests` —— HTTP 429 风格的错误
   >
   > 如果没有这个排除机制，Bedrock 的限流错误 `"Throttling error: Too many tokens, please wait before trying again."` 会匹配 `/too many tokens/i` 这个溢出模式，被误判为上下文溢出。后果是：agent 会错误地触发紧急压缩，丢弃有用的上下文历史，然后重试——但真正的问题是速率限制，重试可能再次被限流，形成"压缩-限流-再压缩"的恶性循环，最终把所有历史都压缩掉。
   >
   > 这是一个典型的"防御性编程"案例：在错误分类中，**误报的代价远大于漏报**。漏报溢出最多导致 agent 再次收到溢出错误然后重试；误报溢出则会不可逆地丢失上下文。

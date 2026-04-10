# 第 6 章：记忆、会话、状态三者的区别

## 前置知识

本章建立在前五章的基础上。你需要理解：

- LLM 本身不记住任何东西，它只看到当前上下文窗口中的内容（第 1 章）
- Agent 通过循环、工具和状态管理把模型变成能做事的系统（第 2 章）
- Agent 的最小闭环是"用户消息 → 模型推理 → 工具调用 → 工具结果 → 继续推理"（第 3 章）
- 工具调用让模型能驱动外部动作（第 4 章）
- 上下文窗口是有限资源，需要压缩和裁剪来管理（第 5 章）

如果这些概念还不清楚，建议先回顾前面的章节。

## 本章聚焦的层次

本章聚焦于 agent 系统中最容易被混淆的三个概念：**记忆**（Memory）、**会话**（Session）和**状态**（State）。

很多初学者会把这三个词当成同义词使用，但它们在工程上解决的是完全不同的问题。搞清楚它们的区别，是理解 agent 系统设计的关键一步。

在 pi-mono 的分层架构中，本章涉及多个包：

- `packages/agent`：定义了 `AgentState`，管理运行时状态
- `packages/coding-agent`：实现了 `SessionManager`（会话持久化）和 `AgentSession`（会话生命周期）
- `packages/mom`：展示了一种基于文件的长期记忆方案（`MEMORY.md`）

## 从一个问题开始

假设你和一个 coding agent 进行了以下对话：

```
你：帮我把 config.json 中的端口从 3000 改成 8080
Agent：好的，我来修改。[调用 edit 工具] 已完成。
你：顺便把 README 里的端口号也更新一下
Agent：[调用 read_file 读取 README] [调用 edit 工具修改] 已更新。
```

现在你关闭了终端，第二天重新打开。你说：

```
你：昨天改的端口号是多少来着？
```

Agent 能回答这个问题吗？

答案取决于三件事：

1. **状态**：agent 当前运行时是否还持有昨天的消息？（通常不会——你关闭了终端）
2. **会话**：昨天的对话是否被保存到了磁盘？（如果有会话持久化，是的）
3. **记忆**：即使没有完整的对话记录，agent 是否"记住"了关键信息？（取决于记忆机制）

这三个层次解决的问题不同，生命周期不同，实现方式也不同。

## 状态（State）：运行时的当前快照

### 什么是状态

状态是 agent **当前运行时**的所有信息。它存在于内存中，随着 agent 的启动而创建，随着 agent 的停止而消失。

在 pi-mono 中，状态通过 `AgentState` 接口定义：

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

状态包含了 agent 工作所需的一切：

- **systemPrompt**：告诉模型它是谁、该怎么做
- **model**：当前使用的模型
- **thinkingLevel**：推理级别（off / low / medium / high）
- **tools**：可用的工具列表
- **messages**：到目前为止的所有对话消息
- **isStreaming**：是否正在生成回复
- **pendingToolCalls**：哪些工具正在执行

### 状态的生命周期

状态的生命周期和进程绑定：

```
进程启动 → 创建初始状态 → 用户交互中不断更新 → 进程退出 → 状态消失
```

每次用户发送消息、模型回复、工具执行，状态都在实时更新。但一旦进程退出，内存中的状态就没了。

这就是为什么你关闭终端后，agent 不记得昨天的对话——状态只存在于内存中。

### 状态的特点

| 特性     | 描述                   |
| -------- | ---------------------- |
| 存储位置 | 内存                   |
| 生命周期 | 进程级别（启动到退出） |
| 访问速度 | 极快（直接内存访问）   |
| 持久性   | 无（进程退出即丢失）   |
| 用途     | 驱动当前的 agent 循环  |

### 状态中最重要的字段：messages

`messages` 是状态中最核心的字段。它包含了当前对话的完整记录：

```typescript
export type AgentMessage =
  | Message
  | CustomAgentMessages[keyof CustomAgentMessages];
```

在 `packages/coding-agent` 中，`AgentMessage` 被扩展为包含多种消息类型：

```typescript
type AgentMessage =
  | UserMessage // 用户消息
  | AssistantMessage // 模型回复
  | ToolResultMessage // 工具执行结果
  | BashExecutionMessage // bash 命令执行记录
  | CustomMessage // 扩展注入的自定义消息
  | BranchSummaryMessage // 分支摘要
  | CompactionSummaryMessage; // 压缩摘要
```

每次调用模型时，`messages`（经过 `transformContext` 和 `convertToLlm` 转换后）会作为上下文发送给模型。模型看到的"历史"，本质上就是 `messages` 数组中的内容。

这意味着：**模型的"记忆"完全取决于 `messages` 里有什么**。如果一条消息不在 `messages` 里，模型就不知道它存在过。

## 会话（Session）：对话的持久化记录

### 什么是会话

会话是对话的**持久化存储**。它把运行时的状态变化记录到磁盘上，这样即使进程退出，对话也不会丢失。

你可以把状态和会话的关系想象成：

- **状态**是你正在编辑的文档（在内存中）
- **会话**是你按了 Ctrl+S 保存到磁盘的文件

### pi-mono 中的会话实现

在 pi-mono 中，会话通过 `SessionManager` 类管理，存储为 JSONL（JSON Lines）文件：

```
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

每个会话文件是一系列 JSON 行，每行是一个**条目**（entry）。条目通过 `id` 和 `parentId` 形成树结构：

```typescript
// packages/coding-agent/src/core/session-manager.ts
export interface SessionEntryBase {
  type: string;
  id: string; // 8 字符十六进制 ID
  parentId: string | null; // 父条目 ID（第一个条目为 null）
  timestamp: string; // ISO 时间戳
}
```

### 会话中的条目类型

会话文件不只是保存消息。它记录了对话过程中发生的所有重要事件：

| 条目类型                | 说明                           | 是否参与 LLM 上下文  |
| ----------------------- | ------------------------------ | -------------------- |
| `session`               | 会话头部（元数据）             | 否                   |
| `message`               | 对话消息（用户/助手/工具结果） | 是                   |
| `model_change`          | 用户切换了模型                 | 否（但影响后续调用） |
| `thinking_level_change` | 用户改变了推理级别             | 否（但影响后续调用） |
| `compaction`            | 上下文压缩记录                 | 是（摘要部分）       |
| `branch_summary`        | 分支切换时的摘要               | 是                   |
| `custom`                | 扩展的自定义数据               | 否                   |
| `custom_message`        | 扩展注入的消息                 | 是                   |
| `label`                 | 用户定义的书签                 | 否                   |
| `session_info`          | 会话元数据（如显示名称）       | 否                   |

一个典型的会话文件内容大致如下：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
{"type":"message","id":"a1b2c3d4","parentId":null,"timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello"}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"provider":"anthropic","model":"claude-sonnet-4-5","usage":{...},"stopReason":"stop"}}
{"type":"model_change","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### 为什么是树结构而不是线性列表

早期版本（v1）的会话是线性的——条目按顺序排列。但这有一个严重的限制：**你不能回到之前的某个点重新开始**。

想象这个场景：你让 agent 重构了一段代码，但结果不满意。你想回到重构之前的状态，尝试另一种方案。

线性结构下，你只能：

- 手动撤销所有修改
- 或者开一个全新的会话，丢失之前的上下文

树结构下，你可以：

- 把"叶子指针"移回到重构之前的条目
- 从那个点开始一个新的分支
- 两个分支都保留在同一个文件中

```
[用户: 帮我重构] ─── [助手: 好的] ─── [工具: 修改完成] ─┬─ [用户: 不好，换个方案] ← 分支 A
                                                          │
                                                          └─ [分支摘要] ─── [用户: 试试另一种方式] ← 分支 B（当前）
```

这就是 `id` / `parentId` 的作用。`SessionManager` 维护一个 `leafId`（当前叶子指针），所有新条目都作为当前叶子的子节点追加。`branch()` 方法可以把叶子指针移到任意历史条目，从而开始新分支。

### 从会话恢复状态：buildSessionContext

当你恢复一个会话时，需要从磁盘上的条目重建内存中的状态。这就是 `buildSessionContext` 函数的工作：

```typescript
// packages/coding-agent/src/core/session-manager.ts
export function buildSessionContext(
  entries: SessionEntry[],
  leafId?: string | null,
  byId?: Map<string, SessionEntry>,
): SessionContext {
  // 1. 从叶子节点沿 parentId 链走到根节点，收集路径上的所有条目
  const path: SessionEntry[] = [];
  let current: SessionEntry | undefined = leaf;
  while (current) {
    path.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  // 2. 遍历路径，提取设置（模型、推理级别）和压缩信息
  for (const entry of path) {
    if (entry.type === "thinking_level_change") thinkingLevel = entry.thinkingLevel;
    else if (entry.type === "model_change") model = { ... };
    else if (entry.type === "compaction") compaction = entry;
  }

  // 3. 构建消息列表
  // 如果有压缩：先放摘要，再放保留的消息，再放压缩后的新消息
  // 如果没有压缩：按顺序放所有消息
  return { messages, thinkingLevel, model };
}
```

关键点：`buildSessionContext` 只沿着**当前分支**（从叶子到根的路径）收集条目。其他分支的条目不会出现在结果中。这就是树结构的好处——每个分支都是独立的上下文。

### 会话的持久化时机

会话不是每隔一段时间自动保存的。它是**追加式**（append-only）的——每当有新事件发生，就追加一行到 JSONL 文件：

```typescript
// packages/coding-agent/src/core/session-manager.ts
_persist(entry: SessionEntry): void {
  if (!this.persist || !this.sessionFile) return;

  const hasAssistant = this.fileEntries.some(
    (e) => e.type === "message" && e.message.role === "assistant"
  );
  if (!hasAssistant) {
    // 还没有助手回复时，不写入文件（避免只有用户消息的空会话）
    this.flushed = false;
    return;
  }

  if (!this.flushed) {
    // 第一次写入：把所有积累的条目一次性写入
    for (const e of this.fileEntries) {
      appendFileSync(this.sessionFile, `${JSON.stringify(e)}\n`);
    }
    this.flushed = true;
  } else {
    // 后续写入：只追加新条目
    appendFileSync(this.sessionFile, `${JSON.stringify(entry)}\n`);
  }
}
```

注意一个细节：会话文件**直到模型第一次回复后才开始写入**。这避免了创建大量只有用户消息的空会话文件。

### 会话管理的多种模式

`SessionManager` 提供了多种创建方式，适应不同场景：

```typescript
// 新建持久化会话
SessionManager.create(process.cwd());

// 继续最近的会话（如果没有则新建）
SessionManager.continueRecent(process.cwd());

// 打开指定的会话文件
SessionManager.open("/path/to/session.jsonl");

// 纯内存模式（不写磁盘，适合测试）
SessionManager.inMemory();

// 从另一个项目 fork 会话
SessionManager.forkFrom(sourcePath, targetCwd);
```

### 会话的特点

| 特性     | 描述                       |
| -------- | -------------------------- |
| 存储位置 | 磁盘（JSONL 文件）         |
| 生命周期 | 跨进程（文件存在就能恢复） |
| 访问速度 | 较慢（需要读取和解析文件） |
| 持久性   | 有（除非手动删除文件）     |
| 用途     | 恢复对话、分支、审计       |

## 记忆（Memory）：跨会话的持久化知识

### 什么是记忆

记忆是 agent 跨越多个会话保留的**长期知识**。

状态在进程退出后消失。会话保存了完整的对话记录，但每个会话是独立的——会话 A 中学到的东西，不会自动出现在会话 B 中。

记忆解决的就是这个问题：**让 agent 在不同会话之间共享知识**。

### 记忆不是魔法

很多人听到"agent 记忆"会想到科幻电影里的人工智能——它真的"记住"了你说过的话。

现实要朴素得多。大多数 agent 的"记忆"本质上是以下机制的组合：

1. **把历史消息继续放进上下文**——最简单的"记忆"，但受上下文窗口限制
2. **把历史压缩成摘要**——第 5 章讨论的 compaction，用摘要替代完整历史
3. **把关键信息写入文件或数据库**——持久化存储，需要时再检索
4. **需要时再检索回来**——通过搜索、grep 或向量检索找到相关信息

所以"记忆"本质上是**状态管理 + 持久化 + 检索**，不是模型真的永久记住了你。

### pi-mono 中的记忆实现

pi-mono 中有两种典型的记忆实现，分别在 `packages/coding-agent` 和 `packages/mom` 中。

#### coding-agent 的记忆：update_memory 工具

`packages/coding-agent` 通过一个 `update_memory` 工具让模型可以主动保存记忆。当用户说"记住我喜欢用 tabs 而不是 spaces"时，模型会调用这个工具，把信息写入一个持久化的知识库文件。

下次启动新会话时，这些记忆会被加载到 system prompt 或上下文中，模型就能"记住"用户的偏好。

这种方式的特点：

- **模型驱动**：由模型决定什么值得记住
- **结构化存储**：记忆以特定格式保存
- **注入上下文**：记忆在每次调用时被注入到上下文中

#### mom 的记忆：MEMORY.md 文件

`packages/mom`（Slack bot）使用了一种更直观的方案——**Markdown 文件**：

```
./data/
  ├── MEMORY.md                 # 全局记忆（跨所有频道共享）
  ├── C123ABC/
  │   ├── MEMORY.md             # 频道特定记忆
  │   ├── log.jsonl             # 完整消息历史
  │   └── context.jsonl         # LLM 上下文
  └── D456DEF/
      ├── MEMORY.md             # 另一个频道的记忆
      └── ...
```

Mom 的记忆分两层：

- **全局记忆**（`data/MEMORY.md`）：跨所有频道共享。比如项目架构、编码规范、沟通偏好
- **频道记忆**（`data/<channel>/MEMORY.md`）：频道特定的上下文。比如某个项目的决策、正在进行的工作

Mom 在每次响应前会自动读取这些文件。你可以让她更新记忆（"记住我们用 tabs 不用 spaces"），也可以直接编辑文件。

这种方式的特点：

- **文件即记忆**：用 Markdown 文件存储，人类可读可编辑
- **分层组织**：全局 + 频道级别
- **双向可编辑**：agent 可以写，人也可以直接改

#### mom 的历史检索：log.jsonl + grep

Mom 还有一个巧妙的设计：除了 `MEMORY.md` 的显式记忆，她还能通过 grep 搜索 `log.jsonl` 来检索历史对话：

```
log.jsonl：所有频道消息（用户消息、bot 回复），追加写入，永不压缩
context.jsonl：发送给 LLM 的上下文，会被压缩
```

当上下文被压缩后，早期的消息从 `context.jsonl` 中消失了。但它们仍然完整地保存在 `log.jsonl` 中。Mom 可以用 bash 工具 grep 这个文件，找到任意历史信息。

这相当于给 agent 提供了**无限的可搜索历史**——不是把所有历史都塞进上下文（那会超出窗口），而是在需要时按需检索。

### 记忆的本质：写入 + 检索

不管具体实现方式如何，所有记忆机制都遵循同一个模式：

```
信息产生 → 判断是否值得记住 → 写入持久化存储 → 需要时检索 → 注入上下文
```

不同的实现只是在每个环节做了不同的选择：

| 环节 | MEMORY.md 方案     | update_memory 方案 | log.jsonl + grep 方案 |
| ---- | ------------------ | ------------------ | --------------------- |
| 判断 | 模型或人类决定     | 模型决定           | 全部保存              |
| 写入 | 写 Markdown 文件   | 写知识库           | 追加 JSONL            |
| 检索 | 每次全量加载       | 按需加载           | grep 搜索             |
| 注入 | 放入 system prompt | 放入上下文         | 作为工具结果返回      |

### 记忆的特点

| 特性     | 描述                                   |
| -------- | -------------------------------------- |
| 存储位置 | 磁盘（文件/数据库）                    |
| 生命周期 | 跨会话（只要存储存在就有效）           |
| 访问速度 | 取决于检索方式（全量加载快，搜索较慢） |
| 持久性   | 有（独立于会话和进程）                 |
| 用途     | 跨会话保留用户偏好、项目知识、长期规则 |

## 三者的关系

现在我们可以把三个概念放在一起比较：

```
┌─────────────────────────────────────────────────────────────────┐
│                        记忆（Memory）                           │
│  跨会话的持久化知识                                              │
│  MEMORY.md / 知识库 / log.jsonl                                 │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    会话（Session）                         │  │
│  │  单次对话的持久化记录                                      │  │
│  │  ~/.pi/agent/sessions/xxx.jsonl                           │  │
│  │                                                           │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │                  状态（State）                       │  │  │
│  │  │  当前运行时的内存快照                                │  │  │
│  │  │  AgentState { messages, model, tools, ... }         │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

三者是嵌套关系：

- **状态**是最内层，生命周期最短（进程级别），但访问最快
- **会话**是中间层，生命周期中等（跨进程，但限于单次对话），需要文件 I/O
- **记忆**是最外层，生命周期最长（跨会话），但检索成本最高

信息在三者之间的流动：

```
用户输入 → 状态更新（messages.push）
                ↓
         会话持久化（appendFileSync 写入 JSONL）
                ↓
         记忆提取（模型决定写入 MEMORY.md 或知识库）

恢复时反向流动：

记忆加载（读取 MEMORY.md → 注入 system prompt）
    ↓
会话恢复（读取 JSONL → buildSessionContext → messages）
    ↓
状态重建（AgentState.messages = 恢复的消息）
```

### 一个完整的例子

让我们用一个完整的例子来说明三者如何协作：

**第一天，会话 A：**

```
你：我们的项目用 TypeScript，缩进用 tabs
Agent：好的，我记住了。[调用 update_memory 保存偏好]
你：帮我创建一个 utils.ts 文件
Agent：[创建文件，使用 tabs 缩进] 已创建。
```

此时：

- **状态**：包含 4 条消息（2 条用户消息 + 2 条助手回复 + 工具调用结果）
- **会话**：JSONL 文件中有对应的条目
- **记忆**：知识库中保存了"项目用 TypeScript，缩进用 tabs"

你关闭终端。状态消失。

**第二天，会话 B：**

```
你：帮我创建一个 helpers.ts 文件
```

此时：

- **状态**：只有 1 条用户消息（这是新会话）
- **会话**：新的 JSONL 文件，只有 1 个条目
- **记忆**：知识库中仍然有"项目用 TypeScript，缩进用 tabs"

Agent 在调用模型前，会把记忆注入上下文。所以即使这是新会话，模型也知道要用 tabs 缩进。

**第二天，恢复会话 A：**

```
你：（通过 /resume 命令恢复昨天的会话）
你：刚才创建的 utils.ts 还需要加个导出
```

此时：

- **状态**：从会话 A 的 JSONL 文件恢复，包含昨天的所有消息 + 新的用户消息
- **会话**：继续写入昨天的 JSONL 文件
- **记忆**：不变

Agent 看到了昨天的完整对话历史，知道 `utils.ts` 是什么、在哪里、内容是什么。

## 压缩与记忆的关系

第 5 章讨论了上下文压缩（compaction）。压缩和记忆有什么关系？

压缩是一种**短期记忆管理**策略。当上下文窗口快满时，把早期的消息压缩成摘要：

```
压缩前：[msg1] [msg2] [msg3] [msg4] [msg5] [msg6] [msg7] [msg8]
压缩后：[摘要: msg1-msg4 的总结] [msg5] [msg6] [msg7] [msg8]
```

压缩后，msg1-msg4 的细节丢失了，但摘要保留了关键信息。这让 agent 能在有限的上下文窗口中处理更长的对话。

但压缩有一个重要的限制：**它只在当前会话内有效**。摘要是会话的一部分，不会自动传递到其他会话。

这就是为什么需要独立的记忆机制：

- **压缩**解决的是"当前会话太长"的问题
- **记忆**解决的是"跨会话保留知识"的问题

在 pi-mono 中，压缩记录作为 `CompactionEntry` 保存在会话文件中：

```typescript
export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string; // 压缩摘要
  firstKeptEntryId: string; // 保留的第一个条目 ID
  tokensBefore: number; // 压缩前的 token 数
  details?: unknown; // 扩展数据（如文件操作记录）
}
```

恢复会话时，`buildSessionContext` 会处理压缩：先放摘要，再放保留的消息，再放压缩后的新消息。这样模型看到的上下文是连贯的，即使早期的细节已经被压缩了。

## 不同 agent 形态的记忆策略

不同的 agent 产品对记忆的需求不同，因此采用了不同的策略。

### Coding Agent（packages/coding-agent）

Coding agent 的典型使用模式是：打开终端 → 做一个任务 → 关闭。偶尔会恢复之前的会话继续工作。

它的记忆策略是：

- **状态**：`AgentState` 持有当前对话
- **会话**：`SessionManager` 把对话保存到 JSONL 文件，支持恢复和分支
- **记忆**：通过 `update_memory` 工具保存用户偏好，通过 context files（`.pi/` 目录下的规则文件）注入项目级知识

这种策略的特点是**会话为主，记忆为辅**。大部分信息通过会话恢复获取，只有跨会话的通用偏好才需要记忆。

### Slack Bot（packages/mom）

Mom 的使用模式完全不同：她在一个频道中持续运行，可能跨越数周甚至数月。频道中有多个用户，话题不断切换。

她的记忆策略是：

- **状态**：每次被 @mention 时重建
- **会话**：`context.jsonl` 保存 LLM 上下文，会被压缩
- **记忆**：`MEMORY.md` 保存长期知识，`log.jsonl` 保存完整历史（可 grep 搜索）

这种策略的特点是**记忆为主，会话为辅**。因为频道对话是持续的、多话题的，不可能把所有历史都放进上下文。`MEMORY.md` 保存了最重要的规则和偏好，`log.jsonl` 提供了按需检索的能力。

### Web UI（packages/web-ui）

Web UI 的使用模式类似聊天应用：用户在浏览器中和 agent 对话，可以有多个会话。

它的记忆策略是：

- **状态**：`AgentState` 持有当前对话
- **会话**：使用浏览器的 IndexedDB 存储，分为 `sessions`（完整数据）和 `sessions-metadata`（轻量元数据）两个存储
- **记忆**：目前主要依赖会话恢复，没有独立的跨会话记忆机制

```typescript
// packages/web-ui/src/storage/types.ts
export interface SessionMetadata {
  id: string;
  title: string;
  createdAt: string;
  lastModified: string;
  messageCount: number;
  usage: { input: number; output: number; ... };
  thinkingLevel: ThinkingLevel;
  preview: string;  // 前 2KB 的对话文本，用于搜索和预览
}
```

Web UI 把会话元数据和完整数据分开存储，这样列出所有会话时不需要加载每个会话的完整消息——只需要读取轻量的元数据。

## 设计后果与权衡

### 为什么状态和会话要分开

你可能会想：为什么不直接让状态持久化？每次状态变化都自动保存到磁盘，不就不需要单独的会话层了吗？

原因有几个：

1. **性能**：状态变化非常频繁（每个 token 到达都会更新 `streamingMessage`）。如果每次变化都写磁盘，I/O 开销太大。会话层只在关键时刻（消息完成、工具执行完成）才写入。

2. **格式差异**：状态是内存中的对象，适合快速访问和修改。会话是磁盘上的 JSONL，适合追加写入和顺序读取。两者的最优格式不同。

3. **树结构**：会话支持分支和导航，这需要 `id`/`parentId` 的树结构。状态中的 `messages` 只是一个线性数组——它是树的某一条路径的投影，不是完整的树。

4. **关注点分离**：`Agent` 类只关心"怎么运行循环"，不关心"怎么保存到磁盘"。`SessionManager` 只关心"怎么持久化和恢复"，不关心"怎么调用模型"。

### 为什么记忆不直接放进会话

你可能还会想：为什么不把记忆也保存在会话文件中？

因为记忆的生命周期和会话不同：

- 会话是**一次对话**的记录。你可能有几十个会话，每个会话讨论不同的话题。
- 记忆是**跨所有对话**的知识。"用户喜欢 tabs 缩进"这个信息应该在所有会话中都可用。

如果把记忆放在会话中，每个新会话都需要从所有历史会话中提取记忆，这既复杂又低效。独立的记忆存储让这个问题变得简单：启动新会话时，直接加载记忆文件即可。

### 追加式写入的好处

会话文件使用追加式写入（append-only），而不是每次都重写整个文件。这有几个好处：

1. **性能**：追加写入比重写快得多，尤其是会话文件变大之后
2. **安全**：即使写入过程中崩溃，已有的数据不会损坏（最多丢失最后一行）
3. **简单**：不需要复杂的事务机制

代价是文件可能包含"死"数据——比如被分支抛弃的条目仍然在文件中。但这些数据不影响正确性（`buildSessionContext` 只沿当前分支读取），而且 JSONL 格式的空间开销很小。

### 记忆的"遗忘"问题

记忆机制有一个容易被忽视的问题：**什么时候应该遗忘**？

如果记忆只增不减，它最终会变得太大，要么超出上下文窗口，要么包含过时的信息。比如用户说"我们用 React 16"，半年后升级到了 React 19，但记忆中还保留着旧信息。

pi-mono 中的 `update_memory` 工具支持三种操作：

- **create**：创建新记忆
- **update**：更新已有记忆
- **delete**：删除已有记忆

这让模型可以主动管理记忆的生命周期。但这依赖于模型的判断力——如果模型没有意识到某条记忆已经过时，它就不会去更新或删除。

Mom 的 `MEMORY.md` 方案在这方面更灵活：因为它是普通的 Markdown 文件，人类可以直接编辑、删除过时的内容。这种"人机协作"的记忆管理方式，在实践中往往比纯模型驱动更可靠。

## 后续章节预告

本章区分了记忆、会话和状态三个概念，建立了对 agent 数据管理的整体认知。

下一章（第 7 章：统一模型接口为什么重要）将进入第二阶段——理解底层 LLM 接口层。我们会深入 `packages/ai`，看看它是如何把不同模型提供商的差异封装起来的，以及为什么这种封装对 agent 系统至关重要。

## 小练习

1. **理解三者的生命周期**：画一个时间线，标注以下场景中状态、会话、记忆各自的创建和销毁时刻：(a) 启动 agent → 对话 → 关闭终端 → 重新启动 → 恢复会话 → 继续对话。

   > **关键信息**：
   >
   > ```
   > 时间 →
   >
   > 状态 A：  |████████████████|                    （进程 1 退出，状态消失）
   > 状态 B：                      |████████████████| （进程 2 启动，新状态创建）
   >
   > 会话：    |████████████████████████████████████| （JSONL 文件持续存在）
   >                               ↑
   >                    buildSessionContext 恢复
   >
   > 记忆：    |██████████████████████████████████████████████...（跨会话持续存在）
   > ```
   >
   > 关键观察：
   >
   > - **状态 A** 在进程 1 退出时消失，**状态 B** 在进程 2 启动时从会话文件恢复。两个状态对象不同，但内容（通过会话恢复）是连续的。
   > - **会话**的生命周期跨越两个进程。JSONL 文件在进程 1 中创建并写入，在进程 2 中被读取和继续写入。
   > - **记忆**的生命周期最长，不受进程或会话的影响。即使删除了会话文件，记忆仍然存在。

2. **看会话文件**：如果你已经使用过 pi coding agent，去 `~/.pi/agent/sessions/` 目录下找到一个 `.jsonl` 文件，用文本编辑器打开它。识别其中的 `session`（头部）、`message`（消息）、`compaction`（压缩）等条目类型。注意 `id` 和 `parentId` 是如何形成链的。

   > **关键信息**：一个典型的会话文件结构如下：
   >
   > ```
   > 第 1 行：{"type":"session","version":3,"id":"...","timestamp":"...","cwd":"..."}
   > 第 2 行：{"type":"message","id":"a1b2c3d4","parentId":null,...}  ← 第一条消息，parentId 为 null
   > 第 3 行：{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4",...}  ← 指向上一条
   > 第 4 行：{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5",...}  ← 继续链接
   > ...
   > ```
   >
   > 你会发现：
   >
   > - 头部（`type: "session"`）没有 `id`/`parentId`，它不参与树结构
   > - 第一个消息条目的 `parentId` 为 `null`（树的根）
   > - 后续每个条目的 `parentId` 指向前一个条目的 `id`
   > - 如果有分支，你会看到两个条目的 `parentId` 指向同一个父条目
   > - `compaction` 条目包含 `summary`（摘要文本）和 `firstKeptEntryId`（保留的起始条目）

3. **对比 mom 和 coding-agent 的记忆**：阅读 `packages/mom/README.md` 中关于 Memory 和 Message History 的部分，对比 `packages/coding-agent` 的会话管理。思考：为什么 mom 需要 `log.jsonl` 和 `context.jsonl` 两个文件，而 coding-agent 只需要一个 JSONL 文件？

   > **关键信息**：核心原因是**使用模式不同**：
   >
   > **Coding agent** 是单用户、任务导向的。一个会话通常围绕一个任务（"帮我重构这个模块"），用户和 agent 一对一交互。所有消息都是 LLM 上下文的一部分，所以一个文件就够了。
   >
   > **Mom** 是多用户、持续运行的。一个频道中有多个用户在聊天，大部分消息 mom 只是旁观（记录到 `log.jsonl`），只有被 @mention 时才需要响应。如果把所有频道消息都放进 LLM 上下文，会迅速超出窗口。所以需要两个文件：
   >
   > - `log.jsonl`：**完整历史**，所有消息都记录，永不压缩。这是"真相源"（source of truth），也是 grep 搜索的目标。
   > - `context.jsonl`：**LLM 上下文**，只包含 mom 需要"看到"的消息。被 @mention 时从 `log.jsonl` 同步新消息，上下文满时会压缩。
   >
   > 这种分离让 mom 能在有限的上下文窗口中工作，同时保留无限的可搜索历史。Coding agent 不需要这种分离，因为它的所有消息本来就是 LLM 上下文的一部分。

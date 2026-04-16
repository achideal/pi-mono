# 需求文档

## 引言

本文档定义了 `tutorial/step-1/chap-0-the-full-journey.md` 的需求。该章节作为整个教程系列的"第零章"，旨在为读者提供一幅完整的全景图：当用户在终端中输入一条消息并按下回车后，pi 系统内部到底发生了什么？消息经过了哪些层次、哪些模块、哪些关键步骤，最终完成任务并将结果呈现给用户。

这一章不深入任何单一模块的实现细节（那是后续章节的工作），而是建立一个"端到端的心智模型"，让读者在进入具体章节之前，先对整个系统有一个清晰的全局认知。这类似于一张"地图"，后续每一章都是在这张地图上深入某个区域。

### 背景

pi-mono 是一个分层清晰的 coding agent 系统，包含以下核心层次：

- **LLM 接口层**（`packages/ai`）：统一多模型提供商的调用接口
- **Agent 运行时层**（`packages/agent`）：agent 循环、消息状态、工具执行
- **产品层**（`packages/coding-agent`）：面向真实开发任务的 coding agent，包含会话管理、压缩、扩展系统等
- **交互界面层**（`packages/tui`、`packages/web-ui`）：终端和浏览器交互界面
- **应用部署层**（`packages/mom`、`packages/pods`）：Slack bot 和模型部署

现有教程从 chap-1 开始逐层讲解，但缺少一个"全流程鸟瞰"章节，让读者在深入之前先看到完整链路。

---

## 需求

### 需求 1：全流程概览叙事

**用户故事：** 作为一名零基础的读者，我希望在开始学习具体模块之前，能看到一条用户消息从输入到完成的完整旅程，以便我对整个系统有一个端到端的全局认知。

#### 验收标准

1. WHEN 读者打开 chap-0 THEN 文档 SHALL 以一个具体的用户场景（例如用户输入"帮我读取 config.json 并总结内容"）作为贯穿全文的主线，逐步展示消息在系统中的流转过程。
2. WHEN 文档描述全流程 THEN 文档 SHALL 按照消息实际经过的时间顺序，依次覆盖以下阶段：用户输入 → UI 层接收 → 扩展系统预处理 → 消息构建 → Agent 循环启动 → 上下文组装 → LLM 调用 → 流式响应 → 工具调用解析 → 工具执行 → 结果回写 → 再次调用 LLM → 最终响应 → 会话持久化 → UI 渲染。
3. WHEN 文档描述每个阶段 THEN 文档 SHALL 明确指出该阶段属于哪个包（`packages/ai`、`packages/agent`、`packages/coding-agent`、`packages/tui`），让读者能将流程与代码层次对应起来。

### 需求 2：系统分层架构图

**用户故事：** 作为一名零基础的读者，我希望看到一张清晰的系统分层架构图，以便我理解各个包之间的依赖关系和职责边界。

#### 验收标准

1. WHEN 文档介绍系统架构 THEN 文档 SHALL 包含一张分层架构图（可使用 Mermaid 或文本图），展示从底层到顶层的层次关系：LLM Provider → `packages/ai` → `packages/agent` → `packages/coding-agent` → `packages/tui` / `packages/web-ui`。
2. WHEN 架构图展示层次 THEN 文档 SHALL 用一句话说明每一层的核心职责，以及它为上层提供了什么、从下层依赖了什么。
3. WHEN 架构图展示层次 THEN 文档 SHALL 明确标注 `packages/mom` 和 `packages/pods` 作为独立的应用/部署层的位置。

### 需求 3：消息流转的关键数据变换

**用户故事：** 作为一名零基础的读者，我希望理解消息在不同层次之间传递时发生了哪些关键的数据变换，以便我理解为什么需要这么多层抽象。

#### 验收标准

1. WHEN 文档描述消息流转 THEN 文档 SHALL 解释以下关键变换节点：
   - 用户输入的原始文本如何变成 `AgentMessage`
   - `AgentMessage[]` 如何经过 `transformContext()` 进行裁剪/注入
   - `AgentMessage[]` 如何经过 `convertToLlm()` 变成 LLM 能理解的 `Message[]`
   - LLM 返回的流式事件如何被组装成 `AssistantMessage`
   - `AssistantMessage` 中的 `toolCall` 如何被提取并执行
   - 工具执行结果如何变成 `ToolResultMessage` 回写到上下文
2. WHEN 文档描述数据变换 THEN 文档 SHALL 对每个变换节点用简短的示意（伪代码或文字描述）说明输入和输出的形态差异，而非直接贴大段源码。

### 需求 4：Agent 循环的核心状态机

**用户故事：** 作为一名零基础的读者，我希望理解 Agent 循环的核心状态转换逻辑，以便我知道 pi 是如何决定"继续调用模型"还是"去执行工具"还是"结束任务"的。

#### 验收标准

1. WHEN 文档描述 Agent 循环 THEN 文档 SHALL 包含一张状态转换图（Mermaid 或文本图），展示 agent loop 的核心状态：等待输入 → 调用 LLM → 解析响应 → 发现工具调用 → 执行工具 → 回写结果 → 再次调用 LLM → 无工具调用则结束。
2. WHEN 文档描述状态转换 THEN 文档 SHALL 解释 `stopReason` 的不同取值（`stop`、`toolUse`、`error`、`aborted`）如何影响循环的走向。
3. WHEN 文档描述 Agent 循环 THEN 文档 SHALL 提及 steering（中途插话）和 follow-up（追加任务）机制的存在，说明循环不是简单的"问一次答一次"，但不需要深入细节。

### 需求 5：事件流与 UI 渲染的关系

**用户故事：** 作为一名零基础的读者，我希望理解 agent 内部的事件流是如何驱动 UI 实时更新的，以便我理解为什么 pi 能边生成边显示、边执行工具边反馈进度。

#### 验收标准

1. WHEN 文档描述事件流 THEN 文档 SHALL 列出核心事件类型（`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_end`、`turn_end`、`agent_end`）并用一句话说明每个事件的含义。
2. WHEN 文档描述事件与 UI 的关系 THEN 文档 SHALL 解释 UI 层（TUI 或 Web UI）通过订阅这些事件来实现实时渲染，而不是等待全部完成后一次性显示。
3. WHEN 文档描述流式输出 THEN 文档 SHALL 提及 `text_delta`、`thinking_delta`、`toolcall_delta` 等流式事件的存在，说明模型输出是逐 token 到达的。

### 需求 6：会话持久化与恢复

**用户故事：** 作为一名零基础的读者，我希望了解 pi 是如何保存和恢复会话状态的，以便我理解为什么关闭终端后还能继续之前的对话。

#### 验收标准

1. WHEN 文档描述会话管理 THEN 文档 SHALL 简要说明 `SessionManager` 的角色：在每条消息结束时持久化到磁盘，支持会话恢复、分支和树形导航。
2. WHEN 文档描述会话管理 THEN 文档 SHALL 提及 compaction（上下文压缩）机制的存在，说明当上下文过长时系统会自动压缩历史消息，但不需要深入压缩算法细节。

### 需求 7：扩展系统在流程中的角色

**用户故事：** 作为一名零基础的读者，我希望了解扩展系统在消息处理流程中的介入点，以便我理解 pi 的可定制性。

#### 验收标准

1. WHEN 文档描述扩展系统 THEN 文档 SHALL 简要列出扩展系统在全流程中的主要介入点：`input` 事件（输入预处理）、`before_agent_start`（agent 启动前注入上下文）、`before_tool_call` / `after_tool_call`（工具执行前后拦截）、`message_start` / `message_end`（消息生命周期）。
2. WHEN 文档描述扩展系统 THEN 文档 SHALL 强调这只是概览，详细的扩展开发将在后续章节展开。

### 需求 8：章节定位与导航

**用户故事：** 作为一名零基础的读者，我希望 chap-0 能清晰地告诉我后续每一章在全流程中对应的位置，以便我在学习后续章节时能随时回到这张"地图"上定位自己。

#### 验收标准

1. WHEN 文档结尾 THEN 文档 SHALL 包含一个"后续章节导航"部分，将全流程中的每个阶段映射到对应的教程章节编号（chap-1 到 chap-6 及后续章节）。
2. WHEN 导航部分列出章节映射 THEN 文档 SHALL 用简短的一句话说明每章聚焦的流程阶段，帮助读者建立"地图坐标"。

### 需求 9：写作风格与格式一致性

**用户故事：** 作为教程的维护者，我希望 chap-0 的写作风格与已有章节（chap-1 到 chap-6）保持一致，以便整个教程系列读起来是一个连贯的整体。

#### 验收标准

1. WHEN 撰写 chap-0 THEN 文档 SHALL 遵循已有章节的格式规范：包含"前置知识"、"本章聚焦的层次"等标准开头部分。
2. WHEN 撰写 chap-0 THEN 文档 SHALL 遵循 AGENTS.md 中 Tutorial Authoring 部分的所有规则，包括：先建立直觉再展示代码、解释每个抽象存在的原因、使用具体对比而非单纯定义。
3. WHEN 撰写 chap-0 THEN 文档 SHALL 保持中文撰写，技术术语首次出现时给出英文原文。
4. WHEN 引用仓库代码 THEN 文档 SHALL 以概念解释为主、代码引用为辅，代码片段应简短且有明确的上下文说明，不做大段代码粘贴。
5. IF 文档中包含流程图或架构图 THEN 文档 SHALL 使用 Mermaid 格式，以便在 Markdown 渲染器中直接显示。

### 需求 10：文件位置与命名

**用户故事：** 作为教程的维护者，我希望 chap-0 放在正确的目录位置并遵循命名规范，以便与现有教程结构保持一致。

#### 验收标准

1. WHEN 创建 chap-0 文件 THEN 文件 SHALL 存放在 `tutorial/step-1/` 目录下，文件名为 `chap-0-the-full-journey.md`。
2. WHEN 命名文件 THEN 文件名 SHALL 遵循已有章节的命名模式：`chap-{n}-{short-title}.md`，使用简短直接的英文标题。

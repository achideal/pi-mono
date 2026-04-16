# 需求文档

## 引言

本文档定义了为 pi-book 编写一份深度源码讲解文档的需求。该文档基于 `pi-book/src/ch03-reading-map.md` 中"先读的 10 个文件"列表，按照 **pi-ai → pi-agent-core → pi-coding-agent** 的自底向上顺序，对每个文件中的关键类型、函数、属性进行详细讲解，并补充说明每个元素是如何被上层消费的。

目标读者是希望深入理解 pi-mono 仓库架构的开发者。文档应兼具"参考手册"的精确性和"导读"的可读性。

## 需求

### 需求 1：文档结构与组织

**用户故事：** 作为一名开发者，我希望文档按照 pi-ai → pi-agent-core → pi-coding-agent 的分层顺序组织，以便我能自底向上地理解系统的类型依赖链。

#### 验收标准

1. WHEN 读者打开文档 THEN 文档 SHALL 按三个层级（pi-ai 层、pi-agent-core 层、pi-coding-agent 层）组织内容
2. WHEN 文档介绍每一层 THEN 文档 SHALL 先给出该层的定位概述，再逐文件展开
3. WHEN 文档介绍每个文件 THEN 文档 SHALL 包含以下子节：文件概述、关键类型/接口详解、关键函数详解、消费关系说明
4. IF 某个类型在底层定义但在上层被扩展或消费 THEN 文档 SHALL 明确标注消费路径（如 `pi-ai.Message → pi-agent-core.AgentMessage → pi-coding-agent.SessionMessageEntry`）

### 需求 2：pi-ai 层文件讲解

**用户故事：** 作为一名开发者，我希望详细了解 pi-ai 层的三个核心文件（types.ts、api-registry.ts、stream.ts），以便我理解 LLM 调用的底层抽象。

#### 验收标准

1. WHEN 讲解 `packages/ai/src/types.ts` THEN 文档 SHALL 逐一讲解以下关键类型及其每个属性的含义：
   - `Model<TApi>` — id、name、api、provider、baseUrl、reasoning、input、cost、contextWindow、maxTokens、headers、compat
   - `Context` — systemPrompt、messages、tools
   - `Message`（联合类型）— UserMessage、AssistantMessage、ToolResultMessage 及各自的字段
   - `AssistantMessageEvent`（联合类型）— 所有事件变体（start、text_start/delta/end、thinking_start/delta/end、toolcall_start/delta/end、done、error）
   - `StreamFunction<TApi, TOptions>` — 签名与契约
   - `Tool<TParameters>` — name、description、parameters
   - `StreamOptions` / `SimpleStreamOptions` — 各配置项
   - 内容类型：`TextContent`、`ThinkingContent`、`ImageContent`、`ToolCall`
   - `Usage`、`StopReason`
2. WHEN 讲解 `packages/ai/src/api-registry.ts` THEN 文档 SHALL 讲解：
   - `ApiProvider<TApi, TOptions>` 接口 — api、stream、streamSimple
   - `registerApiProvider()` — 注册逻辑与 wrapStream/wrapStreamSimple 的类型安全包装
   - `getApiProvider()` — 查找逻辑
   - `unregisterApiProviders()` / `clearApiProviders()` — 清理机制
   - 内部 Map 注册表的设计
3. WHEN 讲解 `packages/ai/src/stream.ts` THEN 文档 SHALL 讲解：
   - `stream()` 函数 — 原始流式调用
   - `streamSimple()` 函数 — 带 reasoning 的简化流式调用
   - `complete()` / `completeSimple()` — 非流式便捷方法
   - `resolveApiProvider()` — 内部 provider 解析
   - 顶部 `import "./providers/register-builtins.js"` 的副作用导入机制
4. WHEN 讲解每个类型/函数 THEN 文档 SHALL 简要说明它被上层（pi-agent-core 或 pi-coding-agent）如何消费

### 需求 3：pi-agent-core 层文件讲解

**用户故事：** 作为一名开发者，我希望详细了解 pi-agent-core 层的三个核心文件（types.ts、agent-loop.ts、agent.ts），以便我理解 Agent 循环引擎的设计。

#### 验收标准

1. WHEN 讲解 `packages/agent/src/types.ts` THEN 文档 SHALL 逐一讲解以下关键类型及其属性：
   - `StreamFn` — 签名与契约（不抛异常、错误编码在流中）
   - `ToolExecutionMode` — "sequential" 与 "parallel" 的语义差异
   - `AgentToolCall` — 从 AssistantMessage 中提取的工具调用块
   - `BeforeToolCallResult` / `AfterToolCallResult` — 拦截与修改语义
   - `BeforeToolCallContext` / `AfterToolCallContext` — 上下文快照
   - `AgentLoopConfig` — 所有配置项（model、convertToLlm、transformContext、getApiKey、getSteeringMessages、getFollowUpMessages、toolExecution、beforeToolCall、afterToolCall）
   - `ThinkingLevel` — 推理级别枚举
   - `CustomAgentMessages` — 声明合并扩展机制
   - `AgentMessage` — Message + 自定义消息的联合
   - `AgentState` — 公共状态接口（systemPrompt、model、thinkingLevel、tools getter/setter、messages getter/setter、isStreaming、streamingMessage、pendingToolCalls、errorMessage）
   - `AgentToolResult<T>` — content + details
   - `AgentToolUpdateCallback<T>` — 部分更新回调
   - `AgentTool<TParameters, TDetails>` — 扩展自 Tool，增加 label、prepareArguments、execute
   - `AgentContext` — systemPrompt、messages、tools
   - `AgentEvent` — 所有事件类型（agent_start/end、turn_start/end、message_start/update/end、tool_execution_start/update/end）
2. WHEN 讲解 `packages/agent/src/agent-loop.ts` THEN 文档 SHALL 讲解：
   - `agentLoop()` / `agentLoopContinue()` — 公共入口，返回 EventStream
   - `runAgentLoop()` / `runAgentLoopContinue()` — 内部 async 实现
   - `runLoop()` — 核心双层循环（外层处理 follow-up、内层处理 tool calls + steering）
   - `streamAssistantResponse()` — LLM 调用边界（transformContext → convertToLlm → 构建 Context → 调用 streamFn）
   - `executeToolCalls()` — 分发到 sequential 或 parallel
   - `executeToolCallsSequential()` / `executeToolCallsParallel()` — 两种执行策略
   - `prepareToolCall()` — 工具查找、参数准备、验证、beforeToolCall 拦截
   - `executePreparedToolCall()` — 实际执行 + onUpdate 回调
   - `finalizeExecutedToolCall()` — afterToolCall 拦截
   - `emitToolCallOutcome()` — 构建 ToolResultMessage 并发射事件
3. WHEN 讲解 `packages/agent/src/agent.ts` THEN 文档 SHALL 讲解：
   - `Agent` 类 — 有状态壳的定位
   - `AgentOptions` — 构造选项
   - `MutableAgentState` — 内部可变状态（tools/messages 的 getter/setter 拷贝语义）
   - `PendingMessageQueue` — steering/followUp 队列（"all" vs "one-at-a-time" 模式）
   - `subscribe()` — 事件订阅机制
   - `prompt()` / `continue()` — 公共 API
   - `steer()` / `followUp()` — 消息注入
   - `abort()` / `waitForIdle()` / `reset()` — 生命周期控制
   - `processEvents()` — 内部状态归约 + 监听器分发
   - `createContextSnapshot()` / `createLoopConfig()` — 构建循环参数
4. WHEN 讲解每个类型/函数 THEN 文档 SHALL 说明它如何消费 pi-ai 层的类型，以及如何被 pi-coding-agent 层消费

### 需求 4：pi-coding-agent 层文件讲解

**用户故事：** 作为一名开发者，我希望详细了解 pi-coding-agent 层的四个核心文件（session-manager.ts、system-prompt.ts、tools/edit.ts、extensions/types.ts），以便我理解产品层如何组装底层能力。

#### 验收标准

1. WHEN 讲解 `packages/coding-agent/src/core/session-manager.ts` THEN 文档 SHALL 讲解：
   - 会话文件格式（JSONL）与版本迁移（v1→v2→v3）
   - `SessionHeader` — 会话头部结构
   - `SessionEntry` 联合类型 — 所有条目类型（SessionMessageEntry、ThinkingLevelChangeEntry、ModelChangeEntry、CompactionEntry、BranchSummaryEntry、CustomEntry、CustomMessageEntry、LabelEntry、SessionInfoEntry）
   - `SessionContext` — messages + thinkingLevel + model
   - `buildSessionContext()` — 树遍历算法（从叶到根、compaction 处理、branch summary 处理）
   - `SessionManager` 类 — 核心方法（newSession、appendMessage、appendCompaction、branch、branchWithSummary、createBranchedSession、getTree、getBranch、buildSessionContext）
   - 静态工厂方法（create、open、continueRecent、inMemory、forkFrom、list、listAll）
   - 持久化机制（append-only JSONL、延迟写入直到首个 assistant 消息）
2. WHEN 讲解 `packages/coding-agent/src/core/system-prompt.ts` THEN 文档 SHALL 讲解：
   - `BuildSystemPromptOptions` — 所有配置项（customPrompt、selectedTools、toolSnippets、promptGuidelines、appendSystemPrompt、cwd、contextFiles、skills）
   - `buildSystemPrompt()` — 两条路径（customPrompt 替换 vs 默认模板拼装）
   - 默认模板的结构（角色定义 → Available tools → Guidelines → Pi documentation → appendSection → Project Context → Skills → date/cwd）
   - 动态组装机制（工具列表、guidelines 去重、skills 格式化）
3. WHEN 讲解 `packages/coding-agent/src/core/tools/edit.ts` THEN 文档 SHALL 讲解：
   - `ToolDefinition` 接口（来自 extensions/types.ts）的实际应用
   - `editSchema` — TypeBox 参数定义（path + edits[]，每个 edit 有 oldText/newText）
   - `EditOperations` — 可插拔的文件操作接口（readFile、writeFile、access）
   - `createEditToolDefinition()` — 完整的工具定义工厂
   - `execute` 实现 — 文件读取 → BOM 处理 → 行尾规范化 → 应用编辑 → 写回 → 生成 diff
   - `prepareArguments` — 兼容旧版单 edit 参数格式
   - `renderCall` / `renderResult` — TUI 渲染钩子
   - `createEditTool()` — 从 ToolDefinition 到 AgentTool 的包装
4. WHEN 讲解 `packages/coding-agent/src/core/extensions/types.ts` THEN 文档 SHALL 讲解：
   - `ExtensionUIContext` — UI 交互方法（select、confirm、input、notify、setStatus、setWidget、setFooter、setHeader、custom、editor、setEditorComponent、theme 相关）
   - `ExtensionContext` — 事件处理器上下文（ui、cwd、sessionManager、modelRegistry、model、isIdle、signal、abort、getContextUsage、compact、getSystemPrompt）
   - `ExtensionCommandContext` — 命令处理器扩展上下文（waitForIdle、newSession、fork、navigateTree、switchSession、reload）
   - `ToolDefinition<TParams, TDetails, TState>` — 完整工具定义接口（name、label、description、promptSnippet、promptGuidelines、parameters、prepareArguments、execute、renderCall、renderResult）
   - `ExtensionAPI` — 扩展注册 API（on 事件订阅、registerTool、registerCommand、registerShortcut、registerFlag、registerMessageRenderer、sendMessage、sendUserMessage、appendEntry、registerProvider、unregisterProvider、events）
   - 所有事件类型分类（Resource Events、Session Events、Agent Events、Tool Events、Model Events、Input Events）
   - `ProviderConfig` / `ProviderModelConfig` — 自定义 provider 注册
   - `ExtensionFactory` — 扩展工厂函数签名

### 需求 5：消费关系与数据流说明

**用户故事：** 作为一名开发者，我希望文档清晰展示跨层的消费关系和数据流，以便我理解类型如何在三层之间流动。

#### 验收标准

1. WHEN 文档讲解完每个文件 THEN 文档 SHALL 在每个文件的末尾包含"消费关系"小节，说明该文件的类型/函数被哪些上层文件引用
2. WHEN 文档讲解 pi-ai 层 THEN 文档 SHALL 说明以下关键消费路径：
   - `Message` → `AgentMessage`（通过联合类型扩展）
   - `Tool` → `AgentTool`（通过接口扩展）
   - `streamSimple` → `StreamFn`（作为默认流函数）
   - `Context` → `AgentLoopConfig.convertToLlm` 的输出目标
   - `AssistantMessageEvent` → `AgentEvent.message_update` 的嵌入
3. WHEN 文档讲解 pi-agent-core 层 THEN 文档 SHALL 说明以下关键消费路径：
   - `Agent` 类 → `AgentSession` 的组合使用
   - `AgentTool` → `ToolDefinition` 的包装（通过 `wrapToolDefinition`）
   - `AgentMessage[]` → `SessionManager.appendMessage()` 的持久化
   - `AgentEvent` → `ExtensionEvent` 的映射
4. WHEN 文档讲解 pi-coding-agent 层 THEN 文档 SHALL 说明以下关键消费路径：
   - `SessionManager.buildSessionContext()` → `Agent.state.messages` 的同步
   - `buildSystemPrompt()` → `Agent.state.systemPrompt` 的设置
   - `ToolDefinition` → `AgentTool`（通过 `wrapToolDefinition` / `wrapRegisteredTool`）
   - `ExtensionAPI.registerTool()` → `Agent.state.tools` 的注入

### 需求 6：文档格式与质量

**用户故事：** 作为一名开发者，我希望文档格式清晰、代码示例准确，以便我能快速查阅和理解。

#### 验收标准

1. WHEN 文档引用代码 THEN 文档 SHALL 使用准确的 TypeScript 代码块，标注文件路径
2. WHEN 文档讲解复杂的数据流 THEN 文档 SHALL 使用 Mermaid 图表辅助说明
3. WHEN 文档讲解接口的属性 THEN 文档 SHALL 使用表格或缩进列表格式，包含属性名、类型、说明
4. IF 某个属性有默认值或特殊约束 THEN 文档 SHALL 标注默认值和约束条件
5. WHEN 文档完成 THEN 文档 SHALL 保存为 Markdown 格式，文件名体现内容主题

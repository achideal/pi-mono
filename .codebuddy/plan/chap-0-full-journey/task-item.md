# 实施计划

- [ ] 1. 创建 chap-0 文件并编写文档骨架与开头部分
  - 在 `tutorial/step-1/` 下创建 `chap-0-the-full-journey.md`
  - 编写标题、"前置知识"、"本章聚焦的层次"等标准开头部分，与 chap-1 格式保持一致
  - 编写引言段落：说明本章的定位——作为全教程的"地图"，提供端到端的全景视角
  - 选定贯穿全文的具体用户场景（如"帮我读取 config.json 并总结内容"），在引言中引出
  - _需求：1.1、9.1、9.2、9.3、10.1、10.2_

- [ ] 2. 编写系统分层架构图与各层职责说明
  - 使用 Mermaid 绘制分层架构图：LLM Provider → `packages/ai` → `packages/agent` → `packages/coding-agent` → `packages/tui` / `packages/web-ui`
  - 为每一层用一句话说明核心职责、对上层提供什么、从下层依赖什么
  - 标注 `packages/mom` 和 `packages/pods` 作为独立应用/部署层的位置
  - _需求：2.1、2.2、2.3_

- [ ] 3. 编写全流程概览叙事（用户输入 → UI 层 → 扩展预处理 → 消息构建 → Agent 循环启动）
  - 以选定的用户场景为主线，按时间顺序叙述前半段流程
  - 覆盖阶段：用户在终端输入 → TUI 层接收 → 扩展系统 `input` 事件预处理 → 构建 `UserMessage` → Agent 循环启动 → `before_agent_start` 扩展介入
  - 每个阶段明确标注所属的包（`packages/tui`、`packages/coding-agent`、`packages/agent`）
  - _需求：1.1、1.2、1.3、7.1_

- [ ] 4. 编写上下文组装与 LLM 调用阶段的叙事和数据变换说明
  - 叙述上下文组装阶段：`AgentMessage[]` 经过 `transformContext()` 裁剪/注入，再经过 `convertToLlm()` 变成 LLM 的 `Message[]`
  - 用简短伪代码或文字示意说明每个变换节点的输入输出形态差异
  - 叙述 LLM 调用阶段：`stream()` 函数将请求发送给模型 provider，流式事件开始返回
  - 明确标注所属的包（`packages/agent`、`packages/ai`）
  - _需求：1.2、3.1、3.2_

- [ ] 5. 编写流式响应 → 工具调用 → 工具执行 → 结果回写 → 再次调用 LLM 的叙事
  - 叙述流式响应阶段：`text_delta`、`toolcall_delta` 等事件逐 token 到达
  - 叙述工具调用解析：`AssistantMessage` 中的 `toolCall` 被提取
  - 叙述工具执行：`before_tool_call` → 实际执行 → `after_tool_call`
  - 叙述结果回写：工具执行结果变成 `ToolResultMessage` 回写到上下文
  - 叙述再次调用 LLM：agent 循环判断 `stopReason === 'toolUse'`，继续下一轮
  - 明确标注所属的包（`packages/ai`、`packages/agent`、`packages/coding-agent`）
  - _需求：1.2、1.3、3.1、3.2、7.1_

- [ ] 6. 编写 Agent 循环核心状态机图与状态转换说明
  - 使用 Mermaid 绘制 agent loop 状态转换图：等待输入 → 调用 LLM → 解析响应 → 发现工具调用 → 执行工具 → 回写结果 → 再次调用 LLM → 无工具调用则结束
  - 解释 `stopReason` 的不同取值（`stop`、`toolUse`、`error`、`aborted`）如何影响循环走向
  - 提及 steering（中途插话）和 follow-up（追加任务）机制的存在
  - _需求：4.1、4.2、4.3_

- [ ] 7. 编写事件流与 UI 渲染关系的说明
  - 列出核心事件类型（`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_end`、`turn_end`、`agent_end`）并用一句话说明含义
  - 解释 UI 层通过订阅事件实现实时渲染的机制
  - 提及 `text_delta`、`thinking_delta`、`toolcall_delta` 等流式事件，说明模型输出逐 token 到达
  - _需求：5.1、5.2、5.3_

- [ ] 8. 编写最终响应 → 会话持久化 → 扩展系统总结部分
  - 叙述最终响应阶段：模型返回 `stopReason === 'stop'`，循环结束，最终文本呈现给用户
  - 简要说明 `SessionManager` 的角色：持久化到磁盘、支持会话恢复/分支/树形导航
  - 提及 compaction（上下文压缩）机制的存在
  - 汇总扩展系统在全流程中的所有介入点，强调这只是概览
  - _需求：1.2、6.1、6.2、7.1、7.2_

- [ ] 9. 编写后续章节导航与小练习部分
  - 编写"后续章节导航"部分：将全流程每个阶段映射到 chap-1 至 chap-6 及后续章节
  - 每章用一句话说明聚焦的流程阶段，帮助读者建立"地图坐标"
  - 编写 1-2 个小练习，引导读者回顾全流程并与代码对应
  - _需求：8.1、8.2、9.1_

- [ ] 10. 全文审校与风格一致性检查
  - 检查全文是否遵循 AGENTS.md 中 Tutorial Authoring 的所有规则：先建立直觉再展示代码、解释每个抽象存在的原因、使用具体对比而非单纯定义
  - 检查技术术语首次出现时是否给出英文原文
  - 检查代码引用是否以概念解释为主、代码片段简短且有上下文说明
  - 检查所有 Mermaid 图是否语法正确
  - 确保全文中文撰写，风格与 chap-1 到 chap-6 保持一致
  - _需求：9.1、9.2、9.3、9.4、9.5_

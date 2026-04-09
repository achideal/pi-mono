# 从零开始学 Agent 开发：基于 pi-mono 的 30 章学习大纲

这份文档面向“没有任何 AI 或 agent 经验，但想借助这个项目系统入门”的读者。

目标不是先把你变成“会调 API 的人”，而是先建立一套稳定的心智模型：

- 模型是什么
- agent 和普通聊天程序有什么区别
- 工具调用、上下文、记忆、事件流分别解决什么问题
- 一个能真正工作的 coding agent 是怎样从底层一步步搭起来的

## 为什么适合用这个仓库入门

`pi-mono` 的分层比较清晰，适合学习：

- `packages/ai`: 统一不同模型提供商的 LLM 接口层
- `packages/agent`: agent 循环、消息状态、工具执行层
- `packages/coding-agent`: 面向真实开发任务的终端 agent 产品层
- `packages/tui`: 终端交互界面层
- `packages/web-ui`: 浏览器聊天界面层
- `packages/mom`: Slack bot 形态的 agent 应用层
- `packages/pods`: 自托管模型部署与运行层

你可以把它理解成一条完整链路：

`模型调用 -> agent 循环 -> 工具执行 -> 会话管理 -> 交互界面 -> 具体应用`

## 先铺垫几个基础概念

### 1. LLM 不是 agent

LLM 先把它当成“根据上下文预测下一个 token 的模型”。

它本身只负责“生成内容”，并不天然会：

- 读你的文件
- 执行命令
- 记住长期状态
- 安全地调用外部系统
- 管理复杂任务流程

这些能力，都是 agent runtime 和外围系统补出来的。

### 2. Agent = 模型 + 循环 + 工具 + 状态

一个实用 agent，通常至少包含四部分：

- 模型：负责理解和生成
- 循环：负责决定“继续问模型”还是“去执行工具”
- 工具：负责与外部世界交互
- 状态：保存消息、结果、错误、记忆、会话信息

如果没有循环和工具，它通常只是聊天程序。

### 3. Workflow 和 Agent 很像，但不一样

很多初学者会把 agent 和自动化流程混在一起。

- Workflow：流程由程序员提前写死
- Agent：流程中的一部分决策交给模型动态决定

例子：

- “先读文件，再总结，再发邮件”这类固定步骤，更像 workflow
- “先判断要不要读文件、读哪些文件、是否需要 grep、是否继续追问”更像 agent

### 4. Tool calling 是 agent 的关键转折点

模型一旦能“请求调用工具”，它就不再只是输出文本，而是开始驱动外部动作。

典型工具包括：

- 读文件
- 写文件
- 搜索代码
- 执行 shell 命令
- 请求网页或 API

这也是 coding agent 能真正做事的核心。

### 5. Context 不是“聊天记录”这么简单

上下文不仅仅是用户和助手消息。

它通常还包括：

- system prompt
- 工具定义
- 工具调用结果
- 历史消息摘要
- 附件、图片、文档
- 运行时注入的项目规则

Context 怎么组织，直接决定 agent 的表现上限和成本。

### 6. Memory 不是魔法记忆

多数 agent 的“记忆”本质上是以下几种机制的组合：

- 把历史消息继续放进上下文
- 把历史压缩成摘要
- 把关键信息写入文件或数据库
- 需要时再检索回来

所以“记忆”本质上是状态管理和检索，不是模型真的永久记住了你。

### 7. Streaming 不是锦上添花，而是交互能力的一部分

成熟 agent 往往不是等模型一次性吐完结果，而是边生成边显示，边产生事件：

- 文本流
- thinking 流
- tool call 流
- 工具执行进度
- 最终结束事件

这决定了 UI 是否流畅，也决定了你能否在中途打断、插话、恢复。

### 8. Agent 开发的难点不在“调用模型”，而在边界管理

真正难的是：

- 什么能交给模型决定
- 什么必须由程序硬控制
- 工具怎样设计才稳
- 错误和中断怎么恢复
- 如何控制成本、延迟和安全风险

也就是说，agent 更像“系统设计问题”，不只是“prompt 工程问题”。

### 9. 多数 agent 问题，本质是状态机问题

你可以把 agent 想成一个不断在这些状态之间切换的系统：

- 等待用户输入
- 调用模型
- 接收流式输出
- 发现工具调用
- 执行工具
- 写回工具结果
- 再次调用模型
- 完成、失败或中断

`packages/agent` 就是在把这件事工程化。

### 10. 学 agent，不要一开始就陷入“大而全”

零基础最容易误入三个坑：

- 一上来研究多 agent 编排
- 一上来研究微调、训练、RLHF
- 一上来研究复杂记忆和向量数据库

这三个都不是入门主线。

更好的顺序是：

1. 先理解单 agent 的基本闭环
2. 再理解工具、上下文和状态
3. 再去看 UI、记忆、安全和扩展性

## 一句话理解这个仓库的学习顺序

建议按下面的顺序学习：

1. 先看 `packages/ai`
2. 再看 `packages/agent`
3. 再看 `packages/coding-agent`
4. 然后按兴趣补 `packages/tui` 或 `packages/web-ui`
5. 最后看 `packages/mom` 和 `packages/pods`

原因很简单：

- `ai` 解决“怎么稳定地和模型说话”
- `agent` 解决“怎么把模型变成会工作的循环”
- `coding-agent` 解决“怎么把循环做成真实产品”
- `tui` / `web-ui` 解决“怎么让人舒服地和 agent 协作”
- `mom` / `pods` 解决“怎么把 agent 放进真实环境里”

## 30 章学习大纲

下面的大纲按 5 个阶段组织，每章都尽量小一些，方便你逐步消化。

---

## 第一阶段：先建立正确心智模型

### 第 1 章：什么是 LLM，什么不是

- 学什么：token、上下文窗口、采样、模型能力边界
- 重点认知：LLM 先是“生成器”，不是自主系统
- 仓库对应：`packages/ai`

### 第 2 章：什么是 Agent

- 学什么：聊天助手、workflow、agent 三者区别
- 重点认知：agent 的核心不是“更聪明”，而是“能驱动动作”
- 仓库对应：`packages/agent`

### 第 3 章：Agent 的最小闭环

- 学什么：用户消息、模型响应、工具调用、工具结果、继续推理
- 重点认知：这是所有 agent 形态的共同骨架
- 仓库对应：`packages/agent`, `packages/coding-agent`

### 第 4 章：为什么工具调用是分水岭

- 学什么：tool schema、tool call、tool result 的基本结构
- 重点认知：从“会说”到“会做”的关键就在这里
- 仓库对应：`packages/ai`, `packages/agent`

### 第 5 章：上下文为什么总是不够用

- 学什么：context window、历史消息膨胀、压缩与裁剪
- 重点认知：context 是 agent 的核心资源
- 仓库对应：`packages/ai`, `packages/coding-agent`

### 第 6 章：记忆、会话、状态三者的区别

- 学什么：短期上下文、长期存储、会话持久化
- 重点认知：不要把“记忆”神秘化
- 仓库对应：`packages/agent`, `packages/coding-agent`, `packages/mom`

---

## 第二阶段：理解底层 LLM 接口层

### 第 7 章：统一模型接口为什么重要

- 学什么：provider、model、API 兼容层
- 重点认知：应用层不应被单一模型厂商绑定
- 仓库对应：`packages/ai`

### 第 8 章：消息格式是 agent 的基础协议

- 学什么：`user`、`assistant`、`toolResult` 等消息角色
- 重点认知：消息结构决定后续一切能力
- 仓库对应：`packages/ai`, `packages/agent`

### 第 9 章：流式输出与事件流

- 学什么：`text_delta`、`thinking_delta`、`toolcall_delta` 一类事件
- 重点认知：agent 不是一次返回，而是事件驱动系统
- 仓库对应：`packages/ai`, `packages/agent`

### 第 10 章：Schema、校验与结构化参数

- 学什么：为什么工具参数要有 schema，为什么要校验
- 重点认知：不校验的工具调用，在工程里一定会变脆
- 仓库对应：`packages/ai`, `packages/agent`

### 第 11 章：多模型切换与跨 provider handoff

- 学什么：为什么要支持中途切换模型
- 重点认知：model selection 是运行时能力，不是编译时决定
- 仓库对应：`packages/ai`

### 第 12 章：错误、中断与恢复

- 学什么：abort、partial result、error message、retry
- 重点认知：稳定 agent 一定把失败当常态来设计
- 仓库对应：`packages/ai`, `packages/agent`

---

## 第三阶段：理解 Agent Runtime

### 第 13 章：Agent Loop 到底在循环什么

- 学什么：何时调用模型，何时执行工具，何时停止
- 重点认知：agent loop 是整个系统的控制中枢
- 仓库对应：`packages/agent`

### 第 14 章：为什么 Agent 需要自己的消息类型

- 学什么：应用消息与 LLM 消息的区别
- 重点认知：不是所有消息都该直接喂给模型
- 仓库对应：`packages/agent`, `packages/web-ui`

### 第 15 章：Context Transform 的作用

- 学什么：过滤、压缩、注入外部上下文
- 重点认知：高质量 agent 很大一部分工作发生在“送进模型之前”
- 仓库对应：`packages/agent`

### 第 16 章：工具执行是并行还是串行

- 学什么：parallel、sequential、preflight、执行顺序
- 重点认知：工具执行策略会影响正确性、速度和可解释性
- 仓库对应：`packages/agent`

### 第 17 章：beforeToolCall / afterToolCall 为什么重要

- 学什么：拦截、审计、重写结果、权限控制
- 重点认知：这是工程控制点，不该全靠 prompt
- 仓库对应：`packages/agent`

### 第 18 章：Steering 和 Follow-up 是什么

- 学什么：用户在 agent 工作途中插话、排队、打断
- 重点认知：真实交互不是单轮问答，而是协作过程
- 仓库对应：`packages/agent`, `packages/coding-agent`

---

## 第四阶段：从 Runtime 到真实产品

### 第 19 章：Coding Agent 为什么是学习 agent 的最佳样板

- 学什么：文件系统、shell、增量反馈、长任务
- 重点认知：coding agent 是最完整、最容易观察的 agent 形态
- 仓库对应：`packages/coding-agent`

### 第 20 章：内置工具如何塑造 agent 能力边界

- 学什么：`read`、`write`、`edit`、`bash` 这类工具的角色分工
- 重点认知：agent 能做什么，首先取决于工具集合
- 仓库对应：`packages/coding-agent`

### 第 21 章：Session 为什么是产品级能力

- 学什么：继续会话、分支、fork、resume、tree view
- 重点认知：一旦任务变长，会话管理就和模型能力同样重要
- 仓库对应：`packages/coding-agent`

### 第 22 章：Compaction 为什么不是可选项

- 学什么：长上下文压缩、保留最近消息、保留关键事实
- 重点认知：不做 compaction，agent 迟早失控或失忆
- 仓库对应：`packages/coding-agent`

### 第 23 章：Prompt Templates、Skills、Extensions 的分工

- 学什么：哪些属于提示层，哪些属于能力层，哪些属于系统扩展层
- 重点认知：扩展 agent 不只有“改 prompt”这一条路
- 仓库对应：`packages/coding-agent`

### 第 24 章：为什么说 UI 不是附属品

- 学什么：消息列表、工具折叠、thinking 展示、输入队列
- 重点认知：UI 直接影响 agent 的可控性和可理解性
- 仓库对应：`packages/tui`, `packages/coding-agent`

---

## 第五阶段：走向完整系统与真实场景

### 第 25 章：终端 UI 如何支撑 agent 协作

- 学什么：差分渲染、焦点管理、输入处理、覆盖层
- 重点认知：TUI 不是“打印文本”，而是交互运行时
- 仓库对应：`packages/tui`

### 第 26 章：Web UI 版本的 agent 有哪些额外问题

- 学什么：浏览器存储、附件、CORS、沙箱、artifact 展示
- 重点认知：同一套 runtime 到 Web 会新增大量工程约束
- 仓库对应：`packages/web-ui`

### 第 27 章：把 agent 放进 Slack 之后会发生什么

- 学什么：异步消息、频道上下文、事件唤醒、长期记忆
- 重点认知：agent 一旦进入团队协作场景，系统复杂度会明显上升
- 仓库对应：`packages/mom`

### 第 28 章：模型部署为什么也属于 agent 学习的一部分

- 学什么：本地/远程模型、vLLM、OpenAI 兼容接口、GPU 资源
- 重点认知：你最终要理解“agent 依赖怎样的推理基础设施”
- 仓库对应：`packages/pods`

### 第 29 章：评估、成本、延迟与安全

- 学什么：效果评估、工具成功率、token 成本、越权风险、提示注入
- 重点认知：能跑起来不代表能上线
- 仓库对应：全仓库，重点是 `packages/agent`, `packages/coding-agent`, `packages/mom`

### 第 30 章：做一个你自己的最小 Agent 产品

- 学什么：把前 29 章串起来，做一个可交互、可调用工具、可恢复会话的小系统
- 重点认知：真正掌握 agent 的标志，是你能自己做出闭环
- 仓库对应：建议从 `packages/ai` + `packages/agent` 起步，再参考 `packages/coding-agent`

## 推荐学习路线

如果你想“从理解到动手”逐步推进，我建议这样走：

1. 先读第 1 到第 6 章，建立概念，不急着写代码
2. 再读第 7 到第 12 章，理解 LLM 接口层
3. 然后重点攻克第 13 到第 18 章，这是 agent runtime 的核心
4. 接着读第 19 到第 24 章，理解真实产品怎么搭起来
5. 最后读第 25 到第 30 章，把 agent 放进完整系统场景

## 每章建议的学习动作

每一章都建议你做三件事：

1. 用自己的话复述概念，确认不是“看懂了其实没懂”
2. 去对应包的 README 和源码里找这个概念的落点
3. 写一个极小实验，只验证这一章的一个点

例如：

- 学完工具调用，就只做一个 `read_file` 工具
- 学完 agent loop，就只做一次“模型 -> 工具 -> 模型”的闭环
- 学完会话管理，就只做一次“保存上下文并恢复”

## 暂时不要急着深入的主题

在你完成前 18 章之前，不建议把主要精力放到下面这些主题：

- 多 agent 编排
- 向量数据库和复杂 RAG
- 微调、训练、RLHF
- 花哨的自动规划系统
- 过早做通用平台化设计

因为这些主题都建立在单 agent 基础已经扎实的前提上。

## 你学完这 30 章后，应该达到的状态

你不一定已经是“资深 agent 工程师”，但应该能做到：

- 说清楚 LLM、workflow、agent 的区别
- 自己实现一个最小 agent loop
- 为 agent 设计基础工具
- 处理上下文、会话和中断
- 看懂这个仓库里核心几个包的职责边界
- 开始针对某一种 agent 形态深入下去，比如 coding agent、web agent 或 Slack bot

## 下一步建议

如果你愿意，我下一步可以继续直接帮你写：

- `第 1 章` 的正式正文
- 或者把这 30 章继续扩成“每章学习目标 + 推荐源码入口 + 小练习”的详细版

# Pi Monorepo 系统架构图集

> 本文档从多种视角、粒度和侧重点，用 Mermaid 图展示 pi-mono 系统的架构设计。

---

## 1. 高层包依赖图（鸟瞰视角）

从最高层次展示 7 个包之间的依赖关系和各自定位。

```mermaid
graph TB
    subgraph "第 1 层 · 基础设施"
        AI["<b>pi-ai</b><br/>统一 LLM API<br/><i>20+ 提供商 · 10 种协议</i>"]
        TUI["<b>pi-tui</b><br/>终端 UI 框架<br/><i>差分渲染 · 组件系统</i>"]
    end

    subgraph "第 2 层 · 核心框架"
        AGENT["<b>pi-agent-core</b><br/>Agent 运行时<br/><i>状态管理 · 工具执行 · 事件流</i>"]
    end

    subgraph "第 3 层 · 应用"
        CODING["<b>pi-coding-agent</b><br/>编程 Agent CLI (pi)<br/><i>扩展系统 · 会话管理 · 内置工具</i>"]
        WEBUI["<b>pi-web-ui</b><br/>Web UI 组件库<br/><i>聊天界面 · Artifacts · 存储</i>"]
    end

    subgraph "第 4 层 · 集成"
        MOM["<b>pi-mom</b><br/>Slack 机器人<br/><i>Docker 沙箱 · 事件调度</i>"]
        PODS["<b>pi-pods</b><br/>GPU Pod 管理<br/><i>vLLM 部署 · SSH 自动化</i>"]
    end

    AGENT -->|依赖| AI
    CODING -->|依赖| AI
    CODING -->|依赖| TUI
    CODING -->|依赖| AGENT
    WEBUI -->|依赖| AI
    WEBUI -->|依赖| TUI
    MOM -->|依赖| AI
    MOM -->|依赖| AGENT
    MOM -->|依赖| CODING
    PODS -->|依赖| AGENT
```

---

## 2. 数据流全景图（端到端视角）

展示一条用户消息从输入到 LLM 响应再到工具执行的完整路径。

```mermaid
flowchart LR
    subgraph "用户界面层"
        U1["终端 TUI<br/>(pi-tui)"]
        U2["Web 浏览器<br/>(pi-web-ui)"]
        U3["Slack 消息<br/>(pi-mom)"]
    end

    subgraph "会话 & 编排层"
        S["AgentSession<br/>(pi-coding-agent)"]
        EXT["扩展系统<br/>Extension Runner"]
    end

    subgraph "Agent 核心层"
        A["Agent 类"]
        AL["agentLoop()"]
    end

    subgraph "LLM 通信层"
        ST["stream() / streamSimple()"]
        PR["Provider Registry"]
        subgraph "API 协议"
            P1["Anthropic"]
            P2["OpenAI"]
            P3["Google"]
            P4["Bedrock"]
            P5["...其他"]
        end
    end

    subgraph "工具执行层"
        T1["read"]
        T2["bash"]
        T3["edit"]
        T4["write"]
        T5["grep/find/ls"]
        TC["自定义工具<br/>(扩展注册)"]
    end

    U1 --> S
    U2 --> A
    U3 --> S
    S --> EXT
    EXT --> A
    A --> AL
    AL --> ST
    ST --> PR
    PR --> P1 & P2 & P3 & P4 & P5
    AL --> T1 & T2 & T3 & T4 & T5 & TC
    T1 & T2 & T3 & T4 & T5 & TC -->|工具结果| AL
    P1 & P2 & P3 & P4 & P5 -->|流式响应| AL
```

---

## 3. Agent Loop 详细时序图（运行时视角）

展示 Agent 核心循环的内部执行时序，包括消息注入、LLM 调用、工具执行和 steering 机制。

```mermaid
sequenceDiagram
    participant User as 用户
    participant Agent as Agent 类
    participant Loop as agentLoop()
    participant Ctx as transformContext()
    participant Conv as convertToLlm()
    participant LLM as LLM Provider
    participant Tool as Tool Executor
    participant Sub as 事件订阅者

    User->>Agent: prompt("修改 config.ts")
    Agent->>Sub: agent_start
    Agent->>Loop: 启动循环 (pending messages)

    loop 内层循环（每个 turn）
        Loop->>Sub: turn_start
        Loop->>Sub: message_start (user)
        Loop->>Sub: message_end (user)

        Note over Loop,LLM: 准备上下文
        Loop->>Ctx: transformContext(messages)
        Ctx-->>Loop: 裁剪后的 AgentMessage[]
        Loop->>Conv: convertToLlm(messages)
        Conv-->>Loop: LLM Message[]

        Note over Loop,LLM: 流式调用 LLM
        Loop->>LLM: streamSimple(model, context)
        Loop->>Sub: message_start (assistant)
        LLM-->>Loop: text_delta...
        Loop->>Sub: message_update (streaming)
        LLM-->>Loop: toolcall_start/delta/end
        Loop->>Sub: message_end (assistant)

        alt 有工具调用
            Note over Loop,Tool: 工具执行
            Loop->>Sub: tool_execution_start
            Loop->>Tool: execute(params, signal)
            Tool-->>Loop: AgentToolResult
            Loop->>Sub: tool_execution_end
            Loop->>Sub: message_start/end (toolResult)
        end

        Loop->>Sub: turn_end

        Note over Loop: 检查 steering 消息队列
        alt 有 steering 消息
            Loop->>Loop: 注入 steering 消息，继续循环
        else 有 follow-up 消息
            Loop->>Loop: 注入 follow-up 消息，继续外层循环
        else 无更多消息
            Loop->>Loop: 退出循环
        end
    end

    Agent->>Sub: agent_end
    Agent-->>User: Promise resolve
```

---

## 4. 消息类型体系（类型系统视角）

展示从底层 LLM 消息到应用层自定义消息的完整类型继承与转换关系。

```mermaid
graph TB
    subgraph "pi-ai · LLM 原始消息"
        UM["UserMessage<br/>{role: 'user', content}"]
        AM["AssistantMessage<br/>{role: 'assistant', content,<br/>usage, stopReason, model...}"]
        TR["ToolResultMessage<br/>{role: 'toolResult', toolCallId}"]
        MSG["Message = User | Assistant | ToolResult"]
        UM --> MSG
        AM --> MSG
        TR --> MSG
    end

    subgraph "pi-agent-core · Agent 消息"
        AMSG["AgentMessage =<br/>Message | CustomAgentMessages[*]"]
        MSG -->|标准消息| AMSG
        CUSTOM["CustomAgentMessages<br/>(声明合并扩展接口)"]
        CUSTOM -->|自定义消息| AMSG
    end

    subgraph "pi-coding-agent · 自定义消息类型"
        BE["BashExecutionMessage<br/>{role: 'bashExecution'}"]
        CM["CustomMessage<br/>{role: 'custom', customType}"]
        CS["CompactionSummaryMessage<br/>{role: 'compactionSummary'}"]
        BS["BranchSummaryMessage<br/>{role: 'branchSummary'}"]
        BE --> CUSTOM
        CM --> CUSTOM
        CS --> CUSTOM
        BS --> CUSTOM
    end

    subgraph "pi-web-ui · Web 消息类型"
        UMA["UserMessageWithAttachments<br/>{role: 'user-with-attachments'}"]
        ART["ArtifactMessage<br/>{role: 'artifact'}"]
        UMA --> CUSTOM
        ART --> CUSTOM
    end

    subgraph "转换层"
        CTL["convertToLlm()"]
        AMSG -->|"过滤 + 转换"| CTL
        CTL -->|"LLM 可用格式"| MSG
    end

    style MSG fill:#e1f5fe
    style AMSG fill:#f3e5f5
    style CUSTOM fill:#fff3e0
```

---

## 5. 内容块与流事件模型（协议视角）

展示 AssistantMessage 的内容块类型和流式事件协议。

```mermaid
graph LR
    subgraph "AssistantMessage 内容块"
        TEXT["TextContent<br/>{type: 'text', text}"]
        THINK["ThinkingContent<br/>{type: 'thinking',<br/>thinking, redacted?}"]
        TC["ToolCall<br/>{type: 'toolCall',<br/>id, name, arguments}"]
        IMG["ImageContent<br/>{type: 'image',<br/>data, mimeType}<br/><i>(仅 UserMessage)</i>"]
    end

    subgraph "流式事件协议 (AssistantMessageEvent)"
        direction TB
        START["start"]
        TS["text_start"] --> TD["text_delta ×N"] --> TE["text_end"]
        THS["thinking_start"] --> THD["thinking_delta ×N"] --> THE["thinking_end"]
        TCS["toolcall_start"] --> TCD["toolcall_delta ×N"] --> TCE["toolcall_end"]
        DONE["done<br/>{stopReason: stop | length | toolUse}"]
        ERR["error<br/>{stopReason: error | aborted}"]
    end

    START --> TS & THS & TCS
    TE & THE & TCE --> DONE
    TE & THE & TCE --> ERR
    
    TEXT -.->|生成| TS
    THINK -.->|生成| THS
    TC -.->|生成| TCS
```

---

## 6. LLM Provider 架构（提供商视角）

展示从 API 协议到商业提供商的映射关系和懒加载机制。

```mermaid
graph TB
    subgraph "统一入口"
        S["stream(model, context, options)"]
        SS["streamSimple(model, context, options)"]
    end

    subgraph "API 注册表"
        REG["apiProviderRegistry<br/>Map&lt;Api, RegisteredApiProvider&gt;"]
    end

    subgraph "API 协议层（10 种协议）"
        OC["openai-completions"]
        OR["openai-responses"]
        OCR["openai-codex-responses"]
        AZ["azure-openai-responses"]
        AN["anthropic-messages"]
        GG["google-generative-ai"]
        GC["google-gemini-cli"]
        GV["google-vertex"]
        MI["mistral-conversations"]
        BR["bedrock-converse-stream"]
    end

    subgraph "商业提供商（多对一映射）"
        P_OAI["OpenAI"]
        P_ANT["Anthropic"]
        P_GOO["Google"]
        P_GRO["Groq"]
        P_CER["Cerebras"]
        P_XAI["xAI"]
        P_OPR["OpenRouter"]
        P_VER["Vercel AI"]
        P_HF["Hugging Face"]
        P_AWS["Amazon Bedrock"]
        P_AZU["Azure OpenAI"]
        P_MIS["Mistral"]
        P_GCP["GitHub Copilot"]
        P_MM["MiniMax"]
        P_MORE["...其他"]
    end

    S --> REG
    SS --> REG
    REG --> OC & OR & OCR & AZ & AN & GG & GC & GV & MI & BR

    P_OAI --> OC
    P_OAI --> OR
    P_GRO --> OC
    P_CER --> OC
    P_XAI --> OC
    P_OPR --> OC
    P_VER --> OC
    P_HF --> OC
    P_MM --> OC
    P_MORE --> OC
    P_ANT --> AN
    P_GOO --> GG
    P_AWS --> BR
    P_AZU --> AZ
    P_MIS --> MI
    P_GCP --> OR

    style OC fill:#fff9c4
    style AN fill:#fce4ec
    style GG fill:#e8f5e9
    style BR fill:#e3f2fd
```

---

## 7. Coding Agent 内部架构（模块视角）

展示 pi-coding-agent 包内部的核心模块及其关系。

```mermaid
graph TB
    subgraph "CLI 入口"
        MAIN["main.ts<br/><i>参数解析 · 模式路由</i>"]
        ARGS["args.ts<br/><i>CLI 参数定义</i>"]
    end

    subgraph "运行模式"
        IM["InteractiveMode<br/><i>TUI 界面 · 155KB</i>"]
        PM["PrintMode<br/><i>-p 非交互</i>"]
        RM["RpcMode<br/><i>JSON-RPC stdin/stdout</i>"]
    end

    subgraph "核心 Session"
        AS["AgentSession<br/><i>核心会话类 · 99KB</i>"]
        ASR["AgentSessionRuntime<br/><i>多会话运行时</i>"]
        SDK["sdk.ts<br/><i>工厂函数</i>"]
    end

    subgraph "扩展系统"
        EL["ExtensionLoader<br/><i>发现 · 加载 · 注册</i>"]
        ER["ExtensionRunner<br/><i>事件分发 · 生命周期</i>"]
        ET["ExtensionAPI<br/><i>扩展开发接口</i>"]
    end

    subgraph "会话管理"
        SM["SessionManager<br/><i>JSONL 树结构 · 分支</i>"]
        CP["Compaction<br/><i>上下文压缩</i>"]
        BSM["BranchSummary<br/><i>分支摘要</i>"]
    end

    subgraph "模型系统"
        MR["ModelResolver<br/><i>模糊匹配 · 默认模型</i>"]
        MRG["ModelRegistry<br/><i>认证 · API Key · OAuth</i>"]
        AUTH["AuthStorage<br/><i>凭证持久化</i>"]
    end

    subgraph "工具系统"
        TI["tools/index.ts<br/><i>工具注册中心</i>"]
        TB["bash.ts"]
        TR["read.ts"]
        TE["edit.ts"]
        TW["write.ts"]
        TG["grep.ts"]
        TF["find.ts"]
        TL["ls.ts"]
    end

    subgraph "资源系统"
        RL["ResourceLoader<br/><i>扩展/技能/提示/主题 发现</i>"]
        SK["Skills<br/><i>Agent Skills 标准</i>"]
        PT["PromptTemplates<br/><i>/模板名 展开</i>"]
        TH["Themes<br/><i>主题热重载</i>"]
        PM2["PackageManager<br/><i>npm/git 包管理</i>"]
    end

    MAIN --> ARGS
    MAIN --> IM & PM & RM
    MAIN --> ASR
    ASR --> SDK --> AS

    AS --> ER
    AS --> SM
    AS --> MR
    AS --> TI
    AS --> CP & BSM

    EL --> ER
    ER --> ET

    MR --> MRG --> AUTH

    TI --> TB & TR & TE & TW & TG & TF & TL

    RL --> SK & PT & TH & PM2
    AS --> RL
```

---

## 8. 扩展系统事件流（扩展开发者视角）

展示扩展系统的全部事件类型和触发时机。

```mermaid
flowchart TB
    subgraph "资源发现阶段"
        RD["resources_discover<br/><i>提供额外资源路径</i>"]
    end

    subgraph "会话生命周期"
        SS["session_start<br/><i>startup | reload | new | resume | fork</i>"]
        SBS["session_before_switch<br/><i>可取消</i>"]
        SBF["session_before_fork<br/><i>可取消</i>"]
        SBC["session_before_compact<br/><i>可取消 · 可自定义</i>"]
        SC["session_compact"]
        SBT["session_before_tree<br/><i>可取消</i>"]
        ST["session_tree"]
        SSD["session_shutdown"]
    end

    subgraph "输入处理"
        INP["input<br/><i>continue | transform | handled</i>"]
        UB["user_bash<br/><i>! / !! 命令</i>"]
    end

    subgraph "Agent 循环事件"
        BAS["before_agent_start<br/><i>修改 system prompt</i>"]
        AGS["agent_start"]
        CTX["context<br/><i>修改 messages</i>"]
        BPR["before_provider_request<br/><i>修改 payload</i>"]
        TRS["turn_start"]
        MS["message_start"]
        MU["message_update<br/><i>流式 delta</i>"]
        ME["message_end"]
        TES["tool_execution_start"]
        TEU["tool_execution_update"]
        TEE["tool_execution_end"]
        TRE["turn_end"]
        AGE["agent_end"]
    end

    subgraph "工具拦截"
        TCA["tool_call<br/><i>可阻止 · 可修改参数</i>"]
        TRR["tool_result<br/><i>可修改结果</i>"]
    end

    subgraph "模型事件"
        MSE["model_select<br/><i>set | cycle | restore</i>"]
    end

    RD --> SS --> INP
    INP --> BAS --> AGS
    AGS --> CTX --> BPR --> TRS --> MS --> MU --> ME
    ME --> TCA --> TES --> TEU --> TEE --> TRR --> TRE
    TRE --> AGE
    
    SS --> SBS
    SS --> SBF
    SS --> SBC --> SC
    SS --> SBT --> ST
    SS --> SSD
```

---

## 9. Web UI 组件架构（前端视角）

展示 pi-web-ui 的组件层次和数据流。

```mermaid
graph TB
    subgraph "顶层面板"
        CP["ChatPanel<br/><i>高层聊天界面</i>"]
    end

    subgraph "核心组件"
        AI["AgentInterface<br/><i>消息列表 + 输入框</i>"]
        AP["ArtifactsPanel<br/><i>HTML/SVG/MD 交互</i>"]
    end

    subgraph "消息组件"
        ML["MessageList"]
        UM["UserMessage"]
        ASM["AssistantMessage"]
        TM["ToolMessage"]
        SMC["StreamingMessageContainer"]
        TB2["ThinkingBlock"]
    end

    subgraph "输入组件"
        ME["MessageEditor<br/><i>消息输入 + 附件</i>"]
        AT["AttachmentTile<br/><i>PDF/DOCX/图片预览</i>"]
    end

    subgraph "对话框"
        MS["ModelSelector"]
        SD["SettingsDialog"]
        SLD["SessionListDialog"]
        AKD["ApiKeyPromptDialog"]
    end

    subgraph "工具 & Artifacts"
        JR["JavaScript REPL"]
        ED["Extract Document"]
        HA["HtmlArtifact"]
        SA["SvgArtifact"]
        MA["MarkdownArtifact"]
        SI["SandboxedIframe<br/><i>安全沙箱执行</i>"]
    end

    subgraph "存储层"
        AS2["AppStorage"]
        SS2["SettingsStore"]
        PK["ProviderKeysStore"]
        SES["SessionsStore"]
        IDB["IndexedDBStorageBackend"]
    end

    subgraph "Agent 核心"
        AGT["Agent<br/><i>(pi-agent-core)</i>"]
    end

    CP --> AI & AP
    AI --> ML & ME
    ML --> UM & ASM & TM & SMC & TB2
    ME --> AT
    AI --> MS & SD & SLD & AKD

    AP --> HA & SA & MA & SI
    JR --> SI
    AGT --> AI
    AGT --> AP

    AS2 --> SS2 & PK & SES
    SS2 & PK & SES --> IDB
```

---

## 10. Mom Slack Bot 架构（集成视角）

展示 pi-mom 的内部架构和与 Slack 的交互流程。

```mermaid
flowchart TB
    subgraph "Slack"
        SC["Slack Cloud<br/>(Socket Mode)"]
    end

    subgraph "pi-mom 进程"
        SB["SlackBot<br/><i>消息接收 · 用户管理</i>"]
        MH["MomHandler<br/><i>频道路由 · 消息分发</i>"]
        AR["AgentRunner<br/><i>Agent 实例管理</i>"]
        EW["EventsWatcher<br/><i>文件系统事件监控</i>"]
        CTX["ContextManager<br/><i>log→context 同步</i>"]
        CS["ChannelStore<br/><i>频道数据持久化</i>"]
    end

    subgraph "执行环境"
        DK["Docker 沙箱<br/><i>(推荐)</i>"]
        HO["Host 模式<br/><i>(不推荐)</i>"]
    end

    subgraph "Agent 工具"
        T_BASH["bash"]
        T_READ["read"]
        T_EDIT["edit"]
        T_WRITE["write"]
        T_ATTACH["attach<br/><i>(上传到 Slack)</i>"]
    end

    subgraph "数据目录 ./data/"
        MEM["MEMORY.md<br/><i>全局记忆</i>"]
        EVT["events/<br/><i>JSON 事件文件</i>"]
        subgraph "频道目录 C123ABC/"
            LOG["log.jsonl<br/><i>完整历史</i>"]
            CJSON["context.jsonl<br/><i>LLM 上下文</i>"]
            CMEM["MEMORY.md<br/><i>频道记忆</i>"]
            SKILL["skills/<br/><i>自建工具</i>"]
            ATT["attachments/"]
        end
    end

    SC <-->|Socket Mode| SB
    SB --> MH
    MH --> AR
    MH --> CS

    AR --> T_BASH & T_READ & T_EDIT & T_WRITE & T_ATTACH
    T_BASH --> DK
    T_BASH --> HO
    T_ATTACH -->|上传文件| SC

    EW -->|监控| EVT
    EW -->|触发| AR
    CTX --> LOG
    CTX --> CJSON
    AR --> CTX
    CS --> LOG & ATT
    AR --> MEM & CMEM & SKILL
```

---

## 11. 会话持久化与分支模型（数据视角）

展示 JSONL 会话文件的树形结构和分支/压缩机制。

```mermaid
graph TB
    subgraph "JSONL 会话文件（单文件存储）"
        direction TB
        H["SessionHeader<br/>{version, createdAt}"]
        E1["Entry 1: user<br/>id=a, parentId=null"]
        E2["Entry 2: assistant<br/>id=b, parentId=a"]
        E3["Entry 3: user<br/>id=c, parentId=b"]
        E4["Entry 4: assistant<br/>id=d, parentId=c"]

        E5["Entry 5: user<br/>id=e, parentId=b<br/><i>⟵ 分支点！从 b 分出</i>"]
        E6["Entry 6: assistant<br/>id=f, parentId=e"]

        E7["Entry 7: compaction<br/>id=g, parentId=d<br/><i>压缩摘要</i>"]
        E8["Entry 8: user<br/>id=h, parentId=g"]
    end

    H --> E1 --> E2
    E2 --> E3 --> E4
    E2 --> E5 --> E6
    E4 --> E7 --> E8

    subgraph "操作"
        TREE["/tree — 在分支间导航"]
        FORK["/fork — 从分支创建新文件"]
        COMPACT["/compact — 压缩旧消息"]
    end

    style E5 fill:#fff3e0
    style E7 fill:#e1f5fe
```

---

## 12. 工具执行管道（工具系统视角）

展示一个工具从 LLM 请求到执行完成的完整管道。

```mermaid
flowchart LR
    subgraph "LLM 响应"
        TC["ToolCall<br/>{id, name, arguments}"]
    end

    subgraph "参数处理"
        PA["prepareArguments()<br/><i>兼容性预处理</i>"]
        VA["validateToolArguments()<br/><i>TypeBox schema 校验</i>"]
    end

    subgraph "拦截层"
        BTC["beforeToolCall hook<br/><i>Agent 级</i>"]
        ETC["tool_call 事件<br/><i>扩展级 · 可阻止 · 可修改</i>"]
    end

    subgraph "执行"
        EX["tool.execute()<br/><i>toolCallId, params,<br/>signal, onUpdate</i>"]
    end

    subgraph "后处理"
        ATC["afterToolCall hook<br/><i>Agent 级</i>"]
        ETR["tool_result 事件<br/><i>扩展级 · 可修改结果</i>"]
    end

    subgraph "结果"
        RES["AgentToolResult<br/>{content, details}"]
        TRM["ToolResultMessage<br/>→ 注入 messages"]
    end

    TC --> PA --> VA --> BTC --> ETC
    ETC -->|"未阻止"| EX
    ETC -->|"已阻止"| RES
    EX --> ATC --> ETR --> RES --> TRM
```

---

## 13. 多运行模式对比（使用模式视角）

展示 pi coding agent 的四种运行模式和各自的特点。

```mermaid
graph TB
    subgraph "pi CLI"
        CLI["pi [options] [messages...]"]
    end

    subgraph "Interactive 模式（默认）"
        IM["InteractiveMode<br/><br/>· 完整 TUI 界面<br/>· 键盘快捷键<br/>· Slash 命令<br/>· 模型切换<br/>· 扩展 UI<br/>· Steering / Follow-up"]
    end

    subgraph "Print 模式 (-p)"
        PM["PrintMode<br/><br/>· 非交互式<br/>· 处理一条消息后退出<br/>· 支持管道输入<br/>· Markdown 输出"]
    end

    subgraph "JSON 模式 (--mode json)"
        JM["JsonMode<br/><br/>· JSONL 事件流输出<br/>· 程序化解析<br/>· 所有事件类型"]
    end

    subgraph "RPC 模式 (--mode rpc)"
        RM["RpcMode<br/><br/>· stdin/stdout JSON-RPC<br/>· 双向通信<br/>· 编辑器集成<br/>· 会话控制"]
    end

    subgraph "SDK 嵌入"
        SDK["createAgentSession()<br/><br/>· Node.js 库调用<br/>· 完全控制<br/>· 多会话支持"]
    end

    CLI --> IM
    CLI -->|"-p"| PM
    CLI -->|"--mode json"| JM
    CLI -->|"--mode rpc"| RM
    SDK -->|"程序化"| IM & PM & RM
```

---

## 14. GPU Pod 部署架构（基础设施视角）

展示 pi-pods 管理的 GPU Pod 部署拓扑。

```mermaid
graph TB
    subgraph "本地 CLI"
        PODS["pi-pods CLI"]
        CFG["~/.pi/config.json<br/><i>Pod 配置 · SSH 信息</i>"]
    end

    subgraph "GPU Pod 1 (DataCrunch)"
        SSH1["SSH 连接"]
        subgraph "vLLM 实例"
            M1["Qwen-32B<br/>GPU 0 · Port 8001"]
            M2["GLM-4.5-Air<br/>GPU 1 · Port 8002"]
        end
        NFS["NFS 共享存储<br/><i>模型缓存</i>"]
    end

    subgraph "GPU Pod 2 (RunPod)"
        SSH2["SSH 连接"]
        subgraph "vLLM 实例 "
            M3["GPT-OSS-120B<br/>GPU 0-3 · Port 8001"]
        end
        VOL["网络卷<br/><i>持久存储</i>"]
    end

    subgraph "客户端"
        AG["pi agent<br/><i>交互式测试</i>"]
        OAI["OpenAI 兼容客户端<br/><i>任意应用</i>"]
    end

    PODS --> CFG
    PODS -->|SSH| SSH1 & SSH2
    SSH1 --> M1 & M2
    SSH2 --> M3
    M1 & M2 --> NFS
    M3 --> VOL

    AG -->|"HTTP :8001"| M1
    OAI -->|"HTTP :8001"| M1
    OAI -->|"HTTP :8001"| M3
```

---

## 15. 跨提供商消息转换（兼容性视角）

展示在切换 LLM 提供商时消息需要经过的兼容性转换。

```mermaid
flowchart TB
    subgraph "原始 AssistantMessage（来自提供商 A）"
        direction TB
        O1["TextContent {text, textSignature}"]
        O2["ThinkingContent {thinking,<br/>thinkingSignature, redacted}"]
        O3["ToolCall {id: 'call_abc...450chars',<br/>thoughtSignature}"]
    end

    subgraph "transformMessages()"
        direction TB
        C1{"同一模型?"}
        
        T1["保留 signature<br/>保留 redacted thinking"]
        T2["thinking → text<br/>(纯文本化)"]
        T3["删除 redacted thinking"]
        T4["截断 Tool Call ID<br/>(→ 64字符)"]
        T5["删除 thoughtSignature"]
        T6["textSignature → 删除"]
    end

    subgraph "孤儿修复"
        F1["检测无 ToolResult 的 ToolCall"]
        F2["插入合成错误结果<br/>{isError: true,<br/>'No result provided'}"]
    end

    subgraph "错误跳过"
        S1["跳过 stopReason='error'<br/>和 'aborted' 的消息"]
    end

    subgraph "发送到提供商 B"
        R["转换后的 Message[]"]
    end

    O1 & O2 & O3 --> C1
    C1 -->|是| T1
    C1 -->|否| T2 & T3 & T4 & T5 & T6
    T1 & T2 & T3 & T4 & T5 & T6 --> F1
    F1 --> F2
    F2 --> S1 --> R
```

---

## 16. 定制系统全景（可扩展性视角）

展示 pi coding agent 支持的所有定制机制。

```mermaid
mindmap
    root((Pi 定制系统))
        扩展 Extensions
            自定义工具
            自定义命令
            键盘快捷键
            CLI 标志
            生命周期钩子
            自定义 UI 组件
            自定义编辑器
            Provider 注册
        技能 Skills
            SKILL.md 文件
            自动/手动加载
            /skill:name 调用
            Agent Skills 标准
        提示模板 Prompts
            Markdown 文件
            /模板名 展开
            {{参数}} 占位符
        主题 Themes
            JSON 配色文件
            热重载
            dark / light 内置
        Pi 包 Packages
            npm 安装
            git 安装
            打包分享
            pi install/remove/update
        System Prompt
            AGENTS.md / CLAUDE.md
            .pi/SYSTEM.md 替换
            APPEND_SYSTEM.md 追加
        设置 Settings
            ~/.pi/agent/settings.json
            .pi/settings.json
            /settings 命令

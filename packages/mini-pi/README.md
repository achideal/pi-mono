# mini-pi

> 一个**最小可用、用于教学**的 coding agent 实现，完整镜像 `pi-mono` 的核心分层设计。
>
> 目标：让学习者通过 ~1500 行代码，吃透"一个真正可扩展的 agent 是如何组织的"。

## 为什么需要 mini-pi

`pi-mono` 是工业强度的 agent 框架，功能丰富但也因此阅读成本高。mini-pi 在**完整保留核心架构**的前提下，刻意砍掉所有工业强度特性（多 provider、thinking、steering、transport、retry、migration 等），只留下"**最小骨架**"——让分层、IoC、DI、事件驱动这些原则不被细节淹没。

mini-pi 不是"小号 pi"，而是 pi 的**架构 X 光片**。

## 分层总览

```
┌─────────────────────────────────────────────────────────┐
│  L4  web/         React 前端 + HTTP/SSE 后端 + 装配入口   │
├─────────────────────────────────────────────────────────┤
│  L3  agent/       Agent 外壳 (有状态)                     │
│      session/     SessionStore (有状态, 与 Agent 平级)    │
├─────────────────────────────────────────────────────────┤
│  L2  agent/       agent-loop 内核 (无长期状态)            │
├─────────────────────────────────────────────────────────┤
│  L1  ai/          Provider 实现 (StreamFn)               │
│      tools/       Tool 实现                              │
│      session/     SessionBackend 实现                    │
└─────────────────────────────────────────────────────────┘
```

每一层都有对应的 `README.md` 详细说明：

| 层 | 目录 | 文档 | 职责 |
|---|---|---|---|
| L1 | `src/ai/` | [ai/README.md](./src/ai/README.md) | 统一 LLM 调用的抽象（chat-completions & responses 两种协议） |
| L1 | `src/tools/` | [tools/README.md](./src/tools/README.md) | 工具协议与最小工具集（read_file / write_file / bash） |
| L1 | `src/session/` | [session/README.md](./src/session/README.md) | 会话持久化 + 上下文压缩 |
| L2 | `src/agent/` | [agent/README.md](./src/agent/README.md) | 无状态协议推进内核 + 有状态外壳 |
| L4 | `src/web/` | [web/README.md](./src/web/README.md) | HTTP/SSE 后端 + React 前端 |

## 核心设计原则

1. **Stateful Shell vs Stateless Core** — Agent 外壳 vs agent-loop 内核
2. **IoC + DI** — 主流程由内核掌握，外部能力（LLM / Tool / 持久化）全部参数化注入
3. **事件驱动** — Agent 发事件，UI 和 SessionStore 各自订阅，互不知道对方存在
4. **Composition Root** — 所有 `new` 和依赖装配只发生在 `web/server.ts`
5. **Append-only 会话** — SessionEntry 不可变，压缩通过追加新 entry 完成，不修改历史

## 与 pi-mono 的对照速查

| pi-mono | mini-pi | 说明 |
|---|---|---|
| `packages/ai` | `src/ai/` | 只保留 2 个 provider（chat-completions / responses），去掉 OAuth / retry / transport |
| `packages/agent` | `src/agent/` | 保留 Shell/Core 分层的**完整骨架**，去掉 steering / follow-up 队列 |
| `packages/coding-agent/core/session-manager.ts` | `src/session/` | 只保留线性链（id/parentId 字段预留但不做分支），去掉 v1→v3 迁移、label、fork |
| `packages/coding-agent/core/compaction/*` | `src/session/compactor.ts` | 只保留"按 tokens 触发 + 保留 tail"一种策略 |
| `packages/tui` / `packages/web-ui` | `src/web/` | React + SSE，行式 UI |

## 快速开始

```bash
# 环境变量
export MINI_PI_API_KEY=sk-...
export MINI_PI_BASE_URL=https://api.openai.com/v1  # 可选
export MINI_PI_PROVIDER=chat-completions           # 或 responses
export MINI_PI_MODEL=gpt-4o-mini

# 构建
cd packages/mini-pi
npm install
npm run build

# 启动（默认端口 5173）
npm start

# 打开浏览器
open http://localhost:5173
```

## 学习路径建议

阅读顺序（每层配套 README + 对照 pi-mono 源码）：

1. `src/ai/README.md` — 理解"provider 是一个函数"这件事
2. `src/tools/README.md` — 理解工具如何以**接口形式**被内核消费
3. `src/agent/README.md` — **最重要的一层**，理解 Shell/Core 分层
4. `src/session/README.md` — 理解"有状态协作者"如何与 Agent 平级共存
5. `src/web/README.md` — 理解装配入口（Composition Root）

## 不在范围内的事

mini-pi **刻意不做**以下事情：

- 多 provider（Anthropic / Google / Bedrock ...）
- Reasoning / Thinking 支持
- OAuth / API Key 轮换
- Retry / Transport 抽象
- Steering / Follow-up 队列
- 工具审批 / 权限系统
- 会话分支（branching）/ label / fork
- 多种压缩策略（层级摘要 / 滑动窗口）
- Skills / Slash commands
- Token 精确计数（只用粗估）

这些都是 `pi-mono` 里成熟而正确的特性，但与**核心分层理解**无关。理解了 mini-pi 后，你可以带着架构地图去读 `pi-mono` 的任何一个模块。

## License

MIT

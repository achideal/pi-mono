# web/ — HTTP/SSE 后端 + React 前端 + Composition Root（L4）

> **一句话**：mini-pi 的**唯一装配入口**。所有 `new` 和依赖握手都发生在 `server.ts`。

## 这一层负责什么

1. **Composition Root**（`server.ts`）
   - 读环境变量、pickProvider、new Agent + SessionStore
   - 编排压缩（跨 Agent + Store + Compactor 的事务）
2. **HTTP/SSE API**（`server.ts`）
   - RESTful 控制端点（会话 CRUD / prompt / abort）
   - SSE 单向事件流（`/api/events`）
3. **前后端共享契约**（`api.ts`）
   - 请求 / 响应 / SSE 事件类型（前后端都 import）
4. **事件总线**（`event-hub.ts`）
   - 多订阅者按 sessionId 分组
5. **React 前端**（`client/`）
   - `App.tsx`：会话列表 + 消息流 + 输入框
   - 状态管理：`applyServerEvent` 纯函数 reducer
   - 打包：`scripts/build-web.mjs` 用 esbuild

## HTTP API 速查

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/` | 静态 HTML |
| GET | `/client.js` | 打包后的前端 bundle |
| GET | `/api/sessions` | 列出当前 cwd 的会话 |
| POST | `/api/sessions` | 新建会话 |
| GET | `/api/sessions/:id` | 打开会话，返回重建后的 messages |
| GET | `/api/events?sessionId=xxx` | SSE 订阅 |
| POST | `/api/prompt` | 发起 prompt |
| POST | `/api/abort` | 中止 |

## 依赖什么能力

- **向下**：`agent/` / `ai/` / `tools/` / `session/` —— 全都 import
- **运行时**：Node `http`、`fs/promises`；前端 React 18

> 这是**唯一**允许同时 import 所有下层的文件。这就是 Composition Root 的定义。

## 核心设计理念

### 1. Composition Root —— 所有 `new` 都在这里

```ts
// server.ts 里的装配代码几乎是一个"依赖图的可视化"：
const backend = new FsSessionBackend();
const streamFn = pickProvider(PROVIDER_KIND);
const hub = new EventHub();

// 每个 sessionId 一套 runtime
const store = await SessionStore.open(sessionId, backend);
const agent = new Agent({ ..., streamFn, initialMessages: store.buildMessages() });
store.attachTo(agent);   // Store 订阅 Agent 事件
agent.subscribe((event) => hub.publish(sessionId, { kind: "agent", event }));  // SSE bridge
```

**好处**：要改装配（比如把 backend 换成 SQLite），只改这一个文件。下层零改动。

### 2. 跨组件事务 —— 压缩编排的例子

```ts
agent.subscribe(async (event) => {
   if (event.type === "agent_end" && event.reason === "stop") {
      const tokens = store.estimatedTokens();
      if (policy.shouldCompact(store.getEntries(), tokens)) {
         const result = await compact({...});
         await store.appendCompaction(result.summary, result.firstKeptEntryId, result.tokensBefore);
         agent.replaceTranscript(store.buildMessages());
      }
   }
});
```

这段代码的关键：**调用了三个组件**（`store.estimatedTokens` → `compact` → `store.appendCompaction` → `agent.replaceTranscript`）。按分层纪律，任何一个组件都不能做全部三件事 —— 只有 Composition Root 有资格。

### 3. SSE 而非 WebSocket

- **只读广播** + 一次性 HTTP POST 触发 = 典型的 SSE 场景
- 不需要 WebSocket 的双向通信
- SSE 天然走 HTTP 基础设施（代理、CORS、CDN 都友好）

### 4. 前后端类型共享

```ts
// src/web/api.ts 同时被：
// - server.ts 用（import type）
// - client/App.tsx 用（import type）

// 这让 ServerEvent / PromptRequest 等契约有**单一真相源**。
```

类型共享是减少前后端不一致 bug 的最低成本方案。**只要 `import type`**，esbuild 会把类型完全擦除，不会把 Node-only 代码拉进浏览器 bundle。

### 5. React 状态：事件 → state 纯函数 reducer

```ts
function applyServerEvent(state: ViewState, ev: ServerEvent): ViewState { ... }

// 在组件里：
setView((prev) => applyServerEvent(prev, ev));
```

- reducer 是纯函数，独立可测
- 组件只负责"把 state 渲染出来"
- 不引 Redux —— hooks + 纯 reducer 够用

### 6. 前端的"乐观更新"

```ts
// submit 时立刻 push 一条 user message 到 UI
setView((prev) => ({ ...prev, messages: [...prev.messages, userMsg], isRunning: true }));
await sendPrompt(...);
```

好处：即使 LLM 响应慢，用户也能立刻看到自己的消息。SSE 后续推来的 `message_end(user)` 已经被 reducer 处理（这里简化处理：容忍 user 消息可能被展示两次；生产代码应该按 id 去重）。

## 启动方式

```bash
cd packages/mini-pi
export OPENAI_API_KEY=sk-...
export MINI_PI_PROVIDER=chat-completions  # 或 responses
export MINI_PI_MODEL=gpt-4o-mini
npm install && npm run build
npm start
# 打开 http://localhost:5173
```

## 文件地图

| 文件 | 作用 |
|---|---|
| `server.ts` | Composition Root + HTTP server |
| `api.ts` | 前后端共享的请求/响应/事件类型 |
| `event-hub.ts` | SSE 事件总线 |
| `client/index.html` | 静态入口（内嵌 CSS，零依赖） |
| `client/main.tsx` | React 挂载 |
| `client/App.tsx` | 主组件 + 事件 reducer |
| `client/api.ts` | 客户端 API 封装 |
| `../../scripts/build-web.mjs` | esbuild 打包脚本 |
| `README.md` | 本文档 |

## 与 pi-mono 的对照

| mini-pi | pi-mono | 差异 |
|---|---|---|
| `server.ts`（~250 行） | `packages/coding-agent/src/main.ts`（700+ 行） | pi-mono 有 CLI 参数解析、多模态渲染、slash commands、skills 等 |
| React + esbuild | pi-mono 的 `packages/web-ui` 用 Lit + Vite | 技术选型不同，架构思路类似 |
| `event-hub.ts` | pi-mono 的 `event-bus.ts` | 概念一致，mini-pi 只做 SSE 推送，pi-mono 还做本地事件分发 |

## 一个可以回答的测试题

> **"我想把 Web UI 换成 CLI，要改哪几层？"**

**答案**：只重写 `src/web/`。把 `server.ts` 替换为 `cli.ts`（用 `readline` 读用户输入、用 ANSI 转义渲染），`agent/` / `tools/` / `session/` / `ai/` 全部**零改动**。

这是 mini-pi 全栈分层的收益：**UI 是一个可插拔的外壳**。

---

**教学路径回到起点** → [../../README.md](../../README.md)

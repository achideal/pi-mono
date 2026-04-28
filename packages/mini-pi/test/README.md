# test/ — 分层测试

> **一句话**：证明分层是真的 —— 每一层都能独立测试，不需要真的 LLM、不需要文件系统、不需要浏览器。

## 文件一览

| 文件 | 覆盖 | 关键验证 |
|---|---|---|
| `faux-provider.ts` | 测试工具（非测试本身） | `StreamFn` 作为函数类型的价值 |
| `agent-loop.test.ts` | L2 内核 | 不实例化 `Agent`，直接调 `runAgentLoop` |
| `agent.test.ts` | L3 外壳 | 并发锁、`replaceTranscript` 不变量、事件广播 |
| `session-store.test.ts` | L3 会话协作者 | append-only、compaction 重建、token 估算 |
| `integration.test.ts` | Agent + Store 协作 | `attachTo` 自动落盘、会话 reopen round-trip |

## 如何跑

```bash
cd packages/mini-pi
npx tsx ../../node_modules/vitest/dist/cli.js --run
# 或
npm test
```

## 为什么这些测试能成立（而不需要真 LLM）

### 1. Provider 是函数类型，直接替换

```ts
const faux = createFauxProvider([textReply("hi"), toolCallReply({...})]);
const agent = new Agent({ streamFn: faux.streamFn, ... });
```

`streamFn` 的类型就是 `async generator`，任何 async generator 都是合法的 provider。**不需要任何 mocking 框架**。

### 2. Backend 是接口，直接换内存实现

```ts
const backend = new InMemorySessionBackend();
const store = await SessionStore.create("/tmp/proj", backend);
```

`SessionBackend` 的两个实现（fs / in-memory）可以无差别替换。这就是 LSP。

### 3. 内核可以不依赖外壳

`agent-loop.test.ts` 中，我们**没有 new Agent**，直接调 `runAgentLoop` —— 证明内核是真正独立的。这是分层成功的最硬的证据。

## 一个有趣的观察

这份测试目录里没有任何"mock agent"、"mock backend"、"mock LLM" 工具。所有"假"的东西都是真正的**接口实现**：
- `createFauxProvider` 返回的是一个合法的 `StreamFn`（不是 mock）
- `InMemorySessionBackend` 是一个合法的 `SessionBackend`（不是 mock）

**好的抽象让 mock 变得不必要**。

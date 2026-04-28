# tools/ — 工具协议与最小工具集（L1）

> **一句话**：定义 `Tool` 接口并实现 3 个内置工具（`read_file` / `write_file` / `bash`），让 LLM 能真正"做事"。

## 这一层负责什么

1. **定义 `Tool` 接口**（`types.ts`）—— 工具的协议契约
2. **提供参数校验**（`validate.ts`）—— 极简 JSON Schema 校验
3. **实现 3 个最小工具**：
   - `read_file` —— 只读操作的代表
   - `write_file` —— 写操作的代表
   - `bash` —— 副作用 + 进程管理 + 超时 + abort 的代表
4. **导出 `DEFAULT_TOOLS`** —— 装配时直接用

## 暴露的公共接口

```ts
export interface Tool<Args> {
   schema: ToolSchema;
   execute(args: Args, signal?: AbortSignal): Promise<ToolResult>;
}

export function validateToolArguments(schema, args): ValidationError | null;

export const readFileTool: Tool;
export const writeFileTool: Tool;
export const bashTool: Tool;
export const DEFAULT_TOOLS: Tool[];
```

## 依赖什么能力

- **运行时**：Node `fs/promises`、`child_process`
- **mini-pi 内部**：仅依赖 `ai/` 的 `ToolSchema` 类型（向下依赖）
- **不依赖**：agent / session / web —— 工具是**叶子能力**，绝不反向依赖

## 设计理念

### 1. 接口而非基类

```ts
// ✅ 接口
export interface Tool<Args> { schema: ToolSchema; execute(...): Promise<ToolResult>; }

// ❌ 教学项目里**不要**用基类
export abstract class AbstractTool<Args> {
   abstract get schema(): ToolSchema;
   abstract execute(...): Promise<ToolResult>;
}
```

**为什么接口更好？**

- TypeScript 结构化类型让任何满足形状的对象都能当工具
- 测试里写一个 `{ schema: ..., execute: async () => ... }` 就是一个 mock 工具
- 基类会引入"继承树"，带来"跨工具共享行为"的诱惑，最终变成大泥球

### 2. ToolResult 是字符串，不是 structured output

```ts
export interface ToolResult {
   output: string;         // 给 LLM 看的文本
   isError?: boolean;
}
```

- LLM 消费的是文本，`output` 直接作为 `tool` 消息的 `content` 发回去
- `isError` 是给**外壳 / UI** 看的元信息，不改变 LLM 接口
- 刻意不支持图片 / 结构化数据 —— 这些是进阶特性

### 3. 校验是内核职责，实现在这一层

`validateToolArguments` 放在 tools 层，但**由 agent-loop 调用**：

```
agent-loop（消费者）→ validateToolArguments（工具层提供） → bool 结果
```

- 如果放在 agent 层，意味着"内核定义 JSON Schema 语义"，破坏依赖方向
- 放在 tools 层：tools 定义自己的 schema 语法，自己提供校验实现
- agent-loop 只需要知道"用这个函数能校验，返回 null 表示 OK"

### 4. 工具必须响应 abort signal

```ts
// read_file / write_file：检查一次就够（快操作）
if (signal?.aborted) return { output: "aborted", isError: true };

// bash：需要主动 kill 子进程
const onAbort = () => child.kill("SIGTERM");
signal?.addEventListener("abort", onAbort, { once: true });
```

为什么强制工具协作取消？

- Agent 的 `abort()` 信号通过 `AbortSignal` 传入 loop、再传入工具
- 如果工具不响应，用户按下 Ctrl+C 但 `bash sleep 3600` 继续跑 —— 糟糕体验
- 让 signal 穿透整条调用链，是**端到端可取消性**的关键

### 5. bash 做了什么保护

- **超时**：默认 30 秒 SIGTERM，避免教学环境 hang
- **输出截断**：stdout / stderr 各 100KB，防止 LLM context 爆炸
- **exit code 映射**：非 0 退出 → `isError: true`（让 agent 知道失败了）

这些保护**不是**为了让工具"防御用户"，而是为了让 LLM 不会因为失控输出导致下一轮请求失败。

### 6. 没有工具审批

pi-mono 有 `beforeToolCall` hook 做二次确认，mini-pi 也**保留**了这个 hook（在 agent-loop 里）——只是默认不启用。想加审批，只需要在装配时注入 `beforeToolCall`，不改任何内核代码。这就是 OCP。

## 文件地图

| 文件 | 作用 |
|---|---|
| `types.ts` | `Tool` / `ToolResult` 接口 |
| `validate.ts` | 极简参数校验 |
| `read-file.ts` | 只读文件工具 |
| `write-file.ts` | 写文件工具 |
| `bash.ts` | 执行 shell 命令（带超时/截断/abort） |
| `index.ts` | 公共导出 + `DEFAULT_TOOLS` |

## 与 pi-mono 的对照

| mini-pi | pi-mono | 差异 |
|---|---|---|
| `types.ts` | `packages/agent/src/types.ts` 的 `AgentTool` | pi-mono 的 tool 支持 `onUpdate` 流式进度、`prepareArguments` 预处理 |
| `validate.ts` | 用 `@sinclair/typebox` | pi-mono 用正式 JSON Schema 库；mini-pi 手写 |
| `read-file.ts` / `write-file.ts` | `packages/coding-agent/src/core/tools/` | pi-mono 工具多 10+ 个，都有权限检查、diff 展示等 |
| `bash.ts` | `packages/coding-agent/src/core/tools/bash.ts` + `bash-executor.ts` | pi-mono 有持久 shell session、pty、interactive 输入 |

## 如何加一个新工具（5 行示例）

```ts
// src/tools/get-time.ts
import type { Tool } from "./types.js";

export const getTimeTool: Tool<Record<string, never>> = {
   schema: { name: "get_time", description: "Current time", parameters: {}, required: [] },
   async execute() { return { output: new Date().toISOString() }; },
};
```

装配处加一行：

```ts
// web/server.ts
const agent = new Agent({ tools: [...DEFAULT_TOOLS, getTimeTool], ... });
```

**agent-loop 和任何内核代码都不改动。**

## 下一层

→ [../agent/README.md](../agent/README.md) 看 agent-loop 如何发现工具、校验参数、执行工具。

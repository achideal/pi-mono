# mini-pi-ai 阶段性总结

## 1. 当前目标

`mini-pi` 的目标不是重新做一套完整的 `pi`，而是保留当前项目里最有教学价值的核心抽象，做一个更小、更容易理解、可以逐步扩展的教学版实现。

当前阶段优先完成的是 `mini-pi-ai`：

- 放在 `packages/mini-pi` 内部
- 保留 `pi-ai` 的核心接口形状
- 支持通过 CLI/TUI 上层进行交互
- 后续可接入 `pi-tui` 做最小聊天界面

## 2. 本阶段已完成内容

本阶段已经完成 `mini-pi` 的最小 package 骨架，以及 `mini-pi-ai` 的第一版实现。

已落地的目录结构：

```text
packages/mini-pi/
  src/
    index.ts
    mini-pi-ai/
      index.ts
      types.ts
      config.ts
      stream.ts
      utils/
        event-stream.ts
        json-parse.ts
        sanitize-unicode.ts
      providers/
        transform-messages.ts
        openai-completions.ts
        openai-responses.ts
        openai-responses-shared.ts
  test/
    mini-pi-ai-config.test.ts
```

## 3. 当前设计原则

### 3.1 保留统一抽象，不做“大而全”

`mini-pi-ai` 保留了这些核心抽象：

- `Model`
- `Context`
- `Message`
- `Tool`
- `ToolResultMessage`
- `AssistantMessageEventStream`
- `stream()`
- `complete()`

但没有照搬完整 `pi-ai` 的所有能力。当前刻意省略了：

- 多 provider 注册表
- 懒加载 provider
- 自动模型发现
- 图片输入
- OAuth
- cross-provider handoff
- 成本计算与复杂兼容矩阵

这保证了教学时可以先把“统一事件流 + 两条 OpenAI 协议适配”讲清楚，再逐层扩展。

### 3.2 对外按“完整 endpoint URL”配置

这里没有让用户手动选择 `openai-completions` 或 `openai-responses`。

用户直接配置完整 endpoint，例如：

- `https://api.vectorengine.cn/v1/chat/completions`
- `https://api.vectorengine.cn/v1/responses`

`mini-pi-ai` 负责读取 URL、解析 pathname，然后自动路由到底层协议实现。

这比让用户理解内部 API 名称更友好，也更适合教学。

### 3.3 对内仍然区分两条协议

虽然对外是“给一个完整 URL”，但对内仍明确区分：

- `openai-completions`
- `openai-responses`

原因是这两条协议并不只是 URL 不同：

- 消息格式不同
- tool call 表达不同
- 流式事件结构不同
- reasoning/thinking 表达不同

教学上这正是重点之一：统一接口之下，底层协议仍然是不同的。

## 4. 配置设计

当前支持两类配置方式。

### 4.1 显式双路配置

适合同时保留两套 endpoint：

```env
MINI_PI_CHAT_API_URL=https://api.vectorengine.cn/v1/chat/completions
MINI_PI_CHAT_API_KEY=your-key
MINI_PI_CHAT_MODEL=gpt-5.4-mini

MINI_PI_RESPONSES_API_URL=https://api.vectorengine.cn/v1/responses
MINI_PI_RESPONSES_API_KEY=your-key
MINI_PI_RESPONSES_MODEL=gpt-5.4-mini
```

其中：

- `MINI_PI_CHAT_*` 对应 `/v1/chat/completions`
- `MINI_PI_RESPONSES_*` 对应 `/v1/responses`

### 4.2 通用回退配置

为了兼容当前已有的 `.env`，同时支持：

```env
API=openai-response
API_URL=https://api.vectorengine.cn
API_KEY=your-key
MODEL=gpt-5.4-mini
```

此时：

- `API=openai` 表示按 `chat/completions` 处理
- `API=openai-response` 表示按 `responses` 处理
- 如果 `API_URL` 只是根地址，内部会自动补成 `/v1/...`

### 4.3 覆盖优先级

配置读取策略是：

1. 先读取 `packages/mini-pi/.env`
2. 再用 `process.env` 覆盖

也就是说，运行环境里显式传入的环境变量优先级更高。

## 5. 当前路由规则

URL 解析后的路由规则如下：

- pathname 为 `/v1/chat/completions`
  - 路由到内部 `openai-completions`
- pathname 为 `/v1/responses`
  - 路由到内部 `openai-responses`

如果用户传的是根地址或 `/v1`，则需要配合 `API=openai` 或 `API=openai-response` 作为补充信息，由配置层补出最终 endpoint。

## 6. 事件流与上层使用方式

当前 `mini-pi-ai` 采用统一事件流设计。

### 6.1 事件类型

目前统一输出这些事件：

- `start`
- `text_start`
- `text_delta`
- `text_end`
- `thinking_start`
- `thinking_delta`
- `thinking_end`
- `toolcall_start`
- `toolcall_delta`
- `toolcall_end`
- `done`
- `error`

### 6.2 上层是否需要自己拼完整消息

不需要。

`mini-pi-ai` 底层已经负责把流里的碎片组装成完整 `AssistantMessage`。

上层推荐的使用方式是：

1. `const s = stream(model, context)`
2. `for await (const event of s) { ... }`
3. 用 `event.delta` 或 `event.partial` 做实时渲染
4. `const message = await s.result()`
5. 把完整 `message` 追加回 `context.messages`

也就是说：

- `delta` 用来做 UI 增量更新
- `result()` 用来拿最终完整消息

### 6.3 tool 的边界

当前 `mini-pi-ai` 保留了 tool 协议层能力，但不负责真正执行工具。

职责划分如下：

- `mini-pi-ai`
  - 发送工具定义
  - 解析模型返回的 `toolCall`
  - 接受上层追加的 `toolResult`
- `mini-pi` 上层 CLI/TUI
  - 发现 `toolCall`
  - 调用真实工具
  - 把 `toolResult` 加回上下文
  - 继续发起下一轮请求

这也是后续 `mini-pi` CLI 部分最需要补上的能力。

## 7. 当前实现重点

### 7.1 chat/completions adapter

`openai-completions.ts` 当前负责：

- 把统一 `Context` 转成 Chat Completions 请求格式
- 处理文本流
- 处理 reasoning 兼容字段
- 处理流式 tool call 参数
- 输出统一事件流

### 7.2 responses adapter

`openai-responses.ts` + `openai-responses-shared.ts` 当前负责：

- 把统一 `Context` 转成 Responses API 的输入结构
- 处理 reasoning item / message / function call
- 处理流式参数增量
- 输出与 `chat/completions` 一致的统一事件流

### 7.3 消息转换

`transform-messages.ts` 当前负责一些必要的对齐逻辑，例如：

- thinking 跨协议回放时的转换
- tool call id 的归一化
- 缺失 tool result 时补 synthetic result

这部分虽然是“兼容逻辑”，但也是教学里很值得单独讲的一层：统一接口背后往往需要消息修复层。

## 8. 测试与验证

本阶段已经补了最小配置测试，覆盖了这些场景：

- 通过 pathname 识别 `chat/completions`
- 通过 pathname 识别 `responses`
- `API_URL` + `API` 的通用回退
- `.env` 与 `process.env` 的覆盖关系
- 同时配置两套 endpoint 时必须显式选择

当前 package 级验证情况：

- `packages/mini-pi` 下 `npm run check` 通过
- `packages/mini-pi` 下配置测试通过

根目录 `npm run check` 已执行过，但失败在现有 `web-ui` 的类型检查阶段。这个问题看起来是仓库当前依赖构建/声明产物缺失导致的既有问题，不是 `mini-pi` 本阶段引入的新问题。

## 9. 当前局限

虽然 `mini-pi-ai` 已经具备最小教学价值，但当前还不是完整可交互产品。

目前尚未完成：

- `mini-pi` 的 CLI 入口
- 基于 `pi-tui` 的最小聊天界面
- 上层 tool loop
- 会话状态持久化
- 模型选择界面
- 更多错误恢复策略
- 文档中的实际运行示例

## 10. 下一步建议

下一阶段建议优先做以下内容：

### 10.1 做最小 CLI tool loop

先不用完整 TUI，先做最小命令行交互：

- 读一条用户输入
- 调 `mini-pi-ai.stream()`
- 实时打印文本 delta
- 如果有 `toolCall`，执行本地 mock/tool
- 追加 `toolResult`
- 继续下一轮

这样可以先把“统一消息循环”跑通。

### 10.2 再接 `pi-tui`

等 CLI 闭环稳定后，再接入 `pi-tui`：

- 消息区
- 输入框
- thinking 展示
- tool 调用展示

这样教学顺序会更自然：

1. 先理解协议
2. 再理解 agent loop
3. 最后再看交互层

### 10.3 补实际使用文档

后续建议再补一份更偏“怎么跑起来”的文档，内容包括：

- `.env` 示例
- 最小调用代码
- 最小 tool loop 示例
- `chat/completions` 和 `responses` 的差异说明

## 11. 一句话总结

当前 `mini-pi-ai` 已经完成了第一阶段最关键的部分：

在保留 `pi-ai` 核心抽象的前提下，用更小的实现同时接住了 `chat/completions` 和 `responses` 两条 OpenAI-compatible 协议，并把它们统一成了一套上层可消费的事件流接口。

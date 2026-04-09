# 第 1 章：什么是 LLM，什么不是

这一章是整套教程的起点。

你现在还不需要会写 agent，也不需要会调任何模型 API。你要先建立一套不会把自己带偏的心智模型。

这章的重点不是“把源码看懂”，而是先回答这些更基础的问题：

- `LLM` 到底是什么
- 为什么“能聊天的模型”还不等于“可编程的 agent 能力”
- 这个仓库为什么需要 `packages/ai` 这一层
- `provider`、`api`、`model`、`stream`、`complete` 这些词到底在说什么

## 本章在整套教程里的位置

这章属于第一阶段：建立正确心智模型。

它是后面几章的前提：

- 第 2 章会讲什么是 `agent`
- 第 3 章会讲最小 agent 闭环
- 第 7 章才会系统讲“统一模型接口为什么重要”

所以这一章不追求把所有细节讲到最深，而是要先把整个系统的地基打稳。

## 读完这一章后，你应该能说清楚

- 为什么 LLM 本质上是“生成器”，不是完整系统
- 为什么不同模型服务不能直接当作稳定的应用接口来写上层系统
- `packages/ai` 在整个 monorepo 里的上下游位置
- `stream` / `complete` / `streamSimple` / `completeSimple` 分别解决什么问题

## 1. 先把 LLM 放回正确位置

`LLM`，`Large Language Model`，大语言模型。

如果先去掉各种营销语言，可以先把它理解成一句话：

“一个根据已有上下文，不断预测下一个 token 的模型。”

这句话很重要，因为它直接决定你之后如何理解 agent。

它意味着：

- LLM 首先是一个“生成器”
- 它工作的基本单位是 `token`
- 它是逐步生成，不是先想完整再一次性吐出来

这也是为什么流式输出天然成立。因为模型本来就是一段一段往后长的。

### 什么是 token

`token` 不是“一个字”也不是“一个单词”的简单同义词。

更准确地说，它是模型处理文本时使用的内部切分单位。比如：

- 一个英文单词可能是 1 个 token，也可能拆成多个
- 一个中文短语通常也会拆成多个 token
- 标点、换行、空格也会占 token

为什么你现在就要关心 token？

因为后面 agent 系统里一堆核心问题都和它直接相关：

- 上下文能塞多少
- 一次调用花多少钱
- 响应为什么快或慢
- 长会话为什么会“失忆”

## 2. 为什么 LLM 看起来像“懂了”

现代 LLM 在非常大的语料上训练后，学会了大量复杂模式，所以它会表现得像是在理解问题。

它会：

- 总结
- 改写
- 解释
- 分类
- 模仿代码风格
- 按结构输出 JSON 或参数对象

这就是为什么你第一次用它时，很容易觉得它像“会思考的人”。

但在工程上，更稳的理解方式是：

“它是一个极强的模式压缩与生成系统。”

这个理解看起来没有那么浪漫，但更有用。因为它会让你更容易接受这些事实：

- 它会幻觉
- 它的局部回答可能很漂亮，但整体任务执行不一定稳定
- 它非常依赖上下文组织方式
- 它在没有外部工具时，并不能真正接触你的文件、命令行或网络

## 3. 为什么“能聊天的模型”不等于“可编程的系统接口”

这是初学者最容易跳过的一步。

很多人第一次看 agent 项目，会自然地想：

“既然模型已经会聊天了，那上层直接调模型不就行了吗？”

问题在于，上层系统真正需要的不是“某次它回答得还不错”，而是：

- 一个稳定的输入结构
- 一个稳定的输出结构
- 可预期的流式事件
- 可比较的 usage 和 cost
- 一致的 tool calling 行为
- 能被上层 runtime 和 UI 长期依赖的接口

而“裸 provider SDK”通常做不到这一点。

## 4. `provider` 到底是什么

在这套系统里，`provider` 可以先理解成：

“你从哪家服务拿模型能力。”

比如：

- OpenAI
- Anthropic
- Google
- Groq
- OpenRouter
- xAI

你可以把 `provider` 想成“模型服务提供方”或者“模型接入渠道”。

这个词很容易和 `model` 混淆。

区别是：

- `provider` 是服务方或入口
- `model` 是具体模型

比如：

- `provider = anthropic`
- `model = claude-sonnet-4-20250514`

## 5. `api` 又是什么，它和 `provider` 有什么区别

这是这一章最该讲清楚的词之一。

在 [packages/ai/src/types.ts](../../packages/ai/src/types.ts) 里，你会看到两组不同的类型：

- `KnownProvider`
- `KnownApi`

这两个词不是重复命名，而是在表达两种不同层次的东西。

### `provider`

`provider` 说的是“服务来自哪里”。

例如：

- `anthropic`
- `openai`
- `groq`
- `openrouter`

### `api`

`api` 说的是“这家服务在交互层面使用哪种协议族”。

例如：

- `anthropic-messages`
- `openai-completions`
- `openai-responses`
- `google-generative-ai`

### 为什么这两个词必须分开

因为现实里经常出现这两种情况：

1. 不同 `provider` 共享同一种 `api`
2. 同一个 `provider` 可能暴露不止一种 `api` 风格

举一个这个仓库里很典型的现象：

- 很多第三方服务虽然不是 OpenAI，但会暴露 `openai-completions` 兼容接口

这就是为什么系统不能只用“厂商名”建模，也不能只用“API 名”建模。两者都需要。

如果你把它们混成一个概念，后面理解 `packages/ai` 的设计就会一直别扭。

## 6. 为什么要统一不同 provider

这个问题不能只回答“因为方便”。要更具体。

统一 provider 的真正原因是：

“原始 provider 的能力虽然相似，但它们对同一件事的表达方式并不一样，而上层系统又需要一个稳定接口。”

### 差异一：消息结构不一样

一个 provider 可能要求：

- `system`、`user`、`assistant` 用某种结构表示

另一个 provider 可能要求：

- `system prompt` 放在单独字段
- 图片消息必须用不同内容块表示
- tool result 需要特殊 role 或特殊字段

所以你不能默认“消息就是一串字符串数组”。

### 差异二：流式事件不一样

这是最典型的一种不兼容。

在 [packages/ai/src/providers/anthropic.ts](../../packages/ai/src/providers/anthropic.ts) 里，Anthropic 的流式事件是按 `message_start`、`content_block_start`、`content_block_delta`、`message_delta` 这一类原生事件来的。

而在 [packages/ai/src/providers/openai-completions.ts](../../packages/ai/src/providers/openai-completions.ts) 里，OpenAI-compatible 流通常是从 `choice.delta` 里拆：

- 文本在 `choice.delta.content`
- tool call 在 `choice.delta.tool_calls`
- stop reason 在 `finish_reason`

也就是说，虽然两边都在“流式返回响应”，但事件形状根本不是同一种东西。

### 差异三：thinking 的表达方式不一样

有的 provider 明确给 reasoning/thinking block。

有的 provider 把 reasoning 放在不同字段里。

你甚至会在 [packages/ai/src/providers/openai-completions.ts](../../packages/ai/src/providers/openai-completions.ts) 里看到，它同时兼容：

- `reasoning_content`
- `reasoning`
- `reasoning_text`

这已经足够说明问题：

同样叫“thinking”，底层表达也并不统一。

### 差异四：tool calling 的格式和约束不一样

工具调用也不是“大家都一样”。

差异可能包括：

- tool schema 的表达方式
- tool call 参数是一次性给完整 JSON，还是流式拼出来
- tool result 的 role 和字段怎么写
- tool call id 的格式限制

这个仓库专门有一个 [packages/ai/src/providers/transform-messages.ts](../../packages/ai/src/providers/transform-messages.ts) 来处理跨 provider 的消息变换，其中就包括：

- 归一化 tool call id
- 把不兼容的 thinking block 转成兼容表示
- 给孤立 tool call 自动补 synthetic tool result

如果原始 provider 真能直接互换，这个文件根本就没有必要存在。

### 差异五：stop reason、错误和 usage 也不一样

对上层系统来说，“为什么停下”“有没有报错”“花了多少 token”“花了多少钱”都非常重要。

但不同 provider 在这些信息上的原生表达并不统一：

- stop reason 名字不一样
- usage 字段拆分方式不一样
- cache read / cache write 的定义不一样
- 某些字段甚至只在部分 provider 或部分代理上出现

所以如果不做统一，上层每接一家 provider 都要重写一遍解析逻辑。

## 7. `packages/ai` 在整个仓库里处在什么位置

现在可以把它放进整个 monorepo 的系统图里看了。

### 它的下层是什么

`packages/ai` 的下层包括两类东西：

1. 外部 provider SDK 和 HTTP API
2. 一些底层辅助能力

具体可以从 [packages/ai/package.json](../../packages/ai/package.json) 看出来，它依赖了：

- `openai`
- `@anthropic-ai/sdk`
- `@google/genai`
- `@aws-sdk/client-bedrock-runtime`
- `@mistralai/mistralai`

这些依赖代表的是“真正和外部模型服务打交道的人”。

除此之外，它还依赖一些辅助层：

- schema 和校验能力
- OAuth 相关能力
- JSON 流式解析
- usage / cost 计算

### 它的上层是什么

`packages/ai` 的上层不是用户界面，而是更高一层的运行时和产品层。

最直接的上层是 [packages/agent](../../packages/agent/README.md)：

- `@mariozechner/pi-agent-core` 明确写着自己 built on `@mariozechner/pi-ai`
- 它使用 `getModel()` 拿模型
- 再在其上实现 agent loop、工具执行、上下文转换、状态管理

再往上是 [packages/coding-agent](../../packages/coding-agent/README.md)：

- 它不是直接处理 provider 差异
- 它更多是在 agent runtime 之上做产品能力：session、compaction、TUI、skills、extensions

所以从系统关系上看：

`外部模型 SDK / HTTP API -> packages/ai -> packages/agent -> packages/coding-agent / web-ui / 其他产品`

## 8. `packages/ai` 为什么存在，而不是让上层直接调 provider SDK

现在可以直接回答这个问题了。

它存在，是因为上层真正想依赖的不是“某个厂商 SDK 的细节”，而是这些更稳定的能力：

- 统一的模型描述
- 统一的消息协议
- 统一的事件流
- 统一的 usage / cost 结构
- 统一的 tool calling 语义

如果没有 `packages/ai`：

- `packages/agent` 就得自己理解每一家 provider 的消息和流式格式
- `packages/coding-agent` 就得直接处理模型厂商差异
- UI 层也得分别处理不同厂商的事件形状

这会导致整个系统的复杂度向上传染。

`packages/ai` 的作用，就是把这些差异尽量压在更靠下的一层。

## 9. 但 `packages/ai` 不做什么

理解一个包，不只是知道它做什么，也要知道它故意不做什么。

`packages/ai` 不负责：

- agent loop
- 工具真正执行
- 会话持久化
- session compaction
- TUI 或 Web UI
- 用户交互流程

这些属于更高层。

这点非常重要，因为很多初学者看到 tool calling 就会以为：

“那这层是不是已经是 agent 了？”

还不是。

它只是把模型输出里的 `toolCall` 统一表示出来，但并不会替你真正执行工具，也不会驱动“模型 -> 工具 -> 模型”的循环。那是 [packages/agent](../../packages/agent/README.md) 的职责。

## 10. `packages/ai` 对外暴露了哪些能力

从 [packages/ai/src/index.ts](../../packages/ai/src/index.ts) 和 [packages/ai/package.json](../../packages/ai/package.json) 可以看出，它对外主要暴露几类能力。

### 10.1 模型与 provider 发现

主要入口是：

- `getProviders()`
- `getModels(provider)`
- `getModel(provider, modelId)`

对应实现可以看 [packages/ai/src/models.ts](../../packages/ai/src/models.ts)。

这层解决的是：

“上层不要拿裸字符串乱拼模型名，而是拿一个带完整元数据的 `Model` 对象。”

### 10.2 统一的消息和上下文类型

核心类型在 [packages/ai/src/types.ts](../../packages/ai/src/types.ts)：

- `Context`
- `Message`
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`
- `Tool`
- `ToolCall`
- `Usage`

上层通过这些类型组织输入和输出，而不用直接面对各家 SDK 的原生类型。

### 10.3 统一调用入口

对大多数上层调用者来说，最重要的是这四个函数，定义在 [packages/ai/src/stream.ts](../../packages/ai/src/stream.ts)：

- `stream`
- `complete`
- `streamSimple`
- `completeSimple`

它们是整个包最核心的“模型调用接口”。

### 10.4 provider-specific 子路径导出

在 [packages/ai/package.json](../../packages/ai/package.json) 里还能看到 provider-specific export，比如：

- `@mariozechner/pi-ai/openai-completions`
- `@mariozechner/pi-ai/anthropic`
- `@mariozechner/pi-ai/google`

这说明这个包既支持：

- 从根入口走统一接口

也支持：

- 在必要时使用 provider-specific 类型或实现

### 10.5 OAuth 和环境变量鉴权辅助

这个包还暴露了：

- OAuth 相关能力
- 环境变量取 key 的能力

这部分也是模型接入层的一部分，因为“怎么鉴权”本来就是 provider 差异的一部分。

## 11. `stream`、`complete`、`streamSimple`、`completeSimple` 到底有什么区别

这是很容易被混淆的一组接口。

### `stream`

`stream(model, context, options?)`

它返回的是统一事件流，适合这种场景：

- 你要边生成边显示
- 你要实时消费文本增量
- 你要观察 thinking、tool call、done、error 这些事件

也就是说，它更像“低层但更完整的实时接口”。

### `complete`

`complete(model, context, options?)`

它的语义可以简单理解成：

“我不关心中间发生了什么，只想拿最终完整结果。”

在实现上，它本质上就是：

- 先调用 `stream()`
- 再等待 `result()`

所以它不是另一套完全独立的能力，而是对 `stream()` 的方便封装。

### `streamSimple`

`streamSimple(model, context, options?)`

它仍然是事件流，但会把一些跨 provider 的常见选项进一步收口，尤其是 `reasoning` 这种统一体验层参数。

它存在的原因是：

不同 provider 对 thinking / reasoning 的参数表达不同，而上层经常只想说一句：

“我要 low / medium / high 级别的 reasoning。”

于是 `streamSimple()` 提供的是：

- 仍然保留流式能力
- 但把常见跨 provider 差异进一步隐藏

### `completeSimple`

`completeSimple(model, context, options?)`

它就是“simple 参数版本的最终结果接口”。

可以把这四个函数记成一个二维表：

| 接口 | 是否流式 | 参数层级 |
|---|---|---|
| `stream` | 是 | 更原始、更完整 |
| `complete` | 否，返回最终结果 | 更原始、更完整 |
| `streamSimple` | 是 | 更统一、更偏跨 provider 体验 |
| `completeSimple` | 否，返回最终结果 | 更统一、更偏跨 provider 体验 |

很多初学者会把 `streamSimple` 理解成“功能更少的 stream”。不完全对。

更准确地说，它是：

“在调用方式上更简单，但在运行时仍然会走统一事件流的接口。”

## 12. 代码里是怎样把这些抽象落下来的

到这里再看代码，就不会只剩下“背函数名”了。

### 12.1 模型注册表

看 [packages/ai/src/models.ts](../../packages/ai/src/models.ts)。

这层做的事情很直接：

- 把 `MODELS` 装进 `modelRegistry`
- 提供 `getModel()`、`getModels()`、`getProviders()`

所以它不是在“调模型”，而是在解决“如何描述和查找模型”。

### 12.2 API 注册表

看 [packages/ai/src/api-registry.ts](../../packages/ai/src/api-registry.ts)。

这里的核心是：

- `ApiProvider`
- `registerApiProvider()`
- `getApiProvider()`

这层解决的是：

“拿到一个 `model.api` 之后，应该由哪套 provider 实现来处理它？”

### 12.3 内建 provider 注册与懒加载

看 [packages/ai/src/providers/register-builtins.ts](../../packages/ai/src/providers/register-builtins.ts)。

这层做了两件重要的事：

1. 把内建 provider 注册到 API 注册表
2. 用懒加载方式加载真正的 provider 实现

为什么懒加载有意义？

因为上层系统未必每次都要把所有 provider 的实现和依赖一次性拉起来。

### 12.4 统一入口

看 [packages/ai/src/stream.ts](../../packages/ai/src/stream.ts)。

这就是对上层暴露的统一调用入口。

它做的事情其实很朴素：

1. 根据 `model.api` 找到对应 provider
2. 调用 provider 的 `stream` 或 `streamSimple`
3. 如果调用的是 `complete` 或 `completeSimple`，就等待最终结果

### 12.5 统一事件流对象

看 [packages/ai/src/utils/event-stream.ts](../../packages/ai/src/utils/event-stream.ts)。

这里有两个关键点：

- 事件流可以被 `for await` 消费
- 同时还能通过 `result()` 拿最终 `AssistantMessage`

这就是为什么 UI、runtime 和更高层产品可以共享同一套下层接口。

### 12.6 统一消息和事件协议

看 [packages/ai/src/types.ts](../../packages/ai/src/types.ts)。

这里定义了：

- 统一消息结构
- 统一 tool call 结构
- 统一 usage 结构
- 统一事件结构

这一步是整个包最核心的抽象边界之一。

因为一旦这一层不统一，上层所有东西都会被 provider 差异污染。

## 13. 两个具体例子：为什么“裸 provider 输出”不能直接给上层用

### 例子一：Anthropic 和 OpenAI-compatible 的流式格式根本不是一回事

在 [packages/ai/src/providers/anthropic.ts](../../packages/ai/src/providers/anthropic.ts) 里，provider 是在消费 Anthropic 的原生事件：

- `message_start`
- `content_block_start`
- `content_block_delta`
- `content_block_stop`
- `message_delta`

而在 [packages/ai/src/providers/openai-completions.ts](../../packages/ai/src/providers/openai-completions.ts) 里，provider 解析的是另一种结构：

- `choice.delta.content`
- `choice.delta.tool_calls`
- `finish_reason`

对上层来说，最想要的不是记住两套不同格式，而是统一后的事件：

- `text_delta`
- `thinking_delta`
- `toolcall_delta`
- `done`
- `error`

这就是 `packages/ai` 存在的直接价值。

### 例子二：tool call 和 thinking 的兼容不是白送的

在 [packages/ai/src/providers/transform-messages.ts](../../packages/ai/src/providers/transform-messages.ts) 里，你会看到它专门处理一些上层本来不该关心、但如果没人处理系统就会出问题的事情：

- tool call id 归一化
- cross-provider thinking 转换
- orphaned tool call 自动补 tool result

这些逻辑都在说明一件事：

“工具调用”和“thinking”不是抽象层面看上去统一，就真的天然统一。

需要有人把差异吸收掉。

## 14. 上层到底从 `packages/ai` 得到了什么

### 对 `packages/agent` 来说

它得到的是一个更稳定的 LLM 接口层。

所以它可以把主要精力放在：

- agent loop
- 工具执行
- 状态管理
- steering / follow-up

而不是一遍遍重写 provider 差异适配。

### 对 `packages/coding-agent` 来说

它得到的是一个可切换 provider 和 model 的底层能力。

这样产品层就可以重点做：

- session
- compaction
- TUI
- skills
- extensions
- 用户体验

### 对 UI 层来说

不管是终端还是 Web，它们最想消费的都是统一事件流，而不是每家 provider 一套事件语义。

这也是为什么 `AssistantMessageEvent` 这种统一事件模型非常重要。

## 15. 这一章最容易出现的误解

### 误解一：LLM 很强，所以直接调 SDK 就够了

不对。SDK 能调用成功，不等于它适合成为稳定系统边界。

### 误解二：`provider` 和 `api` 只是两个名字

不对。一个是服务来源，一个是交互协议，不分开建模后面会很难解释系统结构。

### 误解三：`complete` 和 `stream` 只是“一个同步一个异步”

不对。真正的区别是你是否要消费中间事件，以及你是在依赖“最终消息”还是“完整事件流”。

### 误解四：`packages/ai` 已经是 agent

不对。它解决的是“统一模型接口”，不是“完成 agent 循环”。

## 16. 本章小结

这一章你至少要带走六个结论：

1. `LLM` 本质上是生成器，不是完整系统。
2. `provider` 是服务来源，`api` 是交互协议，它们不是一回事。
3. 不同 provider 在消息、流式事件、tool calling、thinking、usage 上都可能不同。
4. `packages/ai` 的存在，是为了把这些差异压在更低的一层。
5. `packages/ai` 的上层是 `packages/agent` 和更高的产品层，而不是直接用户界面逻辑。
6. `stream` / `complete` / `streamSimple` / `completeSimple` 是同一能力面向不同调用方式和抽象层级的入口。

## 17. 建议你现在就做的阅读顺序

如果你想把这一章对应回代码，不要乱跳，建议按这个顺序读：

1. [packages/ai/README.md](../../packages/ai/README.md)
2. [packages/ai/package.json](../../packages/ai/package.json)
3. [packages/ai/src/types.ts](../../packages/ai/src/types.ts)
4. [packages/ai/src/models.ts](../../packages/ai/src/models.ts)
5. [packages/ai/src/api-registry.ts](../../packages/ai/src/api-registry.ts)
6. [packages/ai/src/stream.ts](../../packages/ai/src/stream.ts)
7. [packages/ai/src/utils/event-stream.ts](../../packages/ai/src/utils/event-stream.ts)
8. [packages/ai/src/providers/openai-completions.ts](../../packages/ai/src/providers/openai-completions.ts)
9. [packages/ai/src/providers/anthropic.ts](../../packages/ai/src/providers/anthropic.ts)
10. [packages/agent/README.md](../../packages/agent/README.md)

这个顺序背后的逻辑是：

- 先看这层想提供什么
- 再看它暴露什么接口
- 再看它内部怎样实现
- 最后再看上层如何消费它

## 18. 小练习

先不要写代码，先回答下面五个问题：

1. 为什么 `provider` 和 `api` 不能混成一个概念？
2. 为什么上层系统不能直接依赖原始 provider SDK 的消息和事件格式？
3. `packages/ai` 向上层承诺的“稳定性”主要体现在哪些接口上？
4. `stream` 和 `complete` 的差异，本质上是什么？
5. `packages/ai` 为什么还不算 agent？

如果你能用自己的话答清楚这五个问题，第 1 章就真正吃进去了。

## 19. 下一章预告

下一章进入：

`什么是 Agent`

到那时，我们会把这一章里还比较抽象的边界继续往前推进一步：

为什么“统一模型接口”仍然不够，还需要一个真正的 runtime 来负责：

`消息 -> 模型 -> 工具 -> 结果 -> 下一轮决策`

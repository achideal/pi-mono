# 第 1 章：什么是 LLM，什么不是

这一章的目标不是把你变成模型专家，而是先建立一个足够稳定的起点认知。

学完这一章，你应该能回答四个问题：

- LLM 到底是什么
- 它为什么看起来“像会思考”
- 它能做什么，不能做什么
- 为什么它本身还不能直接等于 agent

这一章对应这个仓库里的 [packages/ai](d:/Develop/pi-mono/packages/ai/README.md)。因为在这层里，项目主要解决的是“怎么和模型稳定沟通”，而不是“怎么把模型组织成一个会工作的 agent 系统”。

## 1. 先用一句话定义 LLM

LLM，`Large Language Model`，大语言模型。

如果先不管所有营销表述，可以把它理解成：

“一个根据已有上下文，持续预测下一个 token 的模型。”

这句话很朴素，但非常重要。因为它提醒你：

- LLM 的底层工作方式是“预测”
- 它输出的是 token 序列
- 它并不是先形成一个完整答案，再一次性吐出来

很多初学者一上来就把 LLM 想成“数字大脑”或者“会思考的人”。这样很容易在后面理解 agent 时踩坑。

## 2. 什么是 token

token 可以先粗略理解成“模型处理文本时使用的小片段”。

它不完全等于：

- 一个字
- 一个词
- 一个字符

它更像是模型内部的分词单位。比如：

- 一个英文单词可能是 1 个 token，也可能是多个
- 一个中文词组通常也会被拆成多个 token
- 标点、空格、换行也都可能占用 token

为什么这件事重要？

因为几乎所有 LLM 工程问题，最后都会和 token 相关：

- 你能塞进去多少上下文
- 调用一次要花多少钱
- 响应速度快不快
- 长对话为什么会“失忆”

所以以后你看到“上下文窗口 200k”“输入 5k tokens”“输出 1k tokens”，都不要把它当成抽象指标，它直接关系到 agent 能不能稳定工作。

## 3. 什么叫“根据上下文预测下一个 token”

假设模型当前看到的是：

`中国的首都是`

它会根据训练中学到的大量语言分布，预测下一个 token 最可能是什么。高概率候选也许是：

- `北京`
- 其他低概率错误项

当它输出了 `北京`，上下文就变成：

`中国的首都是北京`

然后它继续预测下一个 token。就这样一步一步往后生成。

所以模型输出长答案时，本质上是在不停做这件事：

1. 看当前上下文
2. 预测下一个 token 的概率分布
3. 按一定策略选一个 token
4. 把它接到上下文后面
5. 继续循环

这也是为什么流式输出成立。因为模型本来就是逐步生成，而不是一次算完整段文本。

## 4. 为什么它看起来像“理解了”问题

因为现代 LLM 在海量数据上训练后，已经学会了非常复杂的统计模式。

这些模式不仅包括：

- 语法
- 常识
- 文档结构
- 代码结构

还包括很多更高层的行为模式，比如：

- 总结
- 改写
- 解释
- 分类
- 按格式输出
- 模拟规划步骤

所以它经常会表现得像“理解了你的意图”。

这里最重要的认知是：

LLM 确实表现出很强的泛化能力，但你在工程上最好先把它当成“极强的模式压缩与生成系统”，而不是默认它像人类一样真正理解一切。

这样你会更自然地接受这些事实：

- 它会胡说八道
- 它会在局部看起来很聪明，但整体决策不稳
- 它非常依赖输入上下文的组织方式
- 它在没有工具时，无法直接接触真实世界

## 5. Prompt 是什么，为什么它这么重要

`prompt` 可以简单理解成“你喂给模型的输入”。

但在工程里，prompt 往往不只是用户那一句话。它通常包括：

- system prompt
- 用户消息
- 历史对话
- 工具定义
- 工具结果
- 补充的文件内容
- 运行时注入的规则

也就是说，模型的表现不是由“那一句提问”单独决定的，而是由整包上下文共同决定的。

这也是为什么同一个模型，在不同 agent 系统里表现差别会很大。差别往往不只是模型本身，而是上下文构造方式不同。

## 6. 什么是上下文窗口

上下文窗口，`context window`，可以理解成模型当前一次最多能“看到”的 token 数量上限。

它包含输入和输出的总预算。

这意味着：

- 历史对话越长，留给当前回答的空间越少
- 工具结果越长，越容易把上下文撑满
- 附件、代码、日志一多，就必须做裁剪或压缩

这也是 agent 里会频繁出现这些设计动作的原因：

- 截断历史
- 总结历史
- 只保留最近几轮
- 按需读取文件，而不是一口气读全仓库

你之后看到 `packages/coding-agent` 里的 session、tree、compaction 设计时，背后都和这个限制强相关。

## 7. 什么是采样，为什么同一问题答案会不一样

模型并不是每次都机械地选“概率最高的那个 token”。

实际生成时，通常会引入采样策略，比如温度、top-p 一类参数。你现在不用深入记公式，只要记住一件事：

“模型输出不是完全固定的，而是在概率分布上做选择。”

这会带来两个直接后果：

- 同一个问题，多次调用可能答案不同
- 在复杂任务里，模型决策会有波动

这也是为什么 agent 工程不能只看“某次它跑通了没有”，而要关注：

- 稳定性
- 重试策略
- 参数校验
- 错误恢复

## 8. LLM 擅长什么

先从工程角度看，LLM 普遍擅长：

- 理解自然语言指令
- 生成结构化或半结构化文本
- 总结、改写、翻译、解释
- 在足够上下文下理解代码和文档
- 根据 schema 输出相对规范的数据
- 在工具约束下做“下一步动作建议”

在 coding agent 场景下，它尤其擅长：

- 从自然语言需求推断应该读哪些文件
- 根据已有代码风格生成补丁
- 总结报错、日志、diff
- 在多轮交互里逐步收敛问题

## 9. LLM 不擅长什么

同样重要的是，它不擅长或者说不能可靠保证的部分：

- 长链条任务中的全局一致性
- 精确记忆很长历史
- 永远正确地做数学和逻辑推导
- 自动知道外部世界的最新状态
- 在没有工具时读取文件、联网、执行命令
- 自动遵守你没明确约束的安全边界

所以当你发现模型“明明挺聪明，为什么还是会犯傻”，不要惊讶。它本来就不是一个自带外部感知、计划执行和状态控制的完整系统。

## 10. 为什么 LLM 不等于 Agent

这是这一章最重要的结论。

LLM 只解决了其中一部分问题：生成。

而一个能工作的 agent，至少还需要：

- 输入输出协议
- 工具调用机制
- 工具执行器
- 对话状态管理
- 错误处理
- 中断和恢复机制
- 成本与上下文控制
- 有时还需要 UI、权限控制和持久化

所以你可以这么理解：

- `LLM` 是推理核心
- `Agent` 是围绕这个核心搭起来的可运行系统

在这个仓库里：

- `packages/ai` 更接近“模型接口层”
- `packages/agent` 更接近“agent runtime 层”
- `packages/coding-agent` 更接近“真实产品层”

## 11. 用这个仓库看第 1 章，应该看什么

如果你想把这一章和仓库对应起来，最值得看的不是所有 provider 文件，而是先抓住这几条主线：

- 模型元数据如何统一
- 消息协议如何统一
- 调用入口如何统一
- 不同厂商的流式响应如何被归一化成统一事件

下面我们直接按你现在最关心的四个问题来看。

### 11.1 它如何统一不同 provider

这套统一不是靠一个巨大的 `if/else` 完成的，而是靠“模型元数据 + API 注册表 + 统一流式函数签名”完成的。

先看 [packages/ai/src/types.ts](d:/Develop/pi-mono/packages/ai/src/types.ts)：

- `KnownApi` 定义了底层 API 协议层，比如 `openai-completions`、`anthropic-messages`、`google-generative-ai`
- `KnownProvider` 定义了厂商或服务名，比如 `openai`、`anthropic`、`groq`、`openrouter`
- `Model<TApi>` 同时带着 `api`、`provider`、`baseUrl`、`reasoning`、`input`、`cost`、`contextWindow` 这些元数据

这说明在这个项目里：

- `provider` 更像“你从哪家服务拿模型”
- `api` 更像“这家服务说的是哪种协议”

这两个概念分开，非常关键。

再看 [packages/ai/src/models.ts](d:/Develop/pi-mono/packages/ai/src/models.ts)：

- 它把生成好的 `MODELS` 表加载进 `modelRegistry`
- `getModel(provider, modelId)` 会返回一个带完整元数据的 `Model`

也就是说，上层拿到的不是一个裸字符串模型名，而是一个完整的模型描述对象。

然后看 [packages/ai/src/api-registry.ts](d:/Develop/pi-mono/packages/ai/src/api-registry.ts)：

- `ApiProvider` 规定每个底层 API 都要提供 `stream` 和 `streamSimple`
- `registerApiProvider()` 把 provider 注册到一个以 `api` 为 key 的注册表里
- `wrapStream()` / `wrapStreamSimple()` 会先检查 `model.api` 是否和 provider 匹配

这一步把“不同实现”收口成了统一接口。

最后看 [packages/ai/src/providers/register-builtins.ts](d:/Develop/pi-mono/packages/ai/src/providers/register-builtins.ts)：

- `registerBuiltInApiProviders()` 把 Anthropic、OpenAI、Google、Mistral、Bedrock 等 provider 都注册进来
- 它不是一启动就把所有 provider 全量静态加载，而是通过 `createLazyStream()` / `createLazySimpleStream()` 做懒加载
- 比如 `streamOpenAICompletions = createLazyStream(loadOpenAICompletionsProviderModule)`

这背后的设计很值得你记住：

1. `getModel()` 负责拿到“这个模型属于哪个 provider、说哪种 api”
2. `stream()` 只看 `model.api`
3. 注册表再把 `model.api` 分发给真正的 provider 实现

所以统一层真正统一的不是“所有厂商长得一样”，而是：

“不管底层多不一样，对上层都暴露同一种调用协议。”

### 11.2 它如何定义消息格式

这个问题的核心答案在 [packages/ai/src/types.ts](d:/Develop/pi-mono/packages/ai/src/types.ts)。

这个库没有直接把各家 SDK 的消息格式往上传，而是自己定义了一套统一消息模型。

最重要的几个类型是：

- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`
- `Context`
- `ToolCall`
- `Usage`

其中：

- `UserMessage` 的 `role` 是 `"user"`
- `AssistantMessage` 的 `role` 是 `"assistant"`
- `ToolResultMessage` 的 `role` 是 `"toolResult"`

而 `Context` 则把一次模型调用真正需要的输入组织起来：

- `systemPrompt`
- `messages`
- `tools`

这意味着，这个项目在“消息协议”上做了两个重要决定：

1. 对外统一只认自己的消息模型
2. 各 provider 自己负责把统一消息模型转成厂商 API 需要的格式

其中 `AssistantMessage.content` 很关键，它不是单纯字符串，而是一个内容块数组，块的类型可能是：

- `TextContent`
- `ThinkingContent`
- `ToolCall`

这相当于告诉你：

“在这个项目里，assistant 响应从一开始就被设计成多模态、多阶段、可流式拼接的结构，而不是一个普通文本框。”

再看 [packages/ai/src/providers/transform-messages.ts](d:/Develop/pi-mono/packages/ai/src/providers/transform-messages.ts)，你会发现消息统一不只是“定义类型”这么简单，它还负责：

- 跨 provider 转换 thinking block
- 归一化 tool call id
- 给孤立的 tool call 自动补 synthetic tool result
- 跳过 error / aborted 的 assistant message，避免重放时污染上下文

也就是说，这个库定义的不是“理想消息格式”，而是“能在多 provider 之间实际重放和流转的消息格式”。

### 11.3 它如何暴露 `stream`、`complete` 这类调用方式

这个问题看 [packages/ai/src/stream.ts](d:/Develop/pi-mono/packages/ai/src/stream.ts) 就很清楚了。

这个文件对外暴露四个最核心的入口：

- `stream(model, context, options?)`
- `complete(model, context, options?)`
- `streamSimple(model, context, options?)`
- `completeSimple(model, context, options?)`

它们的关系非常直接：

- `stream()` 根据 `model.api` 找到对应 provider，然后返回 `AssistantMessageEventStream`
- `complete()` 本质上就是先调用 `stream()`，再 `await s.result()`
- `streamSimple()` 和 `completeSimple()` 是更偏统一体验的简化入口，会把 reasoning 之类的选项进一步收口

也就是说：

- `stream` 面向“你想拿完整事件流”
- `complete` 面向“你只想拿最终消息”

再看 [packages/ai/src/utils/event-stream.ts](d:/Develop/pi-mono/packages/ai/src/utils/event-stream.ts)：

- `EventStream<T, R>` 实现了 `AsyncIterable<T>`
- 你可以 `for await` 它拿到每个事件
- 也可以调用 `result()` 一次性拿到最终结果

`AssistantMessageEventStream` 只是把这个通用事件流专门化成：

- 事件类型是 `AssistantMessageEvent`
- 最终结果类型是 `AssistantMessage`

这套设计很适合 agent 场景，因为上层 UI 或 runtime 可以同时拥有两种能力：

- 边消费事件边渲染
- 在结束后拿到一个完整的最终消息对象

README 里的最小调用例子：

```ts
import { getModel, complete } from "@mariozechner/pi-ai";

const model = getModel("openai", "gpt-4o-mini");
const response = await complete(model, {
  messages: [{ role: "user", content: "Hello" }],
});
```

从源码角度看，它真正走的是这条链路：

`getModel() -> stream()/complete() -> resolveApiProvider(model.api) -> 具体 provider 实现`

### 11.4 它如何描述 tool calling、thinking、error、usage 这些事件

这个问题要分两层看。

第一层是“公共事件协议是什么”，看 [packages/ai/src/types.ts](d:/Develop/pi-mono/packages/ai/src/types.ts)。

`AssistantMessageEvent` 这个联合类型定义了统一事件协议，主要包括：

- `start`
- `text_start` / `text_delta` / `text_end`
- `thinking_start` / `thinking_delta` / `thinking_end`
- `toolcall_start` / `toolcall_delta` / `toolcall_end`
- `done`
- `error`

这说明对上层来说，不管你底层是 OpenAI 还是 Anthropic，都应该被看成同一种事件流。

第二层是“不同 provider 怎么把自己的原生流映射成这些统一事件”。

#### 先看 Anthropic provider

看 [packages/ai/src/providers/anthropic.ts](d:/Develop/pi-mono/packages/ai/src/providers/anthropic.ts)：

- `streamAnthropic` 是 Anthropic 的统一入口
- 它先构造一个统一的 `output: AssistantMessage`
- 然后监听 Anthropic SDK 的原生事件，比如 `message_start`、`content_block_start`、`content_block_delta`、`content_block_stop`、`message_delta`

在这个过程中，它把厂商事件映射成统一事件：

- 文本增量映射成 `text_delta`
- thinking 增量映射成 `thinking_delta`
- tool 的 JSON 增量映射成 `toolcall_delta`
- stop reason 映射成统一的 `stopReason`
- usage 被累计到统一的 `Usage` 结构里

所以你可以把 provider 文件理解成“协议翻译器”。

#### 再看 OpenAI-compatible provider

看 [packages/ai/src/providers/openai-completions.ts](d:/Develop/pi-mono/packages/ai/src/providers/openai-completions.ts)：

- `streamOpenAICompletions` 是 OpenAI-compatible chat completions 的统一入口
- 它读取 `choice.delta.content`
- 也兼容一些 provider 在 `reasoning_content`、`reasoning`、`reasoning_text` 里放 thinking
- 遇到 `tool_calls` 时把增量参数拼接成统一 `ToolCall`
- 用 `finish_reason` 映射统一 `StopReason`

这里很重要的一点是：

这个 provider 文件并不是只为 OpenAI 官方服务，它还承担了很多“OpenAI-compatible API 适配层”的工作。比如：

- `getCompat()` 会根据 `provider` 或 `baseUrl` 推断兼容行为
- `convertMessages()` 会按兼容策略决定 developer/system role、thinking 格式、tool result 格式
- `convertTools()` 会把统一 `Tool` 转成 OpenAI 风格 function tools

这也解释了为什么这个仓库把 `provider` 和 `api` 分开建模。因为很多不同 provider，最后其实都走同一套 `openai-completions` 协议壳。

### 11.5 `usage` 为什么也要统一

初学者容易把 `usage` 当成附带信息，但在 agent 工程里它非常重要。

从 [packages/ai/src/types.ts](d:/Develop/pi-mono/packages/ai/src/types.ts) 可以看到，统一 `Usage` 至少包括：

- `input`
- `output`
- `cacheRead`
- `cacheWrite`
- `totalTokens`
- `cost`

然后 [packages/ai/src/models.ts](d:/Develop/pi-mono/packages/ai/src/models.ts) 里的 `calculateCost()` 会根据模型自己的价格元数据，把 token usage 转成成本。

也就是说，这个项目不是把 usage 当日志看，而是把它当 runtime 的一等信息：

- 上层可以直接统计成本
- 可以比较 provider 行为
- 可以做 session 级别的 token / cost 展示

### 11.6 你现在可以怎么读这部分源码

如果你想真的把这部分读进去，我建议用下面顺序：

1. 先看 `types.ts`
2. 再看 `models.ts`
3. 然后看 `api-registry.ts`
4. 接着看 `stream.ts`
5. 再看 `utils/event-stream.ts`
6. 最后选一个 provider，看 `anthropic.ts` 或 `openai-completions.ts`

按这个顺序读，你会更容易建立一个稳定心智模型：

- 先知道系统里“对象长什么样”
- 再知道“这些对象怎么被查到”
- 再知道“入口函数怎么分发”
- 最后再看“厂商差异如何被吃掉”

## 12. 这一章最容易出现的误解

### 误解一：LLM 懂了，所以 agent 就不难了

不对。模型会生成，不代表系统会稳定运行。

### 误解二：prompt 写得好，工具和状态就不重要

不对。真实 agent 的稳定性很大程度来自系统设计，不只是提示词。

### 误解三：模型回答得像人，就等于它像人一样在思考

不对。工程上不该把这种类比当成默认前提。

### 误解四：先学最复杂的多 agent，成长更快

通常不对。单 agent 闭环没吃透之前，多 agent 只会放大困惑。

## 13. 本章小结

这一章你只需要记住三句话：

1. LLM 本质上是“根据上下文预测下一个 token 的模型”。
2. 它很强，但它本身只负责生成，不天然具备工具、状态和执行能力。
3. agent 是建立在 LLM 之上的系统，而不是 LLM 的别名。

## 14. 建议你马上做的一个小练习

不要急着写 agent。先做一个最小观察实验：

1. 阅读 [packages/ai/README.md](d:/Develop/pi-mono/packages/ai/README.md) 里的 Quick Start
2. 只关注 `getModel`、`complete`、`stream` 三个入口
3. 用你自己的话写下这三个问题的答案：

- “模型输入”在这个库里是怎样表示的？
- “模型输出”是一次性结果，还是事件流？
- 到这一步为止，为什么它还不算 agent？

如果你能清楚回答这三个问题，第 1 章就算真正学进去了。

## 15. 下一章预告

下一章就进入：

`什么是 Agent`

到那时我们会把这一章里还比较抽象的概念，落到一个最小闭环上：

`用户消息 -> 模型响应 -> 工具调用 -> 工具结果 -> 再次响应`

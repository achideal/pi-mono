# 补充：从使用者视角理解 Agent Loop

这份补充文档服务于第 2 章，第 2 章先帮你建立一个大轮廓：agent 不是单次聊天，而是“模型 + 循环 + 工具 + 状态”的组合。这里则专门回答一个更贴近 `pi` 使用体验的问题：当你在终端里看着 agent 工作时，代码里的 inner loop、outer loop、steering 和 follow-up，分别对应你眼前的哪一段交互。

如果你已经理解了第 2 章的主线，这篇补充文档会帮你把“抽象控制流”对上“真实操作手感”。下一章会继续往下走，把这个循环拆成最小可运行的闭环。

## 先说结论

对 `pi` 使用者来说，可以先把这几个概念记成下面这样：

- **inner loop**：`pi` 正在处理你“当前这件事”的那段连续忙碌时间
- **outer loop**：在当前事情本来要结束时，检查有没有提前排好的下一条 follow-up
- **steering message**：当前 run 还没结束，但在下一次 LLM 调用前插进去的消息
- **follow-up message**：等当前 run 本来要停下时，再自动接上的下一条消息

这四个概念都落在 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:164) 和 [`packages/agent/src/types.ts`](/d:/Develop/pi-mono/packages/agent/src/types.ts:160) 里。`packages/agent` 负责运行时语义，`packages/coding-agent` 再把这些语义映射成 `pi` 里能看见、能按的交互方式。

## 1. Inner Loop 对应用户看见的哪一段

如果你在 `pi` 里输入一句：

> 帮我排查为什么项目启动失败

你通常会看到这样的过程：

1. assistant 先输出一小段分析
2. 然后出现 `read`、`bash`、`search` 之类工具调用
3. 工具跑完后 assistant 继续解释
4. 如果还要更多信息，再来一轮工具调用
5. 最后 assistant 给出结论或修改结果

从使用者视角看，这整段“还在忙、还没真正收工”的连续过程，基本就是 **inner loop**。

代码里对应的是这段结构：

```typescript
while (hasMoreToolCalls || pendingMessages.length > 0) {
  // 注入待处理消息
  // 调用模型
  // 执行工具
  // 把工具结果加回上下文
  // 再检查 steering messages
}
```

可以看 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:171)。

这里有两个容易混淆的点：

- inner loop 不是“整场会话”
- inner loop 也不是“只调用一次模型”

它更像是：**围绕当前任务不断重复的“推理 -> 动作 -> 观察 -> 再推理”主循环**。

## 2. 一个 turn 和一个 inner loop 不是同一个东西

在 runtime 里，`turn` 的定义是：

> 一次 assistant 响应，加上这次响应引出的 tool calls 和 tool results

这个定义在 [`packages/agent/src/types.ts`](/d:/Develop/pi-mono/packages/agent/src/types.ts:330)。

所以：

- **一个 turn** 是 inner loop 里的一次完整往返
- **一个 inner loop** 可以包含多个 turn

比如 assistant 先发一个带 `toolCall` 的消息，工具执行完后，模型又基于工具结果再生成一条消息。如果第二条消息里又带了工具调用，那就又形成一个新的 turn。只要还没彻底停下来，就还在同一个 inner loop 里。

## 3. Steering 和 Follow-up 是什么，不是什么

先说“是什么”。

`packages/agent` 对它们的定义非常直接：

- `getSteeringMessages()`：在当前 run 中途注入的新消息，发生在“当前 assistant turn 的工具执行完之后、下一次 LLM 调用之前”  
  见 [`types.ts`](/d:/Develop/pi-mono/packages/agent/src/types.ts:160)
- `getFollowUpMessages()`：只有当 agent 本来要停下时，才继续处理的后续消息  
  见 [`types.ts`](/d:/Develop/pi-mono/packages/agent/src/types.ts:173)

再说“不是”。

它们**不是 system prompt**。system prompt 走的是单独的 `systemPrompt` 字段，不走消息队列那套机制，状态入口在 [`packages/agent/src/agent.ts`](/d:/Develop/pi-mono/packages/agent/src/agent.ts:399)。

它们最终会被当成普通消息注入上下文：

```typescript
for (const message of pendingMessages) {
  currentContext.messages.push(message);
  newMessages.push(message);
}
```

见 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:179)。

所以更准确地说，steering 和 follow-up 是：

- **排队中的消息**
- **通常来自用户运行中追加的输入**
- **最终以普通消息的身份进入会话历史**

在 `pi` 这个产品里，它们最常见的来源确实是用户输入；但在更底层的 SDK/RPC/扩展接口里，也可以由应用代码或扩展排进去。这一点可以从 [`packages/agent/src/agent.ts`](/d:/Develop/pi-mono/packages/agent/src/agent.ts:248) 和 [`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1246) 看出来。

## 4. 在 pi 里，Enter 和 Alt+Enter 分别做了什么

在 `pi` 的交互层里：

- **流式运行时按 Enter**：走 steering
- **流式运行时按 Alt+Enter**：走 follow-up

对应代码分别在：

- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2270)
- [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:2929)

`AgentSession` 会把它们包装成 `role: "user"` 的消息，再交给 `agent.steer()` 或 `agent.followUp()`，对应在：

- [`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1131)
- [`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1152)

UI 里这些待处理消息也不是隐藏的。`pi` 会把它们显示成待处理项：

- `Steering: ...`
- `Follow-up: ...`

渲染代码在 [`packages/coding-agent/src/modes/interactive/interactive-mode.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/modes/interactive/interactive-mode.ts:3170)。

## 5. Outer Loop 到底在做什么

outer loop 的工作其实很窄：

1. 先等 inner loop 跑完
2. 然后检查有没有 follow-up
3. 有就继续，没有就结束

对应代码是：

```typescript
const followUpMessages = (await config.getFollowUpMessages?.()) || [];
if (followUpMessages.length > 0) {
  pendingMessages = followUpMessages;
  continue;
}

break;
```

见 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:219)。

所以如果你问：

> 从我输入一条消息到 `pi` 完全做完，这整段是不是都在 inner loop 里？

更准确的回答是：

- **没有 follow-up 时，基本可以这么理解**
- **有 follow-up 时，原任务的主过程在 inner loop 里，outer loop 只负责在收尾时接住下一条 follow-up，再开下一轮 inner loop**

这也是为什么 outer loop 更像一个附加包装层，而 inner loop 才是 agent 真正干活的主循环。

## 6. 程序会不会走到那个 break

会，而且**正常完成任务时就应该走到那里**。

当代码走到 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:228) 这个 `break` 时，说明：

- 当前 inner loop 已经结束
- 没有更多工具调用
- 没有新的 steering
- follow-up 队列也为空

也就是说：**这次 run 真的收工了**。

只有两类情况不会走到这个 `break`：

- 中途报错或被中断，直接 `return`  
  见 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:194)
- 发现还有 follow-up，于是 `continue` 回 outer loop  
  见 [`packages/agent/src/agent-loop.ts`](/d:/Develop/pi-mono/packages/agent/src/agent-loop.ts:221)

## 7. Follow-up 和“等它结束后再问”是不是一回事

对普通自然语言追问来说，**从模型最终看到的会话内容上，它们通常很接近**。

因为 queued follow-up 最终也会变成普通消息，被加进 `currentContext.messages`，然后再送进模型。默认转换器只保留 `user`、`assistant`、`toolResult` 这些标准消息给 LLM，见 [`packages/agent/src/agent.ts`](/d:/Develop/pi-mono/packages/agent/src/agent.ts:27)。

但从 runtime 角度看，两者仍然有差别：

### 7.1 Follow-up 是“自动续上”

它不是等当前 run 完全结束后，再由你手动新发一条消息；而是**提前挂号**，等 outer loop 检查到它时，直接在同一个会话上下文里继续跑下一轮。

所以我前面一直强调“**把 follow-up 当成新的用户消息，注入同一个会话上下文里，再继续 agent loop**”。这句话强调的不是“模型会看到特殊标签”，而是“runtime 如何继续执行”。

### 7.2 普通追问会重新走 prompt 入口

如果你等到 `pi` 空闲后再发一句普通追问，会重新进入 `prompt()` 的启动路径，见 [`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:920)。

这条路径会重新做一整套 run 级动作，比如：

- 模型与鉴权检查
- compaction 检查
- `before_agent_start` 扩展事件

相关代码在：

- [`agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:985)
- [`agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1009)
- [`agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1035)

queued follow-up 则不会重新走这条入口，而是走排队后的续跑逻辑，入口在 [`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1152)。

### 7.3 某些输入行为会不同

例如 queued follow-up 不允许扩展命令，而普通 prompt 会先尝试解析扩展命令：

- follow-up 限制：[`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:1158)
- prompt 入口解析扩展命令：[`packages/coding-agent/src/core/agent-session.ts`](/d:/Develop/pi-mono/packages/coding-agent/src/core/agent-session.ts:932)

所以：

- **普通文本追问**：两者很接近
- **运行时语义、扩展机制、启动路径**：两者并不完全相同

## 8. 什么时候该用 Alt+Enter，什么时候该等它结束

给使用者的最简单建议是：

- **已经知道下一句迟早要问**：用 `Alt+Enter`
- **想先看当前结果再决定下一句**：等它结束后再问

可以把两者理解成：

- `Alt+Enter`：先把下一项排队
- 普通追问：等上一项做完，再决定下一项

这和传统终端里的输入缓冲区有一点相似：当前命令忙着执行时，你可以提前把下一条输入准备好，等前一个任务收尾后再接着处理。只是这里缓存的不是“裸按键”，而是**会进入同一会话历史的用户消息**。

## 9. 一条完整时间线

下面这个例子，把几种行为放在一起看会更清楚。

你先输入：

> 帮我修复启动失败问题

然后 `pi` 开始：

1. assistant 先输出初步判断
2. 触发 `read`、`bash` 等工具
3. 你这时按 **Enter** 输入一句  
   > 先不要改代码，先确认根因
4. 这条消息会作为 **steering** 排队，等当前 assistant turn 的工具执行完后注入
5. assistant 再继续下一次 LLM 调用时，会把这条 steering 当成新的普通消息一起看到
6. 之后你又按 **Alt+Enter** 输入一句  
   > 做完后顺手更新 changelog
7. 这条消息会作为 **follow-up** 排队
8. 当前任务本来要收尾时，outer loop 检查到 follow-up，于是自动再开一轮
9. 如果此时没有新的 follow-up，最终走到 `break`，整次 run 结束

这个例子也说明了本章最重要的区分：

- steering 更像“当前工作流中的插话”
- follow-up 更像“当前工作流之后自动续上的下一项”

## 10. 读完这篇后你应该抓住什么

如果你现在只想留下一个稳定的心智模型，可以记住这四句话：

1. `pi` 真正干活的主循环是 inner loop。
2. outer loop 主要是为 follow-up 排队续跑服务的。
3. steering 和 follow-up 不是 system prompt，它们最终都会以消息形式进入会话上下文。
4. 对模型内容来说，follow-up 往往很像普通追问；真正的差别主要在 runtime 如何续跑。

带着这个理解去看第 3 章，你会更容易把“代码里的循环”和“终端里的使用体验”对上。

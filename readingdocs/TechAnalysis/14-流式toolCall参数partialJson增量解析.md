# 14 · 流式 tool 参数的 partial JSON 增量解析

> 位置：`packages/ai/src/utils/json-parse.ts`；`packages/ai/src/providers/openai-*`, `anthropic.ts` 等 Provider 在 `toolcall_delta` 路径上都会走它；README 的 "Streaming Tool Calls with Partial JSON" 章节
>
> 提炼点：**让"tool_call 参数一字一字流下来"的过程对 UI 消费端保持可用——每次收到一段 chunk 就尝试解析当前累积的不完整 JSON，把尽可能多的字段"提前亮出来"给 UI。**

---

## 1. 问题：tool_call 的参数是字符串流

各家 Provider 流式返回 tool_call 时，参数 JSON 是**一段一段拼出来的**：

```
chunk 1: {"pa
chunk 2: th": "/tm
chunk 3: p/foo", "con
chunk 4: tent": "hello"
chunk 5: }
```

标准 `JSON.parse` 遇到 chunk1、chunk2、chunk3 都会报错。对用户来说，在 `write_file` 跑之前，能看到 `path: "/tmp/foo"` 非常有用：

- 给"即将写到 /tmp/foo"的 UI 提示。
- 让 permission gate（第 7 篇）早点决定拒绝。
- 做分段的进度条（比如 bash 的 command 已经知道，但 stdin 还在流）。

所以 pi-ai 用 `partial-json` 库做容错解析，**在每个 `toolcall_delta` 事件里都尝试解析当前累积的字符串**，把尽可能多的字段给出来。

---

## 2. 实现：一个 12 行函数，三段防御

```ts
export function parseStreamingJson<T = any>(partialJson: string | undefined): T {
  if (!partialJson || partialJson.trim() === "") return {} as T;
  try { return JSON.parse(partialJson) as T; }
  catch {
    try { const result = partialParse(partialJson); return (result ?? {}) as T; }
    catch { return {} as T; }
  }
}
```

三道 fallback：

1. **空字符串 / undefined** → 返回 `{}`。
   - 许多 Provider 的首个 delta 是空的。让它不抛。
2. **标准 JSON.parse**：快。
   - 流结束或已经凑成合法 JSON 的那刻是最多命中这条的。省下 partial-json 的解析开销。
3. **`partial-json` 兜底**：慢但容错。
   - 它会把不完整的部分尽可能补成合法结构（`{"pa` → `{}`，`{"path": "/tmp"` → `{"path": "/tmp"}`）。
4. **还解不出来** → 返回 `{}`。
   - 永远不抛，消费方靠判空处理。

### 2.1 为什么不直接上 partial-json

看起来"都用 partial-json 不就行了"。但是：

- 标准 JSON.parse 是 V8 原生 + 极快。流结束时（完整 JSON）用它处理 0 开销。
- partial-json 是 JS 实现，每次都过一遍解析状态机，在 tool_call 多、chunk 多的 loop 里累积开销明显。

先试快的，再 fallback 到慢的，是对"大多数情况是完整"的统计优化。

### 2.2 返回永远是对象而非 undefined

```ts
return (result ?? {}) as T;
```

README 里特别强调了一条契约：**`arguments` 在 `toolcall_delta` 事件里最差也是 `{}`，绝不 undefined**。

理由：

- 消费方可以安心写 `partial.content[i].arguments.path`，最坏是 undefined（空对象的字段访问）。
- 不用每次都加 `if (!args) return;` 防御。
- 类型签名里 arguments 是 `Record<string, any>` 而非 `Record<string, any> | undefined`，显著减少 `?.` 噪声。

返回类型稳定 → 消费端代码整洁。这是这个小函数最大的贡献。

---

## 3. 在事件流里的时序

每家 Provider 的 delta 累积模式大致是：

```
toolcall_start
└─ 新建一个 { type: "toolCall", id, name, arguments: {} } 塞进 partial.content
toolcall_delta (chunk 1)
└─ jsonBuffer += chunk1
└─ partial.content[idx].arguments = parseStreamingJson(jsonBuffer)  // {}
toolcall_delta (chunk 2)
└─ jsonBuffer += chunk2
└─ partial.content[idx].arguments = parseStreamingJson(jsonBuffer)  // { path: "/tmp" }
...
toolcall_end
└─ 最终的 arguments 一定是完整解析后的对象
```

注意：**每次 delta 都重新解析全量累积字符串，不做增量 diff 解析**。这是一个有意识的 trade-off：

- **简单**：不需要维护"上次解析到哪、lookahead 了哪些字符"这类状态机。
- **正确**：`{"a":1,"b":` 解不出来、`{"a":1,"b":{` 解得出，**每次从头解**保证了解析结果永远反映的是当前完整 buffer 的最好解释。
- **代价可接受**：tool_call 参数通常几百字节，每 delta 重解一次在 CPU 里不到 1ms。

---

## 4. 消费方怎么用（README 给的样板）

```ts
for await (const event of s) {
  if (event.type === "toolcall_delta") {
    const toolCall = event.partial.content[event.contentIndex];
    if (toolCall.type === "toolCall" && toolCall.arguments) {
      if (toolCall.name === "write_file" && toolCall.arguments.path) {
        console.log(`Writing to: ${toolCall.arguments.path}`);
        if (toolCall.arguments.content) {
          console.log(`Content preview: ${toolCall.arguments.content.substring(0, 100)}...`);
        }
      }
    }
  }
}
```

几个**必须写进业务代码的防御姿势**（README 做了强调）：

1. **字段可能未出现**：`toolCall.arguments.path` 可能是 undefined。不要假设一定存在。
2. **字符串可能截断**：`arguments.content` 可能是半截字符串（"hello world 怎么样" → "hello world 怎"）。
3. **数组可能不完整**：`arguments.tags` 可能是 `["a", "b"` 被解成 `["a", "b"]`（partial-json 会补右括号）。但最后一项可能根本没到。
4. **嵌套对象可能部分**：`arguments.config.theme` 可能还没开始流。

这些约束都源于"partial JSON 的状态"：partial-json 尽力给你最合理的解释，但"合理"不等于"完整"。**用户代码要能吃**。

---

## 5. Google 的特殊情况

README 说：

> The Google provider does not support function call streaming. Instead, you will receive a single `toolcall_delta` event with the full arguments.

这意味着 pi-ai 对所有 Provider 统一：**即使底层协议不流式，也发一次 toolcall_delta**。消费方的代码完全不用变。

这是协议一致性的又一个小胜利：upstream 不支持流式 → SDK 合成一次 delta 事件 → 消费方无需特化。

---

## 6. 和 `validateToolArguments` 的明确分工

- `parseStreamingJson`：流期间实时解析不完整 JSON，**容错，不校验**。
- `validateToolArguments`（第 8 篇）：最终完整 JSON 到手后，**校验**参数是否符合 TypeBox schema。

两者分工：

| 阶段 | 函数 | 期望 |
| --- | --- | --- |
| toolcall_delta | parseStreamingJson | 尽可能多解 |
| toolcall_end | （协议已完整） | 转给验证 |
| 执行前 | validateToolArguments | 严格校验 + 类型收窄 |

这种"**流期间宽松、执行前严格**"的双阶段保证：UI 能早早看到字段，tool.execute 却从不拿到非法参数。

---

## 7. 可以带走的套路

1. **"最常见情况快路径 + 罕见情况兜底 + 永远有合法返回值"** 的三段式：既优化性能又不暴露错误。
2. **返回类型稳定到消费方可省略 null check**：对流式 API 尤其重要。
3. **stateless 累积 + 全量重解析**：简单、正确、代价可控。
4. **约束文档化**：README 明确告诉消费方"字段可能不存在 / 截断 / 数组不完整"。让使用者建立正确心智模型。
5. **协议差异在 SDK 侧抹平**：Google 不流式？那就合成一次 delta。
6. **流期宽松 + 执行前严格**：用两个函数各司其职，别试图一个函数两件事。

你做的任何"服务器推流 + 客户端边收边用"的系统都能用上这 6 条：实时日志解析、websocket 数据聚合、CDC 流式消费，皆通。


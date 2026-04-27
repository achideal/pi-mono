# 13 · OpenAI-compat 多端点差异自动探测（`detectCompat` / `getCompat`）

> 位置：`packages/ai/src/providers/openai-completions.ts` 里的 `detectCompat` + `getCompat`；`packages/ai/src/types.ts` 里的 `OpenAICompletionsCompat`
>
> 提炼点：**10+ 家厂商都说自己"OpenAI 兼容"，但每家都在不同字段上骗你。pi-ai 用"**兼容位面**（compat flags）抽象每种差异 + 基于 URL / provider 名的启发式自动探测 + 用户可逐字段显式覆盖"三段式，把差异彻底治住。**

---

## 1. "OpenAI 兼容"其实是个模糊概念

"使用 OpenAI 兼容 API" 是所有自托管 / 云 / 代理服务的标配宣传。但你把 `base_url` 改一下就会发现：

| 厂商 | 你会踩到的坑 |
| --- | --- |
| Cerebras | 不接受 `store: true` 字段；不支持 `developer` role |
| xAI (Grok) | 不支持 `reasoning_effort` 字段；不支持 `developer` role |
| Groq | `qwen/qwen3-32b` 的 `reasoning_effort` 必须填 `"default"` 不是 `"low"` |
| DeepSeek / Chutes | 用 `max_tokens` 而不是 `max_completion_tokens` |
| Ollama / vLLM / LM Studio | 可能不认识 `developer` role，要回退 `system` |
| zAI | 用 `thinking: { type: "enabled" }`，不是 `reasoning_effort` |
| OpenRouter | 用 `reasoning: { effort }` 嵌套对象 |
| Vercel AI Gateway | 要传路由策略字段 |
| LiteLLM proxy | `store` 不支持；tool name 要带在 result 里 |

如果在主流程里写 `if (provider === "xai") ...`，很快代码就变成了 25 个 if。
pi-ai 把这些差异分解成**一组布尔/枚举位**，叫 `OpenAICompletionsCompat`，放在 `types.ts`。

---

## 2. `OpenAICompletionsCompat` 是一张"兼容位面"表

```ts
export interface OpenAICompletionsCompat {
  supportsStore?: boolean;
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  reasoningEffortMap?: Partial<Record<ThinkingLevel, string>>;
  supportsUsageInStreaming?: boolean;
  maxTokensField?: "max_completion_tokens" | "max_tokens";
  requiresToolResultName?: boolean;
  requiresAssistantAfterToolResult?: boolean;
  requiresThinkingAsText?: boolean;
  thinkingFormat?: "openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template";
  openRouterRouting?: OpenRouterRouting;
  vercelGatewayRouting?: VercelGatewayRouting;
  zaiToolStream?: boolean;
  supportsStrictMode?: boolean;
}
```

这里每一位都对应一项真实线上翻过车的问题。这个表本身就是多年 debug 经验的凝结——它的"诞生方式"很像物理学里的**现象学模型**：不追求"完美兼容 API"的理论，而是"凡是我见过的差异都列出来，以 flag 的形式量化"。

### 2.1 字段的粒度要足够细

注意 `supportsReasoningEffort` 和 `reasoningEffortMap` 是分开的：

- 有的厂商根本不认识 `reasoning_effort` 字段 → `supportsReasoningEffort: false`，整个字段别写上。
- 有的厂商认识字段，但只接受特定的 enum 值（比如 Groq 的 qwen3-32b 只认 `"default"`）→ `supportsReasoningEffort: true` + `reasoningEffortMap: { minimal: "default", low: "default", medium: "default", high: "default", xhigh: "default" }`。

两条看似接近的约束被细分成两个 flag，原因就是"实际差异不一致"。这是一条重要的系统设计经验：**不要合并看起来相似但在线上会走不同分支的差异**。

### 2.2 `thinkingFormat` 是枚举不是布尔

同样是"支持推理"，但 payload 写法五花八门：

- OpenAI: `reasoning_effort: "medium"`
- OpenRouter: `reasoning: { effort: "medium" }`
- zAI: `thinking: { type: "enabled" }`
- Qwen (Dashscope): `enable_thinking: true`
- Qwen via chat template: `chat_template_kwargs: { enable_thinking: true }`

五种格式用一个枚举 `"openai" | "openrouter" | "zai" | "qwen" | "qwen-chat-template"` 表达，比五个布尔直观得多。

---

## 3. `detectCompat`：基于 URL / provider 名的启发式

```ts
function detectCompat(model: Model<"openai-completions">): Required<OpenAICompletionsCompat> {
  const provider = model.provider;
  const baseUrl = model.baseUrl;

  const isZai = provider === "zai" || baseUrl.includes("api.z.ai");
  const isNonStandard =
    provider === "cerebras" || baseUrl.includes("cerebras.ai") ||
    provider === "xai"      || baseUrl.includes("api.x.ai") ||
    baseUrl.includes("chutes.ai") ||
    baseUrl.includes("deepseek.com") ||
    isZai ||
    provider === "opencode" || baseUrl.includes("opencode.ai");

  const useMaxTokens = baseUrl.includes("chutes.ai");
  const isGrok = provider === "xai" || baseUrl.includes("api.x.ai");
  const isGroq = provider === "groq" || baseUrl.includes("groq.com");

  const reasoningEffortMap =
    isGroq && model.id === "qwen/qwen3-32b"
      ? { minimal: "default", low: "default", medium: "default", high: "default", xhigh: "default" }
      : {};

  return {
    supportsStore: !isNonStandard,
    supportsDeveloperRole: !isNonStandard,
    supportsReasoningEffort: !isGrok && !isZai,
    reasoningEffortMap,
    supportsUsageInStreaming: true,
    maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
    requiresToolResultName: false,
    requiresAssistantAfterToolResult: false,
    requiresThinkingAsText: false,
    thinkingFormat: isZai ? "zai"
      : provider === "openrouter" || baseUrl.includes("openrouter.ai") ? "openrouter"
      : "openai",
    openRouterRouting: {},
    vercelGatewayRouting: {},
    zaiToolStream: false,
    supportsStrictMode: true,
  };
}
```

### 3.1 双重识别：provider 名 OR baseUrl 包含关键字

每一条判断都是：

```ts
provider === "xai" || baseUrl.includes("api.x.ai")
```

为什么两种都要？

- 模型列表里自动生成的模型 **通常填了 provider**，但用户自建的 `Model<>` 可能只填 baseUrl。
- 某些用户挂代理，`baseUrl` 是 `proxy.company.com/xai/...`，这时 provider 名可能正确也可能乱写。
- 两种启发并列，漏网率最低。

### 3.2 识别条件聚合成 `isNonStandard`

```ts
const isNonStandard = cerebras || xai || chutes || deepseek || zai || opencode;
// ...
supportsStore: !isNonStandard,
supportsDeveloperRole: !isNonStandard,
```

"一批行为相同的 Provider"合并成一个 predicate，这样后面 flag 赋值变成简洁的 `!isNonStandard`，易读且好维护。如果某家 Provider 后来支持了 `store`，把它从 `isNonStandard` 里移出就行。

### 3.3 细粒度的模型特化

```ts
const reasoningEffortMap = isGroq && model.id === "qwen/qwen3-32b" ? {...} : {};
```

这一条打破了"整个 Provider 统一行为"的假设——同一个 Groq 上**只有 qwen3-32b 这个模型有特殊行为**。拆到了模型级，照样用一条语句表达。这种能力让后续踩到任何"单模型怪癖"都能在同一套架构里解决，不用再搞新抽象。

---

## 4. `getCompat`：显式 compat 字段逐字段覆盖 detected 结果

```ts
function getCompat(model): Required<OpenAICompletionsCompat> {
  const detected = detectCompat(model);
  if (!model.compat) return detected;

  return {
    supportsStore: model.compat.supportsStore ?? detected.supportsStore,
    supportsDeveloperRole: model.compat.supportsDeveloperRole ?? detected.supportsDeveloperRole,
    ...  // 每个字段都走 ??
  };
}
```

重要特性：

### 4.1 `??` 而不是 `||`

例：`supportsStore: false`（用户显式禁用）应该保留 `false`。如果用 `||`，会被 `|| detected` 错误地翻回 `true`。`??` 只对 `null/undefined` 降级，对用户显式写的 `false` 保留。

这是一个被无数新手写错的 JS 细节，pi-ai 在这里逐字段做了正确处理。

### 4.2 用户只需填自己关心的字段

`compat?: Partial<OpenAICompletionsCompat>`：

```ts
const litellmModel: Model<"openai-completions"> = {
  ...,
  compat: {
    supportsStore: false,  // 我只想禁用这一个
  },
};
```

其他字段全走 detected 默认。这种"默认自动 + 单点可改"的配置模式最受用户欢迎。

### 4.3 `Required<OpenAICompletionsCompat>`

注意返回类型是 **Required**：所有字段都必须有值。下游 stream 实现代码可以直接 `if (compat.supportsStore)` 不用写 `if (compat.supportsStore !== false)` 或 `?.`。把"字段有值"的承诺封装在 `getCompat` 边界里。

---

## 5. 为什么不上配置文件 / 不上 ML

有人会问：为什么不把兼容表放到 JSON / 某个 registry，程序启动时去加载？

两个原因：

1. **兼容位需要在代码里用**。Provider 实现那边要 `if (compat.thinkingFormat === "zai") { payload.thinking = { type: "enabled" }; }`。JSON 配置里的 flag 即使能加载，决策逻辑还是要硬编码。
2. **flag 增删和 Provider 代码绑死**。当你新增一种兼容差异时，一定要同时修改"发送 payload 的代码"和"flag 定义"。放在同一文件同一次 PR 最省事。

所以 pi-ai 选择"**兼容位面写成 TypeScript 接口，detectCompat 里用硬编码识别**"。虽然看起来有点"不够优雅"，但事实上这是对"运维一堆兼容 API"这件事最符合现实的工程解法。

---

## 6. 和 Model 的 `compat?` 字段形成闭环

上一篇讲过：`Model<TApi>` 的 `compat` 字段类型受泛型约束，只在 `"openai-completions"` / `"openai-responses"` 才允许写。

组合起来：

- 使用者在 Model 里**声明性**地写自己的兼容位。
- `detectCompat` 在 Provider 里**启发性**地根据 URL 识别。
- `getCompat` 在每次 stream 调用时**合并**两者。

这条链路让"已知厂商零配置 + 自建未知端点按需手写 compat"两种极端使用方式都能优雅工作。

---

## 7. 可以直接带走的套路

1. **把可变差异拆成"一组布尔/枚举 flag"**（compat 位面），不要写多分支 if。
2. **双重识别**：provider 名 + URL 关键字都走一遍。
3. **聚合 predicate**：把"行为相同的一组提供商"组成一个 `isNonStandard`。
4. **细到模型级的 override**：某些差异只出现在单个模型上，flag 应当允许。
5. **`??` 而非 `||`**：用户显式 `false` 必须保留。
6. **`Required<T>` 封闭类型**：下游消费不必处理 undefined 分支。
7. **`detect + override` 双段式**：默认零配置 + 逐字段可改，用户不背全量字段。

任何你做"多云 / 多网关 / 多浏览器 / 多设备兼容"的系统都可以原样用。兼容性问题不会消失，但有合适的抽象，你能把它压到 80 行代码里。


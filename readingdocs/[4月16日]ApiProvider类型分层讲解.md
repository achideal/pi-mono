# ApiProvider / ApiProviderInternal 类型分层讲解

这篇文档是 [stream.ts / api-registry.ts / register-builtins.ts 三文件串讲](./[4月15日]stream-registry三文件串讲与懒加载.md) 的配套阅读。

前一篇更偏**文件关系、调用链、懒加载机制**；这一篇更偏**类型关系、泛型约束、类型擦除和运行时校验**。

如果你已经知道：

- `stream.ts` 会按 `model.api` 去查 provider
- `api-registry.ts` 里有 `ApiProvider` 和 `ApiProviderInternal` 两套类型
- `registerApiProvider()` 里会调用 `wrapStream()`

但还是不明白：

- 为什么需要两层 provider 类型
- 为什么 `ApiProvider` 约束更强
- 为什么 registry 不能直接保存带精确泛型的 provider
- 为什么 `wrapStream()` 不能省

那么这篇就是专门回答这些问题的。

---

## 1. 先给一句最短总结

一句话总结：

- `ApiProvider<TApi, TOptions>` 是**给注册 provider 的开发者**用的强类型接口
- `ApiProviderInternal` 是**给 registry 内部存储和路由**用的统一接口
- `registerApiProvider()` 的作用，就是把前者安全地转换成后者

换句话说，这不是两套业务协议，而是同一个 provider 在**两个不同层次**上的两种表示：

1. **注册时**，尽量保留精确类型信息，帮助开发者少犯错
2. **存进 registry 后**，擦除成统一形状，方便动态查表和调用

---

## 2. 先看四个基础类型

要理解两层 provider，先要看清几个基础类型之间是什么关系。

### 2.1 `Api` 是什么

在 `packages/ai/src/types.ts` 里：

```typescript
export type KnownApi =
    | "openai-completions"
    | "mistral-conversations"
    | "openai-responses"
    | "azure-openai-responses"
    | "openai-codex-responses"
    | "anthropic-messages"
    | "bedrock-converse-stream"
    | "google-generative-ai"
    | "google-gemini-cli"
    | "google-vertex";

export type Api = KnownApi | (string & {});
```

重点在第二行：`Api` 不是一个封闭的枚举，而是：

- 已知的内置 api 字面量联合
- 再加上任意其他字符串

也就是说，`Api` 表示的是：

> "任何合法的 api 标识符"

它是一个**范围很大的总类型**，不是某一个具体 provider 绑定的那个 api。

### 2.2 `TApi extends Api` 是什么

当你看到：

```typescript
TApi extends Api
```

它的意思不是"又来一个 `Api`"，而是：

> "这里选中了某一个更具体的 api，它属于 `Api` 这个大集合。"

例如：

- `TApi = "openai-completions"`
- `TApi = "anthropic-messages"`
- `TApi = string`

都成立，因为它们都满足 `extends Api`。

所以要记住：

- `Api` = 总范围，表示"任意合法 api"
- `TApi extends Api` = 这一次选中的那个具体 api

### 2.3 `Model<TApi>` 会把 `api` 字段绑到泛型上

`Model<TApi>` 的关键部分是：

```typescript
export interface Model<TApi extends Api> {
    id: string;
    name: string;
    api: TApi;
    provider: Provider;
    baseUrl: string;
    reasoning: boolean;
    // ...
}
```

这里真正重要的是：

```typescript
api: TApi;
```

它表示：

- `Model<"openai-completions">` 的 `api` 必须是 `"openai-completions"`
- `Model<"anthropic-messages">` 的 `api` 必须是 `"anthropic-messages"`
- `Model<Api>` 的 `api` 只是某个 `Api`，但不保证是哪一个具体值

这就是为什么下面两种写法的约束强度完全不同：

```typescript
Model<"openai-completions">
Model<Api>
```

前者是精确到单个 api 的 model，后者只是"某个合法 api 的 model"。

### 2.4 `StreamFunction<TApi, TOptions>` 会把 model 和 options 一起绑住

`StreamFunction` 的定义是：

```typescript
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
    model: Model<TApi>,
    context: Context,
    options?: TOptions,
) => AssistantMessageEventStream;
```

它同时约束两件事：

1. 这个函数接收的 `model` 必须是 `Model<TApi>`
2. 这个函数接收的 `options` 必须是 `TOptions`

例如：

```typescript
StreamFunction<"openai-completions", OpenAIOptions>
```

的意思就是：

- 只能接 `Model<"openai-completions">`
- 只能接 `OpenAIOptions`

所以这里的泛型并不只是装饰，它直接决定了这个函数到底能安全处理什么输入。

---

## 3. `ApiProvider<TApi, TOptions>` 到底约束了什么

`api-registry.ts` 里的外部 provider 类型是：

```typescript
export interface ApiProvider<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> {
    api: TApi;
    stream: StreamFunction<TApi, TOptions>;
    streamSimple: StreamFunction<TApi, SimpleStreamOptions>;
}
```

最关键的是：这三个位置都用了**同一个 `TApi`**。

也就是说，一旦注册时把 `TApi` 推断成某个具体字面量，例如：

```typescript
TApi = "anthropic-messages"
```

那么整个对象就会被统一约束成：

```typescript
{
    api: "anthropic-messages";
    stream: StreamFunction<"anthropic-messages", TOptions>;
    streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions>;
}
```

这就意味着：

- `provider.api` 必须是 `"anthropic-messages"`
- `stream()` 只能接 `Model<"anthropic-messages">`
- `streamSimple()` 也只能接 `Model<"anthropic-messages">`

所以 `ApiProvider` 的主要价值确实就是：

> 在注册 provider 的那一刻，把 `api`、`stream`、`streamSimple` 三者锁到同一个具体 api 上。

### 3.1 它主要是在帮谁

主要是在帮**写 provider 的人**。

看 `register-builtins.ts` 里的注册方式：

```typescript
registerApiProvider({
    api: "anthropic-messages",
    stream: streamAnthropic,
    streamSimple: streamSimpleAnthropic,
});
```

如果你不小心写成：

```typescript
registerApiProvider({
    api: "anthropic-messages",
    stream: streamOpenAICompletions,
    streamSimple: streamSimpleAnthropic,
});
```

那么 `ApiProvider<TApi>` 这层强约束就会尽量在编译期把你拦下来，而不是等运行时才发现。

### 3.2 为什么光同样写 `Api` 不够

很多人一开始会觉得：

```typescript
api: Api;
stream: StreamFunction<Api, StreamOptions>;
```

这不是都用了同一个 `Api` 吗？

是用了同一个**类型名**，但不是同一个**具体值**。

它表达的只是：

- `api` 字段属于 `Api`
- `stream()` 也接收一个 `Model<Api>`

这只说明两者都在同一个大集合里，不说明它们必须绑定到同一个具体 api。

只有像 `TApi` 这样用**同一个泛型参数**把多个位置绑在一起，才表示：

> "这里的几个位置必须共享同一个具体 api。"

### 3.3 "用同一个泛型变量把多个位置绑在一起"是什么模式

这不是什么高级技巧，而是泛型存在的**核心理由之一**。最简单的例子就是 `identity` 函数：

```typescript
function identity<T>(x: T): T { return x; }
```

`T` 同时出现在参数和返回值两个位置，所以编译器知道：输入什么类型，输出就是什么类型。

`ApiProvider` 做的事情完全一样，只是绑定的位置更多（`api` 字段、`stream` 参数、`streamSimple` 参数）。

这种模式没有一个统一的官方名称，不同语境下的叫法不同：

- **TypeScript / 前端社区**：常叫 **correlated types**（关联类型）或 **linked generics**
- **类型论 / 函数式编程**：属于 **parametric polymorphism**（参数多态）的基本用法——"同一个类型变量出现在多个位置，迫使这些位置统一"
- **设计模式角度**：根据具体场景，有时归入 **type-safe builder** 或 **phantom type** 的变体

不管叫什么名字，核心思想只有一句话：**一个类型参数出现在多个位置时，这些位置被迫统一到同一个具体类型。**

---

## 4. 为什么 registry 不能直接保存精确泛型 provider

这是最容易卡住的点。

`api-registry.ts` 里的核心结构是：

```typescript
const apiProviderRegistry = new Map<string, RegisteredApiProvider>();
```

而 `RegisteredApiProvider` 里装的是：

```typescript
type RegisteredApiProvider = {
    provider: ApiProviderInternal;
    sourceId?: string;
};
```

问题是：为什么不直接存 `ApiProvider<TApi, TOptions>`？

### 4.1 因为一个 `Map<K, V>` 的 `V` 必须是统一形状

一个具体的 `Map<string, V>` 实例，value 类型 `V` 只能选一次。

例如：

```typescript
const map = new Map<string, number>();
```

这表示这个 `map` 里所有 value 都必须是 `number`。  
它不是说：

- key `"a"` 对应 `number`
- key `"b"` 对应 `string`

同理，如果你写：

```typescript
const map = new Map<string, ApiProvider<...>>();
```

那么这个 `ApiProvider<...>` 里的泛型参数，也得对整个 `map` 统一下来，而不是每个 entry 各来一套。

### 4.2 但这里实际要存的是异构 provider

registry 里要同时放很多不同 provider，例如：

```typescript
ApiProvider<"anthropic-messages", AnthropicOptions>
ApiProvider<"openai-completions", OpenAICompletionsOptions>
ApiProvider<"google-vertex", GoogleVertexOptions>
```

这些 provider 不是同一个泛型实例，它们是**异构值**：

- `TApi` 不同
- `TOptions` 不同

这时就不能直接说："来，把它们都当成一个统一的精确泛型类型放进同一个 `Map`。"

### 4.3 为什么不能给 registry 自己加泛型

你当然可以写出这种东西：

```typescript
class Registry<TApi extends Api, TOptions extends StreamOptions> {
    map = new Map<string, ApiProvider<TApi, TOptions>>();
}
```

但这样得到的是：

> "这个 registry 里的所有 provider 都共享同一个 `TApi` 和 `TOptions`。"

这显然不符合当前场景，因为这里的 registry 正是要同时放多个不同的 provider。

你真正想表达的是：

> "对于每个 entry，都存在它自己的一组 `TApi` / `TOptions`，并且只在这个 entry 内部保持自洽。"

对一个可变的动态 `Map` 来说，TypeScript 没有一个很自然的方式把这种"每个元素各自带一组泛型参数"直接保留下来。

所以这里需要在入库边界做一次类型擦除，把所有 provider 变成统一形状。

### 4.4 那为什么不用对象映射类型

如果 `Api` 是一个封闭集合，理论上确实可以设计成这种强映射：

```typescript
type Registry = {
    "openai-completions"?: ApiProvider<"openai-completions", OpenAICompletionsOptions>;
    "anthropic-messages"?: ApiProvider<"anthropic-messages", AnthropicOptions>;
};
```

这样每个 key 都能保留自己的精确类型。

但当前系统不是这个设计，因为 `Api` 是开放的：

```typescript
type Api = KnownApi | (string & {});
```

这意味着：

- 插件可以注册新的 api
- 扩展可以在运行时注入新的 provider
- key 空间不是编译期完全封闭的

在这种前提下，用动态 `Map` 更自然，而动态 `Map` 就需要统一的内部 value 形状。

---

## 5. 为什么不能把"只接 OpenAI model 的函数"直接看成"接任意 Api model 的函数"

这也是整个设计里最关键的类型安全问题。

先看一个具体函数类型：

```typescript
(model: Model<"openai-completions">, context: Context, options?: OpenAIOptions) => AssistantMessageEventStream
```

这个函数的真实含义是：

- 它只保证自己能处理 `Model<"openai-completions">`
- 它只保证自己能处理 `OpenAIOptions`

现在如果你直接把它"看成"：

```typescript
(model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream
```

含义就变了。这个新类型表示：

- 它能接收任何 `Model<Api>`
- 它能接收任何 `StreamOptions`

这比原函数承诺的能力大得多。

### 5.1 最小例子：为什么调用方会因此被允许传错 model

假设我们有：

```typescript
const openaiOnlyStream: StreamFunction<"openai-completions", OpenAIOptions> = (model, context, options) => {
    // 这里默认相信 model.api === "openai-completions"
    // 这里也默认相信 options 是 OpenAIOptions
    return new AssistantMessageEventStream();
};
```

如果有人硬把它当成：

```typescript
const widened: StreamFunction<Api, StreamOptions> = openaiOnlyStream;
```

那么 `widened` 的调用方看到的签名就是：

```typescript
(model: Model<Api>, context: Context, options?: StreamOptions) => ...
```

于是它在类型上就可以这么调：

```typescript
const anthropicModel: Model<"anthropic-messages"> = /* ... */;
widened(anthropicModel, context, {});
```

为什么这在类型上会变成"允许"？

因为调用方只看 `widened` 的表面签名：

- 参数类型是 `Model<Api>`
- 而 `Model<"anthropic-messages">` 确实属于 `Model<Api>`

所以调用点会被接受。

但运行时 `widened` 背后其实还是那个 OpenAI-only 函数，它并没有能力安全处理 Anthropic model。

这就产生了一个错位：

- **表面承诺**：我能处理任意 `Api`
- **真实能力**：我只能处理 `"openai-completions"`

这就是不安全的来源。

### 5.2 options 也有同样的问题

model 只是问题的一半，`options` 也是一样。

原始函数如果只接受：

```typescript
OpenAIOptions
```

那你把它放宽成：

```typescript
StreamOptions
```

也等于对外宣称：

> "任意符合 `StreamOptions` 的 options 都可以传进来。"

但原始实现未必能正确处理这些更宽的输入。

所以这里丢失的不只是 `api` 的精确绑定，还有 `options` 的精确绑定。

### 5.3 这就是为什么 registry 里不能直接存原始 provider 函数

如果 registry 里直接存原始的：

```typescript
StreamFunction<"openai-completions", OpenAIOptions>
```

然后又把它对外暴露成：

```typescript
StreamFunction<Api, StreamOptions>
```

那类型系统就会允许调用方传入：

- 错的 `model.api`
- 不匹配的 `options`

这正是 `wrapStream()` 要解决的问题。

---

## 6. `ApiProviderInternal` 到底是什么

`api-registry.ts` 里的内部类型是：

```typescript
interface ApiProviderInternal {
    api: Api;
    stream: ApiStreamFunction;
    streamSimple: ApiStreamSimpleFunction;
}
```

而：

```typescript
type ApiStreamFunction = (
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
) => AssistantMessageEventStream;
```

```typescript
type ApiStreamSimpleFunction = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
) => AssistantMessageEventStream;
```

所以你也可以把 `ApiProviderInternal` 理解成：

```typescript
interface ApiProviderInternal {
    api: Api;
    stream: StreamFunction<Api, StreamOptions>;
    streamSimple: StreamFunction<Api, SimpleStreamOptions>;
}
```

在当前代码里，这两种写法是结构等价的。

### 6.1 它的职责是什么

它的职责不是描述"某个 provider 最精确的真实能力"，而是描述：

> "一个 provider 在 registry 内部被统一存储、统一路由、统一调用时，应该长成什么样。"

所以 `ApiProviderInternal` 的重点不是精确，而是统一。

### 6.2 它不是第二套业务协议

这点很重要。

它不是说：

- `ApiProvider` 给外部协议用
- `ApiProviderInternal` 给另一套 provider 实现用

不是这样的。

真实情况是：

- 还是同一个 provider
- 只是它在**注册前**保留精确信息
- 在**存进 registry 后**被转换成了统一内部表示

所以更准确的说法是：

- `ApiProvider` = 强类型的输入形状
- `ApiProviderInternal` = 擦除后的内部存储形状

---

## 7. `registerApiProvider()` 和 `wrapStream()` 是怎么把两层接起来的

先看 `wrapStream()`：

```typescript
function wrapStream<TApi extends Api, TOptions extends StreamOptions>(
    api: TApi,
    stream: StreamFunction<TApi, TOptions>,
): ApiStreamFunction {
    return (model, context, options) => {
        if (model.api !== api) {
            throw new Error(`Mismatched api: ${model.api} expected ${api}`);
        }
        return stream(model as Model<TApi>, context, options as TOptions);
    };
}
```

这段代码做了两件事：

1. **把窄函数包成宽函数**
2. **在中间补一个运行时断言**

### 7.1 第一件事：把窄函数包成统一签名

原始传入的 `stream` 类型是：

```typescript
StreamFunction<TApi, TOptions>
```

返回的包装函数类型是：

```typescript
ApiStreamFunction
```

也就是：

```typescript
(model: Model<Api>, context: Context, options?: StreamOptions) => AssistantMessageEventStream
```

这样一来，所有不同 provider 的 `stream` 都能被转换成统一签名，于是就能塞进同一个 registry。

### 7.2 第二件事：补上运行时安全边界

类型擦除后，包装函数的签名变成了 `(model: Model<Api>, ...) => ...`。

这意味着 TypeScript **在调用这个包装函数时，不会检查 `model.api` 是否和 provider 匹配**——因为任何 `Model<Api>` 都能传进来，编译器认为这完全合法。

所以这里的运行时断言 **不是"双保险"（类型系统查一遍、运行时再查一遍），而是唯一的防线**：

```typescript
if (model.api !== api) {
    throw new Error(`Mismatched api: ${model.api} expected ${api}`);
}
```

**它到底在防什么？** 正常调用路径是 `registry.get(model.api)`——用 model 自己的 api 字符串去 Map 里取 provider，取出来的天然就是匹配的。但如果有人写了 bug（比如拿错了 key、传错了 model），编译器不会报错，只有这行运行时检查能拦住。

只有检查通过后，才会执行：

```typescript
return stream(model as Model<TApi>, context, options as TOptions);
```

注意这里的 `as Model<TApi>` / `as TOptions` 不是凭空乱转，而是建立在前面的运行时检查之上：

- `model.api` 已经和 `api` 对上了
- 这个 wrapper 也只会在对应 api 的 registry entry 下被调用

所以这一步是在说：

> "我先在运行时确认你确实是这个 provider 该处理的 model，再把它恢复成更窄的静态类型去调用原始实现。"

### 7.3 `registerApiProvider()` 真正做的事

`registerApiProvider()` 的核心逻辑是：

```typescript
export function registerApiProvider<TApi extends Api, TOptions extends StreamOptions>(
    provider: ApiProvider<TApi, TOptions>,
    sourceId?: string,
): void {
    apiProviderRegistry.set(provider.api, {
        provider: {
            api: provider.api,
            stream: wrapStream(provider.api, provider.stream),
            streamSimple: wrapStreamSimple(provider.api, provider.streamSimple),
        },
        sourceId,
    });
}
```

它并不是直接把原始 `provider` 塞进 Map，而是先把它转换成：

```typescript
{
    api: provider.api,
    stream: wrapStream(...),
    streamSimple: wrapStreamSimple(...),
}
```

也就是说，registry 里存的从来不是"裸的精确 provider"，而是：

> "统一签名 + 运行时防线"之后的内部 provider。

---

## 8. 从注册到调用，把整条链再串一遍

如果把完整流程串起来，实际上是这样的：

### 第 1 步：注册时，使用强类型 `ApiProvider<TApi, TOptions>`

例如：

```typescript
registerApiProvider({
    api: "anthropic-messages",
    stream: streamAnthropic,
    streamSimple: streamSimpleAnthropic,
});
```

这时 `TApi` 会被推断成 `"anthropic-messages"`。  
所以注册阶段能得到最强的静态约束。

### 第 2 步：入库时，转换成统一的 `ApiProviderInternal`

`registerApiProvider()` 不直接存原对象，而是经过：

- `wrapStream()`
- `wrapStreamSimple()`

转换成统一内部表示。

这时 registry 里保存的是：

```typescript
Map<string, RegisteredApiProvider>
```

而不是各种不同泛型实例的裸 provider。

### 第 3 步：读取时，只返回内部统一类型

`getApiProvider()` 的返回值是：

```typescript
ApiProviderInternal | undefined
```

也就是说，从 registry 取出来后，静态类型上已经不再保留：

- "这个 provider 原来绑定的是哪一个具体 `TApi`"
- "它原来接收的精确 `TOptions` 是什么"

这部分信息在静态类型上被擦掉了。

### 第 4 步：真正调用时，由 wrapper 保证别调错

`stream.ts` 里会按 `model.api` 查 provider：

```typescript
const provider = resolveApiProvider(model.api);
return provider.stream(model, context, options as StreamOptions);
```

这里用的是 `model.api` 去查表，所以**正常流程下取出来的 provider 一定是匹配的**——你拿 `"anthropic-messages"` 去查，取出来的就是 Anthropic 的 provider。

但 TypeScript 并不知道这一点。从类型系统的视角看，`provider.stream` 的签名是 `(model: Model<Api>, ...)`，而 `model` 也是 `Model<Api>`——两边都是宽泛的 `Api` 类型，编译器无法验证它们是否真的对应同一个具体 api。也就是说，**即使有人传了一个错误的 model 进来，编译器也不会报错**。

所以 wrapper 里的运行时断言是最后一道防线：

```typescript
if (model.api !== api) {
    throw new Error(...)
}
```

然后才回到原始 provider 实现。

所以整条链可以概括成：

```text
注册时：泛型约束保证 api、stream、streamSimple 三者一致（编译期检查）
入库时：擦除成统一形状，精确泛型信息丢失
调用时：正常流程按 model.api 查表天然匹配，但编译器无法验证，靠 wrapper 的运行时断言兜底
```

这三步缺一不可。

---

## 9. 最后怎么记最不容易混

如果你只想记最关键的 6 句话，可以记下面这些：

1. `Api` 是"任意合法 api"的大集合，不是某个 provider 绑定的那个具体 api。
2. `TApi extends Api` 里的 `TApi` 才表示"这一次选中的那个具体 api"。
3. `ApiProvider<TApi, TOptions>` 用同一个 `TApi` 把 `api`、`stream`、`streamSimple` 绑在一起。
4. registry 里要放的是异构 provider，所以必须转换成统一内部形状，不能直接保留每个 entry 自己的精确泛型。
5. `ApiProviderInternal` 不是第二套业务协议，只是 registry 内部的擦除后表示。
6. `wrapStream()` 的作用是：把窄函数包装成统一签名，并在运行时检查 `model.api` 是否匹配。这个运行时检查不是"双保险"，而是类型擦除后**唯一的**安全边界。

---

## 10. FAQ：读完后常见的三个追问

### Q1：注册时只是提供了一个函数对象，又没调用它，类型系统能约束什么？

约束的不是函数的**运行时行为**，而是函数的**类型签名是否匹配**。

当 `TApi` 被推断为 `"anthropic-messages"` 后，`ApiProvider` 要求 `stream` 的类型是：

```typescript
StreamFunction<"anthropic-messages", TOptions>
// 即 (model: Model<"anthropic-messages">, ...) => ...
```

如果你传入的是一个签名为 `(model: Model<"openai-completions">, ...) => ...` 的函数，`Model<"openai-completions">` 和 `Model<"anthropic-messages">` 类型不兼容（因为 `api` 字段的字面量类型不同），TypeScript 会在编译期报错。

所以它检查的是：**你提供的函数声称自己能处理什么类型的输入**，而不是它运行时实际会做什么。函数不需要被调用，签名本身就是一种契约，编译器可以静态验证这个契约是否和 `api` 字段一致。

### Q2：存进 Map 的时候 api 和 stream 是匹配的，为什么取出来调用时还需要运行时检查？

存的时候确实是匹配的，但问题出在**取出来之后**。

正常调用路径是 `registry.get(model.api)`——用 model 自己的 api 去查 Map，取出来的 provider 天然就是匹配的。这条路径不会出错。

但 TypeScript **无法在类型层面保证这一点**。从编译器视角看，`provider.stream` 的参数类型是 `Model<Api>`（宽泛的），传进来的 `model` 也是 `Model<Api>`（宽泛的）——两边都是 `Api` 这个大集合，编译器不知道它们是否对应同一个具体 api。所以如果有人写了 bug（比如拿错了 key、或者传错了 model），编译器完全不会报错。

运行时断言就是在防这种情况。正常流程下它永远不会触发，但它作为兜底存在，确保即使有 bug 也能及早暴露。

### Q3：`ApiProviderInternal` 用 `any` 行不行？

技术上可以，但会过度擦除。

用 `ApiProviderInternal`（签名是 `Model<Api>`, `StreamOptions`）：调用方仍然必须传一个合法的 `Model` 和合法的 `StreamOptions`，你不能传一个 `number` 或其他无关类型进去。

用 `any`：调用方可以传任何东西，编译器完全不管，连"参数得是个 Model"这种最基本的结构检查都没了。

所以 `ApiProviderInternal` 是一个**平衡点**——它擦除了"具体是哪个 api"的精确信息（因为 Map 需要统一 value 类型），但保留了"参数必须是 Model、Context、StreamOptions"的结构约束。**刚好擦除到能塞进 Map，但尽量不多擦。**

---

## 11. 和前一篇文档怎么分工

如果你现在已经理解了这里的类型分层，再回看 [stream.ts / api-registry.ts / register-builtins.ts 三文件串讲](./stream-registry-lazy-loading.md)，会更容易把两篇文档拼起来：

- 前一篇负责解释：三个文件如何分层、怎么注册、怎么懒加载、怎么一路调到真实 provider
- 这一篇负责解释：为什么 `api-registry.ts` 里要设计成 `ApiProvider` + `ApiProviderInternal` 两层，以及 `wrapStream()` 在类型系统里到底补了什么

一句话说：

- 想看**架构和调用链**，读前一篇
- 想看**类型和泛型推导**，读这一篇

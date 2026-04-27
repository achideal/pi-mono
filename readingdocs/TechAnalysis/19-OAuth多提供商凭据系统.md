# 19 · OAuth 多提供商凭据系统：登录、刷新、存储彻底分离

> 位置：`packages/ai/src/utils/oauth/` 目录下的 `index.ts` / `types.ts` / 每家 provider；`packages/ai/src/oauth.ts`（子 entry point）
>
> 提炼点：**用一个三字段契约（`login / refreshToken / getApiKey`）统一所有 OAuth 厂商，所有**存储动作留给调用方**。注册表模式 + 可扩展 provider + 回调驱动 UI 交互，适配 CLI / TUI / GUI 多端。**

---

## 1. OAuth 的 5 家各不相同

pi-ai 支持五家 OAuth 登录：

- **Anthropic**（Claude Pro/Max 订阅）：PKCE + 手工粘贴 code。
- **OpenAI Codex**（ChatGPT Plus/Pro）：PKCE + Loopback 本地回调 server。
- **GitHub Copilot**：Device flow（先给 user code 展示给用户，轮询 token 端点）。
- **Google Gemini CLI**：Google Cloud OAuth + project ID 交互。
- **Google Antigravity**：Google Cloud + User-Agent 特定 header。

每家的 login UI、token endpoint、refresh 协议、返回 credential 结构都不一样。
但对 pi-ai 来说，最终要做的就三件事：

1. 让用户登录、拿到 credentials。
2. credentials 过期时刷新。
3. 把 credentials 映射成可以作为 `apiKey` 传给 Provider 的字符串。

pi-ai 把这三件事抽成三方法契约。

---

## 2. 契约：`OAuthProviderInterface`

```ts
export interface OAuthProviderInterface {
  readonly id: OAuthProviderId;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
  usesCallbackServer?: boolean;
  refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials>;
  getApiKey(credentials: OAuthCredentials): string;
  modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
}
```

关键 4 个成员：

| 成员 | 作用 |
| --- | --- |
| `login(callbacks)` | 跑完整登录，返回 credentials |
| `refreshToken(creds)` | 刷新过期的 access token |
| `getApiKey(creds)` | 把 creds 映射成送去 API 的 key（通常是 access token） |
| `modifyModels?` | 某些 OAuth 换了 baseUrl（如 Google CLI 走 cloudcode.googleapis.com），在这里统一修改 models 列表 |

credentials 本身是一个极简合约：

```ts
export type OAuthCredentials = {
  refresh: string;
  access: string;
  expires: number;        // ms timestamp
  [key: string]: unknown;  // 厂商自由扩展（如 project_id、endpoint）
};
```

`[key: string]: unknown` 是"扩展位"。**Anthropic 可能存 subscription tier，Google 可能存 cloud project**，存在 credentials 对象里随用户本地的 json 一起写。

---

## 3. 登录流程：callbacks 驱动，完全脱离 UI

```ts
export interface OAuthLoginCallbacks {
  onAuth: (info: OAuthAuthInfo) => void;
  onPrompt: (prompt: OAuthPrompt) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  signal?: AbortSignal;
}
```

- `onAuth({ url, instructions })`：告诉 UI "把这个 URL 显示给用户 / 打开浏览器"。
- `onPrompt({ message, placeholder })`：等用户输入（用户 code、project id、粘贴回来的 authorization code）。Promise 返回用户输入内容。
- `onProgress(msg)`：显示"正在刷新…"之类的状态。
- `onManualCodeInput`：浏览器 callback 失败时的手工粘贴入口。
- `signal`：登录整个过程可被 abort。

这个设计意味着：

- **library 不做任何 UI**。CLI 打日志、TUI 弹 dialog、GUI 开浏览器，全靠 callbacks 注入。
- **library 不做任何存储**。login 返回 credentials，调用方自己决定怎么存（文件、加密存储、secret manager）。

这是最干净的"关注点分离"。同一份 pi-ai OAuth 代码能给：

- pi coding agent 的 TUI
- 第三方脚本里的 `loginAnthropic({ onAuth, onPrompt })`
- 浏览器应用（弹 popup 让用户登录）

三者用，无需 fork。

---

## 4. 注册表：内建 + 自定义一视同仁

```ts
const BUILT_IN_OAUTH_PROVIDERS = [
  anthropicOAuthProvider,
  githubCopilotOAuthProvider,
  geminiCliOAuthProvider,
  antigravityOAuthProvider,
  openaiCodexOAuthProvider,
];

const oauthProviderRegistry = new Map<string, OAuthProviderInterface>(
  BUILT_IN_OAUTH_PROVIDERS.map((p) => [p.id, p]),
);

export function getOAuthProvider(id): OAuthProviderInterface | undefined;
export function registerOAuthProvider(provider): void;
export function unregisterOAuthProvider(id: string): void;
export function resetOAuthProviders(): void;
```

和第 2 篇讲的 ApiProvider 注册表同构：

- 内建 provider 启动时注册。
- 用户（或扩展）可以 `registerOAuthProvider(myProvider)` 加自己的 OAuth 实现。
- `unregisterOAuthProvider(id)` 把**内建 provider 恢复到默认实现**或删除自定义 provider——一条语句保留了"先 override 再恢复"的对称性。

这让 pi 的 extension 系统里**第三方能自己加 OAuth**（比如 Cloudflare AI Gateway 登录），不需要改 pi-ai 的核心。

---

## 5. `getOAuthApiKey`：一个函数解决"用 OAuth 做鉴权"的整套生命周期

```ts
export async function getOAuthApiKey(
  providerId: OAuthProviderId,
  credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
  const provider = getOAuthProvider(providerId);
  if (!provider) throw new Error(`Unknown OAuth provider: ${providerId}`);

  let creds = credentials[providerId];
  if (!creds) return null;

  if (Date.now() >= creds.expires) {
    try { creds = await provider.refreshToken(creds); }
    catch { throw new Error(`Failed to refresh OAuth token for ${providerId}`); }
  }

  const apiKey = provider.getApiKey(creds);
  return { newCredentials: creds, apiKey };
}
```

这个 40 行函数承担了**让上层完全不用关心 token 过期**的职责：

- 没 creds → `null`（没登录）。
- 过期 → 自动调 `refreshToken`。
- 拿到最新 creds → 转成 apiKey 字符串。

**返回 `{ newCredentials, apiKey }`**：调用方拿到 apiKey 用于当次 API 请求，同时用 newCredentials 覆盖 auth.json 里的老条目。这是因为 refresh 后 access/expire 都变了，需要持久化，否则下次还得再 refresh。

注意返回值的 tuple-style 设计：**调用方有义务把 newCredentials 写回**。pi-ai 不做这件事，是为了**不假设存储后端**。所有已知使用方都一样写：

```ts
const result = await getOAuthApiKey("github-copilot", auth);
if (!result) throw new Error("Not logged in");

auth["github-copilot"] = { type: "oauth", ...result.newCredentials };
writeFileSync("auth.json", JSON.stringify(auth, null, 2));

const response = await complete(model, ctx, { apiKey: result.apiKey });
```

5 行代码同时解决了"登录检测 / 自动刷新 / 持久化 / 使用"。

---

## 6. `modifyModels` 的妙用

看 `OAuthProviderInterface.modifyModels?`：

```ts
modifyModels?(models: Model<Api>[], credentials: OAuthCredentials): Model<Api>[];
```

Google Gemini CLI 登录之后，baseUrl 要变成 `https://cloudcode-pa.googleapis.com/...` 而不是普通的 Generative AI endpoint。直接在 login 时把 models 列表整体改一遍。

调用方（ModelRegistry）用法：

```ts
let models = loadAllGoogleModels();
const provider = getOAuthProvider("google-gemini-cli");
if (provider?.modifyModels && creds) {
  models = provider.modifyModels(models, creds);
}
```

很多"OAuth 下游 endpoint 不一样"的场景都能用这个点解决，不需要把 Model 生成逻辑耦合到 OAuth 层。是"扩展点留在对的地方"的又一例。

---

## 7. 子 entry point：`@mariozechner/pi-ai/oauth`

```
packages/ai/src/oauth.ts
  └─ export * from "./utils/oauth/index.js";
```

package.json 里是一个独立 export：

```json
"exports": {
  ".": "./dist/index.js",
  "./oauth": "./dist/oauth.js",
  ...
}
```

好处：

- **浏览器 / 其他 bundler 用户可以不打包 OAuth 代码**，`import { complete } from "@mariozechner/pi-ai"` 不拉这个子模块的依赖（`http` server 监听、`open` 库等 Node-only 的东西）。
- **Node CLI 用户想做自己的 login tool** 只 import oauth：`import { loginAnthropic } from "@mariozechner/pi-ai/oauth"`。

子 entry 是控制"哪些代码谁打包"的极佳手段。

---

## 8. `types.ts` 里一条重要的向后兼容细节

```ts
export type OAuthProvider = OAuthProviderId;   // @deprecated
export interface OAuthProviderInfo { ... }     // @deprecated
export function getOAuthProviderInfoList() { ... }   // @deprecated
```

旧 API 是 "provider info is a data structure"，新 API 是 "provider is an interface"。deprecated 标签同时保留 + 前向兼容写法：

```ts
export function getOAuthProviderInfoList(): OAuthProviderInfo[] {
  return getOAuthProviders().map((p) => ({ id: p.id, name: p.name, available: true }));
}
```

不是直接删老接口，而是用新 API 重新实现老接口。老用户代码继续工作，但 IDE 会给出 @deprecated 提示引导迁移。

这种"先加新 API、标老为 deprecated、若干版本后再删"的双轨演进，是 SDK 长期维护的必备姿势。

---

## 9. 可以直接带走的设计

1. **三方法契约（login/refresh/getApiKey）统一多家 OAuth**：厂商实现只管自己，调用方只关心这三个动作。
2. **credentials 是普通对象 + 扩展位**：厂商自由扩展字段，调用方按需 serialize。
3. **Login 完全由 callbacks 驱动**：UI 层完全解耦，同一份代码服务 CLI / TUI / GUI。
4. **library 不做存储**：返回 credentials 由调用方写盘，避免硬绑 auth.json 路径。
5. **`getOAuthApiKey` 一体化封装"过期判定 + refresh + api key 生成"**：调用方 1 行获得可用 apiKey。
6. **返回 `{ newCredentials, apiKey }`**：提醒调用方持久化新 creds 的契约。
7. **内建 / 自定义 provider 同一张注册表**：扩展点天然开放。
8. **`modifyModels` 钩子让 OAuth 可改 baseUrl 等 Model 字段**：跨关注点整洁解耦。
9. **子 entry point (`/oauth`)** 隔离 Node-only 的依赖，浏览器用户不受影响。
10. **@deprecated 双轨兼容**：老 API 不删只是不推荐。

任何需要"第三方登录集成"的场景——自家 SSO、各家云账号、SaaS 登录聚合——都可以直接套。契约式的 OAuth 抽象是这个架构最值得背下来的部分。


# 17 · Extension 扩展体系与 pi 包管理

> 位置：`packages/coding-agent/src/core/extensions/` 目录下的 `types.ts` / `loader.ts` / `runner.ts` / `wrapper.ts`；`src/core/package-manager.ts`；README 的 Extensions / Pi Packages 章节
>
> 提炼点：**一个 TypeScript 模块导出 `default (pi) => void`，就能挂钩子、加工具、加命令、加 UI、替换默认行为。加上"jiti 按需编译"+ `VIRTUAL_MODULES` 静态注入 + npm/git 包管理，整个 pi 是一个"用户随用随改"的平台。**

---

## 1. 为什么值得学习

大多数 "AI coding agent" 都内置了"我认为最好"的一套行为：permission 弹窗、plan 模式、sub-agent、to-do 列表、MCP 集成……一旦你想改，要么改不动，要么 fork 自己维护。

pi-coding-agent 的哲学是反过来的（见其 README 的 "Philosophy"）：

> Pi is aggressively extensible so it doesn't have to dictate your workflow.

于是 pi 内置极少，剩下的都靠 Extensions、Skills、Prompts、Themes 这四类**纯 TypeScript/Markdown 资源**补。而且它们可以通过 npm / git 当作"pi 包"分享。

这套扩展架构有几个非常值得偷师的工程点。

---

## 2. Extension 的形态：一个函数

```ts
// ~/.pi/agent/extensions/my-ext.ts
import { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

入口是一个接受 `ExtensionAPI` 的函数。极度简洁。用户不需要学任何框架语法，就是"拿到一个 pi 对象，随便注册东西"。

### 2.1 `ExtensionAPI` 是一个极大的 union

看 `types.ts` 里它的定义，有上百个方法——`on(event, handler)` 支持 20+ 种事件、`registerTool`、`registerCommand`、`registerMessageRenderer`、`registerProvider`、`ui.showOverlay`、`fs.read`、`exec`、`session.getBranch`……

API 表面很大，但扩展作者**只挑自己用的 5 个**即可。函数签名都是 TS 可自动补全的。这种"门面即目录"的设计非常适合"临时写个 extension 做点定制"的场景。

### 2.2 事件订阅：agent stack 里每一层事件都暴露

```ts
pi.on("session_start", ...)
pi.on("session_compact", ...)
pi.on("context", async (event, ctx) => { ... /* 改 LLM context */ })
pi.on("before_agent_start", async (event, ctx) => { ... /* 改 prompt */ })
pi.on("turn_start" | "turn_end", ...)
pi.on("message_start" | "message_end" | "message_update", ...)
pi.on("tool_execution_*", ...)
pi.on("tool_call", async (event, ctx) => { ... /* 可 block 某个 tool */ })
pi.on("tool_result", async (event, ctx) => { ... /* 可改写 result */ })
pi.on("user_bash", ...)        // !command 被输入时
pi.on("input", ...)            // 每次用户按 Enter 之前
```

这些事件正对应第 4 / 7 篇讲的 AgentEvent 序列，但更丰富——包含 session 级 / CLI 级的事件（如 `input`、`user_bash`、`model_select`）。扩展有能力在任何你能想到的时机介入。

有些事件的 handler 可以**返回结果**改变行为：

- `context` 事件 → 返回替换后的 messages 数组。
- `tool_call` → 返回 `{ block: true, reason }` 或 `{ result }` 替换工具返回。
- `resources_discover` → 返回额外要加载的 skills/prompts/extensions。

这等价于暴露了第 7 篇讲的 `beforeToolCall`/`afterToolCall` 钩子——只是以事件形式包装。

---

## 3. `jiti` 按需编译 + `VIRTUAL_MODULES` 静态绑定

把 TS 文件作为运行时 extension 是个老难题：

- 用户写 TS，但 Node 不直接跑 TS。
- 不能让用户安装 tsc + 编译成 JS 后再 require。
- 还要能在 Bun single-file 二进制里工作（没法 `require("@sinclair/typebox")`）。

pi 用两层叠加方案：

### 3.1 `jiti` 做运行时编译

```ts
import { createJiti } from "@mariozechner/jiti";
// 编译并 require 用户的 extension.ts
const jiti = createJiti(...);
const mod = await jiti.import(extensionFilePath);
const factory = mod.default;
factory(apiObject);
```

jiti 是一个 TS loader，能动态编译 TS 并返回 JS 模块。用户写 `foo.ts` 可以直接被加载。

### 3.2 `VIRTUAL_MODULES` 给二进制环境注入依赖

当 pi 被打包成 Bun 单文件二进制时，系统里根本没有 `node_modules`。但扩展代码可能 `import { Type } from "@sinclair/typebox"`。这时：

```ts
const VIRTUAL_MODULES = {
  "@sinclair/typebox": _bundledTypebox,       // 编译期静态导入
  "@mariozechner/pi-agent-core": _bundledPiAgentCore,
  "@mariozechner/pi-tui": _bundledPiTui,
  "@mariozechner/pi-ai": _bundledPiAi,
  "@mariozechner/pi-ai/oauth": _bundledPiAiOauth,
  "@mariozechner/pi-coding-agent": _bundledPiCodingAgent,
};

const jiti = createJiti(..., { virtualModules: VIRTUAL_MODULES });
```

**关键**是这些 import 写在 loader.ts 顶部作为静态导入，**Bun 编译时会把它们打进二进制**。然后 jiti 的 `virtualModules` 选项告诉它"遇到这些 specifier 时直接用这些对象，不要再 resolve"。

扩展里的 `import { stream } from "@mariozechner/pi-ai"` **就能拿到编译时静态绑进来的那份 pi-ai**，和 pi 主体用的是同一份。

这个设计兼顾了：

- **单文件分发**：没有 node_modules 依然能加载 extension。
- **共享运行时**：extension 和 pi 用同一份 pi-ai，状态完全同步（注册表、事件流都是同一个）。
- **开发体验一致**：用户写 extension 和写普通 TS 项目毫无差别。

### 3.3 开发模式的 aliases

在 Node 开发环境（非二进制）里，jiti 用 `aliases` 指回 monorepo 里本地的 dist：

```ts
_aliases = {
  "@mariozechner/pi-coding-agent": packageIndex,
  "@mariozechner/pi-agent-core": resolveWorkspaceOrImport("agent/dist/index.js", "@mariozechner/pi-agent-core"),
  ...
};
```

这样本地改 pi-agent-core 的源码 + 重 build → extension 热加载立刻看到新行为。

---

## 4. `ExtensionRunner` + wrapper 的隔离

扩展代码是用户写的，可能崩、可能慢、可能注册冲突的东西。runner 做了几件事：

- 给每个 extension 一个独立的 `sourceId`。`registerTool`/`registerCommand` 里标注来源。
- 扩展抛异常时捕获，记录到 `ResourceDiagnostic`，不影响主流程启动。
- 热卸载：Extension 被禁用时，按 sourceId 移除它注册的所有东西（包括 tool / provider / command / 事件订阅）。
- 每次事件分发都把用户 handler 包在 try/catch 里。

这让"一个扩展挂了不能把整个 agent 拉下水"成为结构上的必然。

---

## 5. Pi 包管理器：npm + git + 本地目录三种源

README 的命令：

```bash
pi install npm:@foo/pi-tools
pi install git:github.com/user/repo@v1
pi install https://github.com/user/repo
pi install ssh://git@github.com/user/repo
pi remove npm:@foo/pi-tools
pi update
pi list
pi config
```

看 `package-manager.ts`，源 identifier 用 `{scheme}:{spec}@{version}?` 格式表示，scheme ∈ `{"npm","git","https","ssh","file"}`。每种有自己的安装实现：

- **npm**：执行配置的 `npmCommand`（默认 `npm`）`install --prefix ~/.pi/agent/npm`。
- **git**：`git clone` 到 `~/.pi/agent/git/<hash>`，按 tag/commit checkout。
- **https/ssh**：规范化成 git 源。

### 5.1 `pi` 字段声明包里的资源

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

包安装后，pi 会把这些目录 recursively 扫一遍：

- `extensions/*.ts` → 当作 extension 加载。
- `skills/*/SKILL.md` → 注册到 skills 注册表（第 18 篇）。
- `prompts/*.md` → slash 命令。
- `themes/*.json` → 主题文件。

**没有 `pi` manifest**时，按约定目录名自动发现。这意味着你可以把自己的项目随意挂为包（只要有 `extensions/` 目录就行）。

### 5.2 `pi config` 按资源粒度启用/禁用

同一个包里可能有 5 个 extension，但我只想用其中 1 个。`pi config` 打开 TUI 菜单：

```
▼ @foo/pi-tools
  ▼ extensions
    [x] deploy
    [ ] plan-mode
  ▼ skills
    [x] aws-deploy-guide
```

切换每一项都写到 `~/.pi/agent/settings.json`。加载时跳过被禁用的资源。

这让"共享一套大包 / 挑选用其中子能力"变成轻量操作。

### 5.3 本地 `.pi/` 工程优先

除了全局 `~/.pi/agent/`，每个项目根还可以有 `.pi/`：

- `.pi/extensions/`、`.pi/skills/`、`.pi/prompts/`、`.pi/themes/`
- `.pi/settings.json`：项目级设置覆盖全局。
- `pi install -l npm:xxx`：装到项目本地。

让"项目独有的 agent 行为"和"所有项目共享的行为"分层存放。

---

## 6. 安全 vs. 能力的权衡

README 加了非常醒目的警告：

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

这是清楚的契约：**能力越大风险越大**。pi 选择完全信任 extension——不做沙箱、不做权限限制。理由：

- 任何有用的 extension 都需要接触系统（跑 bash、读文件）。
- "强沙箱"的成本不匹配单用户 CLI 的场景。
- 替代方案（"问问模型要不要跑"）只会造出"拒绝学模型"的坏产物。

取而代之，文档让用户"审代码"，并把扩展集中到项目本地 `.pi/` 让 git diff 明显可见。

---

## 7. 和 AgentSession / SessionRuntime 的协作

启动时序（简化）：

```
启动：
1. PackageManager 扫描 ~/.pi/agent/{git,npm}/**
2. 发现每个包的 extensions/skills/prompts/themes
3. ResourceLoader 按 settings.json 过滤掉被禁用的
4. ExtensionRunner.loadAll(pathList):
     for each ext:
       jiti.import(path) → factory
       factory(apiObject)
5. 所有 pi.on(...) 注册到 EventBus
6. 所有 pi.registerTool(...) 加到 AgentSession.tools
7. AgentSession 启动 → 每个 AgentEvent 转给 EventBus 转给扩展 handler
```

AgentSession 是中枢。它向 Extension 暴露的 `pi.ui.*`、`pi.session.*`、`pi.agent.*` 都是 AgentSession 自身能力的受限投影。每次扩展调用这些方法，就等于"在正确的时机触发了 AgentSession 对应动作"。

这解耦让 extension 几乎没有机会直接破坏核心状态——它们**永远通过 pi 对象**操作，runner 和 wrapper 有机会审计 / 日志 / 降级。

---

## 8. 可以学走的设计

1. **扩展入口是一个函数**：`default (pi) => void`。极小门槛，极大自由度。
2. **API 表面很大但只需按需使用**：user 只挑自己要的方法。
3. **Events 让任意生命周期点可切入**：不需要 fork 主流程代码。
4. **`handler 返回值` 可以影响主流程**：block / replace / augment。
5. **jiti 做 TS 运行时加载 + `virtualModules` 让二进制环境也能跑**。
6. **`sourceId` 让注册/卸载成对**：热更新、冲突诊断都靠它。
7. **包可以来自 npm / git / 本地目录，manifest 声明资源**：统一加载路径。
8. **按资源粒度启用/禁用**：大包的细颗粒定制。
9. **项目级 `.pi/` vs 全局 `~/.pi/agent/`**：资源有清晰的作用域。
10. **明确告诉用户"扩展是 full system access"**：不过度承诺安全，换取最大能力。

对任何想做"可扩展产品"的项目，这 10 条是直接可搬的蓝图。而且 pi 这套方案在一个几千行的核心之上，组合出了覆盖千奇百怪用户需求的生态——这是这种抽象最有力的验证。


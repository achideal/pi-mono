# 18 · Skills 标准与 on-demand 能力加载

> 位置：`packages/coding-agent/src/core/skills.ts`；README 的 Skills 章节；docs/skills.md
>
> 提炼点：**用"一份 `SKILL.md` + 一段 frontmatter + description 字段"告诉 LLM "某件事用这个工作流做"，让**模型而不是代码**根据任务自主拉取能力。结合 `/skill:name` 手动命令，既是自动调度又是手动触发的统一入口。**

---

## 1. 问题：模型不应该预先知道所有细节

传统 tool-using 方案是：把你要的 tool 全塞进 system prompt 或 tools 列表，期望模型在合适时机调用。问题：

- 每多一个工具都在吃 context token，冷调用（用得少的）成本很高。
- 大工具通常需要"用法说明"，动辄几十上百字的 description，你没法同时塞 100 个。
- 同样一件事可以有多种做法（比如"部署到 AWS"有 20 种配置），硬编码成 tool description 会很快过时。

**Skill** 的解法是：skill 是一份**平常不加载**的文档，LLM **需要**时才把它的内容读进上下文。索引里只有 `name + description` 让模型判断"这个 skill 是我要的吗"。

这是 Agent Skills 标准（agentskills.io）的核心理念。pi 完整兼容这个标准。

---

## 2. Skill 的形态：一个目录 + 一个 Markdown

```
~/.pi/agent/skills/
├── aws-deploy/
│   ├── SKILL.md            ← 主文档
│   └── templates/
│       └── cloudformation.yaml
├── code-review/
│   └── SKILL.md
```

`SKILL.md` 格式（参考 pi 源代码和标准）：

```markdown
---
name: aws-deploy
description: |
  Deploy a Node.js service to AWS ECS Fargate using the templates in this skill.
  Triggers: when the user mentions "deploy to AWS", "ECS", "push to prod".
disable-model-invocation: false
---

# AWS ECS Fargate Deploy Skill

## Precondition checks
1. Run `aws sts get-caller-identity` to confirm AWS credentials.
2. Ensure Dockerfile at repo root.

## Steps
1. ...
```

### 2.1 Frontmatter 决定"能否被模型自动调用"

```ts
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  [key: string]: unknown;
}
```

- `name`：LLM 引用这个 skill 的 handle，`/skill:aws-deploy`。
- `description`：模型判定"这个 skill 是不是我要的"的唯一输入。
- `disable-model-invocation: true`：skill 不加入**自动**索引，只允许用户手动 `/skill:xxx`。

这条 flag 让"**危险或破坏性 skill**"可以保留，但模型自己不会瞎用。

### 2.2 长度限制写进代码里

```ts
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
```

skill 作者写超长了直接会在加载时报 diagnostic 拒绝。为什么严格？

- name 要塞进 slash command 和 LLM 会话。
- description 要和其他所有 skills 的 description 一起塞 system prompt。

如果不限制，一个用户写 10KB 的 description，system prompt 就爆了。**强约束是为了"多 skill 共存"的共性健康**。

---

## 3. 加载流程：discover + 按规则过滤

### 3.1 搜索路径（按优先级）

```
1. 命令行 --skill <path>         # 显式指定
2. `.pi/skills/**`                # 项目级
3. `.agents/skills/**`            # 项目级（agent skills 标准）
4. `cwd` 向上直到文件系统根的所有 `.pi/skills/` 和 `.agents/skills/`
5. `~/.pi/agent/skills/**`        # 全局
6. `~/.agents/skills/**`          # 全局
7. 已安装 pi 包中的 skills/ 目录  # 第三方
```

"自上而下"扫，每个目录作为一个 skill 候选。

### 3.2 .gitignore 兼容的过滤

```ts
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
```

搜索 skills 时，会遵守 skill 根目录（或父目录）里的 `.gitignore` / `.ignore`。这意味着你可以在项目 `.pi/skills/` 里放 WIP 的 skill，用 `.gitignore` 让它不被 commit 进仓库，但仍能被 pi 加载——或者反过来。

`prefixIgnorePattern` 处理把 ignore 规则相对化到 skill 根的 prefix 上——经典的"多级 gitignore 合并"的实现。

### 3.3 循环链接保护

用 `realpathSync` 解析符号链接，避免"skill 文件夹里有指回自己的链接"导致无限递归。

---

## 4. 运行时：description 进 system prompt，内容按需读

加载后生成的 Skill 索引大致长这样：

```
Available skills (invoke via `/skill:<name>` or request when appropriate):
- aws-deploy: Deploy a Node.js service to AWS ECS Fargate using ...
- code-review: Review code for bugs, security, performance. Trigger ...
- data-migration: Migrate PostgreSQL schema across environments. Use when ...
```

这段**拼进 system prompt**。模型就能在合适时机说：

```
I'll use the aws-deploy skill for this.

/skill:aws-deploy
```

pi 检测到这个"调用"，把 `SKILL.md` 的完整内容 read 进上下文，后续模型就能按 SKILL 里的 steps 执行。

### 4.1 手动 `/skill:name`

用户也可以直接在 editor 输入 `/skill:aws-deploy`。效果相同。

这是"**一个机制服务两种触发方式**"的典型：模型和用户都通过同一个 slash 表达式加载 skill，runtime 不用区分。

### 4.2 模型看到的是 skill 的 "目录" + skill 本身

skill 中的 `templates/cloudformation.yaml` 不会默认被加载。SKILL.md 里通常会有：

```markdown
Read templates/cloudformation.yaml before customizing.
```

模型跑起来时会用 `read` tool 去读那个相对路径。这是"**skill 主文档很小，辅助文件按需读**"的分层结构。让一个 skill 可以带很多资源但不会占用 system prompt。

---

## 5. `disable-model-invocation` 的价值

举例：

```markdown
---
name: wipe-database
description: Completely wipe the production database
disable-model-invocation: true
---
```

如果模型自动调用了 "wipe-database"，后果不堪设想。加这个 flag 之后：

- description 不进模型索引。
- 模型无法自己调起来。
- 用户手动 `/skill:wipe-database` 仍然可用。

这是一种细粒度的"**只允许人类触发**"机制，比整个禁用 skill 或做 permission popup 都优雅。

---

## 6. Skills 和 Prompts / Extensions 的分工

pi 里三个相似的概念：

| 资源 | 形态 | 触发 | 能做什么 |
| --- | --- | --- | --- |
| **Prompt template** | 纯 markdown | `/name` | 展开成一段用户消息 |
| **Skill** | 带 frontmatter 的 markdown 目录 | `/skill:name` 或模型自己 | 注入"指导 + 参考文件"，模型按工作流执行 |
| **Extension** | TypeScript 模块 | 自动 / 命令 / 事件 | 注册 tool / command / UI / 替换行为 |

三者按"需要代码的能力"从少到多排列。很多"能力"可以先用 Skill 实现（零代码），发现瓶颈再升级为 Extension（全代码）。

这是一个**能力升级阶梯**，用户可以按需选择，而不是一开始就掉进 Extension 的代码 rabbit hole。

---

## 7. 对比 MCP：pi 故意不做

pi README 的 Philosophy 里写道：

> **No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support.

这条哲学的核心论证（链接到作者的 blog）：

- MCP 让"tool 生态"走向"远程 server + 协议"的方向，但大多数 tool 只是"一段命令 + 说明书"。
- 用 Skill + `bash` tool 的组合，95% 的 MCP 能做的事都能做，而且不需要任何后台 server。
- 遇到真的需要 MCP 的场景（比如远程 AI 数据源），装一个提供 MCP 支持的 extension 即可。

这是对"用最轻量的手段解决最多问题"哲学的彻底贯彻。Skill 就是这个哲学的落地形式。

---

## 8. 可以直接带走的套路

1. **带 frontmatter 的 markdown 是"轻量能力"的最佳载体**：LLM 一眼能懂，用户一眼能改。
2. **索引（name + description）进 system prompt，内容按需读入**：极省 context。
3. **`disable-model-invocation` 做人机分权**：危险操作仍能存在但只人工触发。
4. **length 硬限制保护 system prompt 的健康**。
5. **搜索路径分层（CLI flag > 项目 > 全局 > 包）**：多级覆盖。
6. **.gitignore 兼容**：skill 目录内自动 respect ignore 规则。
7. **model 和 user 用同一个 slash 语法触发**：机制统一。
8. **Skill / Prompt / Extension 能力升级阶梯**：用户按需求成本选。
9. **用 skill 替代 MCP 的服务器模型**：用 markdown + CLI 解 90% 场景。

任何你在做的"可扩展 AI 助手 / chatbot 框架 / auto-agent 生态"都可以原样拿来。Skill 标准本身是社区驱动的开放标准，pi 的实现是一个非常好的参考。


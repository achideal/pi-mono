# 16 · JSONL 会话树 / 分支 / 压缩：单文件承载完整历史 + 按需投影

> 位置：`packages/coding-agent/src/core/session-manager.ts`、`compaction/compaction.ts`、`compaction/branch-summarization.ts`；docs/session.md
>
> 提炼点：**用追加写 JSONL + (id, parentId) 链式节点表示"对话树"，任意点都能当作分支起点。`/tree`、`/fork`、`/compact` 全部建立在同一份物理文件上——既保证崩溃安全又保留所有历史。**

---

## 1. 要解决什么

Agent session 有几个棘手的现实：

- 长对话可能 1MB+。不能每次加一条消息就整文件重写。
- 用户有时想"回到 5 条消息前再问一遍"（分支）。
- 会话可能压缩：老消息总结成摘要送给模型省 token，但**历史不能丢**。
- 崩溃 / Ctrl+C 不能导致最新几条消息丢失。

业内常见方案：一个 session 文件一个分支，复制一份开新分支。这种方案：

- 分支之间的历史无法 unified 查看。
- "压缩"=物理删除，不可逆。
- 同一个 run 也许要写多次 fsync 才稳。

pi-coding-agent 用"**只追加 JSONL + (id, parentId) 表示树**"把这些问题一次性解决。

---

## 2. 文件结构：header + append-only 条目

一份 session 文件是一个 JSONL：

```
{"type":"session","version":3,"id":"abc123","timestamp":"...","cwd":"/Users/.../myproj","parentSession":null}
{"type":"message","id":"a1","parentId":null,"timestamp":"...","message":{"role":"user","content":"hi"}}
{"type":"message","id":"a2","parentId":"a1","timestamp":"...","message":{"role":"assistant",...}}
{"type":"label","id":"a3","parentId":"a2","timestamp":"...","targetId":"a2","label":"first reply"}
{"type":"model_change","id":"a4","parentId":"a2","timestamp":"...","provider":"openai","modelId":"gpt-5-mini"}
{"type":"message","id":"a5","parentId":"a4","timestamp":"...","message":{"role":"user","content":"continue"}}
{"type":"compaction","id":"a6","parentId":"a5","timestamp":"...","summary":"...","firstKeptEntryId":"a4"}
{"type":"message","id":"a7","parentId":"a6","timestamp":"...","message":{"role":"assistant",...}}
...
```

关键属性：

- **每条都有 `id` 和 `parentId`**：id 是 8-hex 的唯一短 ID，parentId 指向上一条。这就构成了**反向链表 → 可重建树**。
- **append-only**：新增消息是 `appendFileSync(newLine)`，不改也不删老条目。
- **多种 entry 类型**：`message` / `thinking_level_change` / `model_change` / `compaction` / `branch_summary` / `custom` / `custom_message` / `label` / `session_info` 共 9 种。都共享 base：`{ type, id, parentId, timestamp }`。

### 2.1 为什么不是一颗 N-ary tree 显式存储

一颗树的 JSON 表达需要嵌套；append-only 就不可能。反过来用"每条记下自己的 parent"**存的是边，不是节点层级**，对 append 极其友好。需要时在内存里 `map.set(id, entry)` + 用 parentId 二次扫描就能重建树。

---

## 3. 分支的语义：同一文件内的多条路径

`/tree` 命令允许你选中任意旧条目 X 然后"继续"。当从 X 续时：

- 生成的新消息的 `parentId = X.id`（而不是上一条的 id）。
- 不删除 X 之后的任何现有条目。
- 从此这个 session 文件有两个叶子节点。

如果重复"回到 X 又继续"，就会有第三条分支。对文件来说**一直都是 append**。

查看时：

```ts
getTree(): SessionTreeNode {
  const byParent = new Map<string | null, SessionEntry[]>();
  for (const entry of this.entries) {
    const parentId = entry.parentId ?? null;
    (byParent.get(parentId) ?? byParent.set(parentId, []).get(parentId)!).push(entry);
  }
  return buildNode(null);  // 递归构建
}
```

"叶子"的概念：`leafId` 是当前活跃分支的末端条目 id。Agent 每次 append 都更新 leafId，LLM 看到的消息历史就是"从 leafId 反向追到 root 那条路径"。

### 3.1 `/fork`：把某条分支复制成新文件

和 `/tree` 不同，`/fork` 是把"从 root 到选中点"那条**线性路径**复制到一个新的 session 文件里。适合：

- 想和朋友分享一个"清晰"会话，不带其他分支的杂音。
- 想让某个分支独立演化，不受其他分支干扰。

两条命令在同一个文件抽象上组合出两种粒度，用户各取所需。

---

## 4. 崩溃安全：append-only + 每次 fsync 单行

看写入路径（简化）：

```ts
appendFileSync(filePath, JSON.stringify(entry) + "\n", { flag: "a" });
```

- `flag: "a"` 是 O_APPEND + O_SYNC 不一定同时。但多数场景"一行 JSONL 写出到 OS buffer → flush"是原子的。
- 单行 + 换行分隔 = 读取时哪怕最后一行被截断也只丢**最新一条**。前面的所有消息解析无损。
- `JSON.parse` 失败的行直接跳过（在 load 时做容错）。

这是"极简持久化"的胜利：不需要任何数据库，不需要任何事务，不需要复杂的 WAL。平台层的 append + `\n` 分隔就足够了。

---

## 5. 压缩（compaction）：只改"LLM 投影"，不改历史

压缩要解决的是 context window 超限：旧消息全部丢给 LLM 会 OOM。但 UI 和 session 文件里不能丢。pi 的做法：

### 5.1 压缩产生一条 `compaction` 条目

```ts
interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: "compaction";
  summary: string;            // LLM 生成的总结文本
  firstKeptEntryId: string;   // 从哪条开始"保留原文"
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}
```

- `summary` 是 LLM 总结出来的。
- `firstKeptEntryId` 指向"保留原文的起点"。这条之前的旧消息会被 summary **代替**送给 LLM。
- 老消息**没有被删除**。session 文件里仍然完整。`/tree` 随时能跳回去。

### 5.2 `buildSessionContext`：基于 compaction 做"LLM 视角投影"

大致逻辑：

```ts
1. 从当前 leafId 反向追溯到 root，得到有序 entry 列表 path[]。
2. 找到 path 里最后一个 compaction C。
3. 把 C.firstKeptEntryId 之前的 message entries 折叠成一条"system message: C.summary"。
4. C.firstKeptEntryId 之后的 message entries 按原文加入 LLM messages 数组。
5. 加上其他非 message entries（model_change 等）的效果（切换当前 model / thinking level）。
```

这样 LLM 只看见"摘要 + 最近 N 条"，而 UI 仍然能渲染完整历史，session 文件仍然保留一切可能的还原。

### 5.3 为什么压缩不是破坏性操作

README 写得直白：

> Compaction is lossy. The full history remains in the JSONL file; use `/tree` to revisit.

这就是"**content 是不可变的真源，压缩只是一个视图变换**"。一条哲学：**任何"这是给 LLM 看的上下文"都是对真源的投影，不要反过来让投影污染真源**。

---

## 6. Migration：文件版本升级也是 append

```ts
export const CURRENT_SESSION_VERSION = 3;

function migrateToCurrentVersion(entries: FileEntry[]): boolean {
  const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
  const version = header?.version ?? 1;
  if (version >= CURRENT_SESSION_VERSION) return false;

  if (version < 2) migrateV1ToV2(entries);
  if (version < 3) migrateV2ToV3(entries);
  ...
}
```

三条设计：

1. **Header entry 带 version 号**：一行 JSON 就能告诉我们老文件长什么样。
2. **Migration 函数是"从 N 到 N+1"的单步**：新版本叠加一步即可，不用重写整个 loader。
3. **V1→V2 是把隐式顺序升级为显式 `id/parentId`**：老格式没有 id，迁移时现场生成、线性链接。这样老 session 无痛兼容新代码。

这是"数据格式随需演化"的标准模式，很多数据库工具都在用。

---

## 7. 按 session 为单位的 `byId` map

SessionManager 启动时扫一遍所有 entries 构建：

```ts
const byId = new Map<string, SessionEntry>();
const byParent = new Map<string | null, SessionEntry[]>();
```

后续：

- `getEntry(id)`：O(1)
- `getBranch(id)`：从 id 反向追 parent，O(depth)
- `getTree()`：一次遍历 byParent 得到完整树

所以即使 session 几千条，全部操作都在内存里毫秒级。

---

## 8. 还有哪些 entry 是特殊的

- **label**：用户按 Shift+L 加书签。不影响 LLM 上下文，只影响 `/tree` 显示。用 `targetId` 指另一条。
- **session_info**：用户 `/name XXX` 改显示名。**通过 append 新条目覆盖旧值**（读取时取最后一个）—— 不改旧记录，保持 append-only 不变式。
- **branch_summary**：当你从历史某点分支继续时，可选地让扩展生成"分支间的差异摘要"，作为 `branch_summary` entry 记录下来。
- **custom / custom_message**：扩展专用（见第 17 篇）。

每种 entry 类型都是**只追加 + 最后一个生效**的语义。非常简单、非常稳。

---

## 9. 可以学走的设计要点

1. **文件结构 = header + append-only JSONL**：最简单、最抗崩溃的持久化。
2. **树用 `(id, parentId)` 表示 = 反向边集合**：和 append 完美兼容。
3. **分支 / fork 共用同一文件，只是 leafId 指哪**：不重复存任何历史。
4. **压缩不删数据**：写一条 summary entry 影响 LLM 投影。UI / session 仍是完整的。
5. **buildSessionContext 是一次"从 entries 到 LLM messages 的投影函数"**：和第 6 篇讲的 `convertToLlm` 精神一致。
6. **版本迁移 per-step**：header 带 version，迁移函数只管 n→n+1。
7. **session_info 用"新 entry 覆盖旧值"**：突破"append-only 无法修改"的限制，但仍不变本质。
8. **byId / byParent 两张 map**：一次 O(n) 扫描后所有查询 O(1) / O(depth)。

这套"append-only + id-parent + 视图投影"是**事件溯源（Event Sourcing）**在单机文件上的轻量落地。任何一个需要"完整历史 + 高速最新视图 + 不丢数据"的系统——本地笔记、任务跟踪、版本化配置、blockchain-like 记录——都值得借鉴这个架构。


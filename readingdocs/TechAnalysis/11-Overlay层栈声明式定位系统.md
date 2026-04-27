# 11 · Overlay 层栈声明式定位系统

> 位置：`packages/tui/src/tui.ts` 的 `showOverlay` / `OverlayOptions` / `resolveOverlayLayout` / `compositeOverlays` / `getTopmostVisibleOverlay`
>
> 提炼点：**用一个 `OverlayOptions` 声明式对象 + 一个带 focus 管理的层栈，就实现了终端里的模态框、下拉、悬浮菜单、状态条、气泡提示，还天然支持"终端太窄就自动隐藏"。**

---

## 1. 要解决的问题：终端里"盖在内容上"的 UI

pi 的 TUI 里有 `/settings`、`/tree`、`/model`、模型选择器、slash 命令菜单、IDE 提示框、skill 选择器、欢迎弹窗……全部都要在"已有滚动消息历史"之上**叠加**显示。而且：

- 要能被键盘**聚焦**，否则 editor 还会吃键盘输入。
- 能被层层嵌套（开了 `/model` 又开了 `/scoped-models`）。
- 终端缩窄 / 缩短时要能自动重新排版，甚至**自动隐藏**。
- 要能不捕获焦点地显示（比如"按 Esc 退出"的提示气泡）。

如果把这些全部做成普通 child，挡不住的键盘会被 editor 吃；做成 child 又要手动算自己该显示在第几行。
pi-tui 把这些都归入 `showOverlay(component, options)` 一条 API。

---

## 2. OverlayOptions：声明式、分层、可组合

```ts
export interface OverlayOptions {
  width?: SizeValue; minWidth?: number; maxHeight?: SizeValue;
  anchor?: OverlayAnchor; offsetX?: number; offsetY?: number;
  row?: SizeValue; col?: SizeValue;
  margin?: OverlayMargin | number;
  visible?: (termWidth, termHeight) => boolean;
  nonCapturing?: boolean;
}
```

几点极为值得学：

### 2.1 `SizeValue = number | "${number}%"`

```ts
function parseSizeValue(value: SizeValue | undefined, referenceSize: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const match = value.match(/^(\d+(?:\.\d+)?)%$/);
  if (match) return Math.floor((referenceSize * parseFloat(match[1])) / 100);
  return undefined;
}
```

一个字段既可以是绝对值也可以是百分比。CSS 的思路搬到了终端上，却只用了 10 行代码。这让 `width: "80%"` 这种表达自然成立，而且随 terminal resize 自动生效。

### 2.2 三种定位方式同时存在、有清晰的 resolution 顺序

按优先级从高到低：

1. `row`/`col` 绝对值（`number`）
2. `row`/`col` 百分比（`"50%"`）
3. `anchor` + `offsetX`/`offsetY`

解析代码：

```ts
if (opt.row !== undefined) {
  if (typeof opt.row === "string") {
    const match = opt.row.match(/^(\d+(?:\.\d+)?)%$/);
    if (match) {
      const maxRow = Math.max(0, availHeight - effectiveHeight);
      row = marginTop + Math.floor(maxRow * (parseFloat(match[1]) / 100));
    } else row = this.resolveAnchorRow("center", effectiveHeight, availHeight, marginTop);
  } else row = opt.row;
} else {
  const anchor = opt.anchor ?? "center";
  row = this.resolveAnchorRow(anchor, effectiveHeight, availHeight, marginTop);
}
```

三条路径互斥选择，一次算一次，代码直白。React/Web 里这种定位系统通常要引入 CSS 引擎；终端里一个函数搞定。

### 2.3 `margin` 可以是 number 或对象

`margin: 2` 自动展开为四边都是 2，`margin: { top: 1, right: 2 }` 就是各自指定。JS 里"允许 shorthand 和 longhand"是配置对象常见的宽容做法，用户写起来顺手，类型签名也简洁。

### 2.4 `visible(width, height) => boolean` 让响应式隐藏一等公民

```ts
private isOverlayVisible(entry): boolean {
  if (entry.hidden) return false;
  if (entry.options?.visible) return entry.options.visible(this.terminal.columns, this.terminal.rows);
  return true;
}
```

典型用法：`visible: (w) => w >= 100` —— 终端窄于 100 列时这个 overlay 完全不渲染、焦点自动让出。用户对着 `less` 风格的半屏终端不会炸。

### 2.5 `nonCapturing` 区分"UI 提示"和"模态"

- `nonCapturing: false`（默认）：显示时立刻自动 setFocus 到该 overlay。
- `nonCapturing: true`：overlay 显示但**不抢焦点**。比如右下角 "Press Esc" 提示、状态徽章。

一条布尔区分了 UI 组件里的两大类，也不需要用两种 API。

---

## 3. 层栈 + focusOrder：谁是"最上层"可能不等于"最后加入"

```ts
overlayStack: {
  component; options; preFocus; hidden: boolean; focusOrder: number;
}[];

showOverlay(component, options): OverlayHandle {
  const entry = { component, options, preFocus: this.focusedComponent, hidden: false, focusOrder: ++this.focusOrderCounter };
  this.overlayStack.push(entry);
  ...
}
```

每个 entry 带：

- **`preFocus`**：打开 overlay 前的焦点。关闭时恢复它，形成自然的"焦点栈"。
- **`focusOrder`**：单调递增的 counter。每次 `focus()` 会重新 `++` 让自己置顶。

合成时按 focusOrder 排序：

```ts
const visibleEntries = this.overlayStack.filter((e) => this.isOverlayVisible(e));
visibleEntries.sort((a, b) => a.focusOrder - b.focusOrder);
```

这意味着：**后创建的未必在最顶**，**用户按键切换焦点可以把老 overlay 顶到最上面**。这对"/tree 打开了，又打开了 /model，然后按 Tab 要回到 /tree"这种场景至关重要。

如果直接用"数组末尾 = 最顶"那种简单栈，切换焦点就得频繁增删数组，还要处理"中间被删掉之后索引变化"的问题。`focusOrder` 是最简洁的解法。

---

## 4. OverlayHandle：对外暴露的最小能力集合

```ts
export interface OverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
  isHidden(): boolean;
  focus(): void;
  unfocus(): void;
  isFocused(): boolean;
}
```

注意语义拆得很细：

- **`hide()`**：永久移除，`overlayStack.splice`，无法再显示。
- **`setHidden(true)`**：临时隐藏，保留在栈里，可以 `setHidden(false)` 恢复。
- **`focus()` / `unfocus()`**：切换焦点，focusOrder 会重排。
- **`isFocused()`**：查询当前是不是自己。

**所有状态变化都自动 `requestRender()`**。调用方不用手动"我改了显示状态，记得 rerender"。

这种 handle 对象替代"showXxx 返回 id，closeXxx(id)"的模式，在 API 可发现性、生命周期封闭性上都明显更好。

---

## 5. `compositeOverlays` 实现上的三道"脑力题"

前面第 9 篇讲过大意，这里拆三个 tricky 的细节：

### 5.1 `minLinesNeeded` vs `workingHeight`

```ts
const workingHeight = Math.max(result.length, termHeight, minLinesNeeded);
while (result.length < workingHeight) result.push("");
```

为什么不用 `maxLinesRendered`（历史最高水位）？
注释里写了：

> Excludes maxLinesRendered: the historical high-water mark caused self-reinforcing inflation that pushed content into scrollback on terminal widen.

一旦用历史水位当 padding，终端变宽时内容会"胀高"一点，下次再宽又胀一点，过几次 overlay 就被挤出视口。去掉这个依赖，每次仅按"本帧实际需要 + 终端高度 + overlay 占位需求"算。稳定。

### 5.2 预渲染两次：先算 width 再算 row/col

```ts
// 第一次：用 height=0 算 width 和 maxHeight
const { width, maxHeight } = this.resolveOverlayLayout(options, 0, termWidth, termHeight);
let overlayLines = component.render(width);
if (maxHeight !== undefined && overlayLines.length > maxHeight) overlayLines = overlayLines.slice(0, maxHeight);

// 第二次：用真实 overlayLines.length 算 row/col
const { row, col } = this.resolveOverlayLayout(options, overlayLines.length, termWidth, termHeight);
```

因为 overlay 的高度只有 render 之后才知道，而位置（尤其 anchor='bottom'）又依赖高度。分两次算是明确的权衡：render 可能并不廉价，但 layout 必须用精确高度否则位置会错。实测 render 相对便宜，两次足够。

### 5.3 最后 `compositeLineAt` 还做一次 `truncateToWidth`

```ts
const truncatedOverlayLine = visibleWidth(overlayLines[i]) > w ? sliceByColumn(overlayLines[i], 0, w, true) : overlayLines[i];
```

即使组件声称 render 的每行不超过 width，这里仍然兜底截断。多一份保险几乎零成本，换掉一整个崩溃链。前面第 9 篇讲过宽行会让差分逻辑塌陷，这一步是最后防线。

---

## 6. 焦点转移的"优雅"细节

很多 UI 库写焦点都错得很离谱。pi-tui 做了几件值得圈重点的事：

```ts
hide: () => {
  const index = this.overlayStack.indexOf(entry);
  if (index !== -1) {
    this.overlayStack.splice(index, 1);
    if (this.focusedComponent === component) {
      const topVisible = this.getTopmostVisibleOverlay();
      this.setFocus(topVisible?.component ?? entry.preFocus);
    }
    if (this.overlayStack.length === 0) this.terminal.hideCursor();
    this.requestRender();
  }
}
```

- **关闭 A，焦点不是 A**：不动焦点（可能你关闭的是后台 overlay）。
- **关闭 A，焦点是 A**：优先给下一个 visible capturing overlay，没有就给 `preFocus`（你最初打开 A 之前的焦点）。
- **栈清空**：显式 hideCursor（清屏 + 硬件光标不再被更新）。

还有：

```ts
const focusedOverlay = this.overlayStack.find((o) => o.component === this.focusedComponent);
if (focusedOverlay && !this.isOverlayVisible(focusedOverlay)) {
  const topVisible = this.getTopmostVisibleOverlay();
  this.setFocus(topVisible?.component ?? focusedOverlay.preFocus);
}
```

在 `handleInput` 里每次检查"当前焦点的 overlay 还可见吗"。因为 `visible(w, h)` 回调可能因为终端 resize 突然变 false，此时必须把焦点让出去。否则用户打字被一个"看不见的 overlay"吃掉。

这一条设计是 UI 库里非常容易漏的一种"unsynced state"，直到用户按多次 Tab 都没反应才被发现。在 TUI 里预先处理掉。

---

## 7. 可以直接借走的套路

1. **SizeValue = number | "${n}%" + 一个 `parseSizeValue` 工具函数**：让所有尺寸字段自然响应式。
2. **定位分层：absolute > percentage > anchor**，每一层 default 回到下一层。
3. **margin 同时接受 number 和对象**：极佳用户体验。
4. **`visible` 回调让 overlay "条件渲染"成为一等特性**：响应式 UI 免费。
5. **`nonCapturing` 拆出"不抢焦点的提示层"**：同一 API 覆盖模态与提示。
6. **focusOrder 而非栈顶表示 z-order**：允许用户切焦点把旧层抬上来。
7. **Handle 对象作为 overlay 生命周期的单点访问**：比 id + closeById 易用。
8. **每次 input 都重新校验焦点有效性**：防 visible 回调 desync 带来的"键盘黑洞"。

你在做 React / Web / RN / 任何 UI 框架的"悬浮层"功能时，这 8 条都能直接落地。


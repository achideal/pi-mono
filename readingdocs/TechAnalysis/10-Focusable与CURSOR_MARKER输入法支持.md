# 10 · Focusable + CURSOR_MARKER：让 CJK 输入法候选窗在正确位置

> 位置：`packages/tui/src/tui.ts` 中 `CURSOR_MARKER` / `Focusable` / `isFocusable`、`extractCursorPosition`、`positionHardwareCursor`；`editor-component.ts` 的 render 里 marker 放置
>
> 提炼点：**一个 7 字节的零宽 APC 转义序列 + 渲染后单次扫描，解决了"TUI 用伪光标（反色单元格）美观 + IME 候选窗需要真光标"的根本冲突。**

---

## 1. TUI 光标的天然矛盾

终端里画光标有两种姿势：

1. **硬件光标**：终端自己维护的那个"真光标"。只能在一个位置。它闪不闪、什么形状、颜色都由终端决定。
2. **伪光标**：自己在某个字符上写 `\x1b[7m` 反色/下划线表示"光标在这"。框架可以完全控制样式，想闪就闪，想粗就粗。

绝大多数现代 TUI 都选择伪光标——因为硬件光标不够可控，而且伪光标可以一次渲染多个（多选、多块文本同时指示）。

但有一件事**伪光标完全做不到**：**告诉操作系统"我在哪"**。这是 IME（Input Method Editor，输入法）正常工作的前提：

- 你在 Editor 里打中文/日文/韩文。
- 系统弹出"候选窗"来给你选字。
- 候选窗必须出现在**光标正下方**。
- 系统询问终端"硬件光标在哪？"——要是你一直把硬件光标藏着或停在 (0,0)，候选窗就永远在左上角。

对 CJK 用户来说这不是小瑕疵，是直接不可用。pi-tui 的解法是：
**保持伪光标的美观 + 同时同步更新硬件光标位置用于 IME**。

---

## 2. Focusable 接口：谁需要硬件光标

```ts
export interface Focusable {
  focused: boolean;   // 由 TUI 写
}

export function isFocusable(component: Component | null): component is Component & Focusable {
  return component !== null && "focused" in component;
}

export const CURSOR_MARKER = "\x1b_pi:c\x07";
```

几个关键点：

### 2.1 Focusable 只有**一个字段**

语义上 `focused` 是 TUI 写给组件的"你现在有没有焦点"。组件可以根据它切换是否 emit marker。默认 `Container` 没有这个字段 → `isFocusable` 返回 false → TUI 就不在它的 render 里找光标。

这让"需要硬件光标的组件"成为 **opt-in** 而不是默认承担。普通 Text / SelectList / Markdown 组件完全不用管。

### 2.2 CURSOR_MARKER 是合法的 APC 转义

```
\x1b _ pi:c \x07
```

- `\x1b _` 是 APC（Application Program Command）起始符。
- `\x07` 是 BEL，在这里用作 APC 终止（终端实际采用 BEL 或 ST 均可）。
- 中间是自定义 payload `pi:c`（pi 的光标）。

APC 序列**所有终端都会解析但并不显示**，所以它像一个零宽的隐形锚点。

为什么要带 `pi:c` 这个独特 payload？因为终端上的其他程序、其他库也可能用 APC。加上自己的命名空间后，这条序列：

- 不会被真实的 TUI 输出误认。
- 如果另一个组件也有自己的 marker，也能共存。

这个小细节体现了"在公共协议里写自定义扩展要带命名空间"的工程纪律。

### 2.3 Container 要向子组件透传 `focused`

README 里写得很明白：如果你的 Dialog 里有一个 Editor，dialog 要实现 Focusable 并 setter 里把 child.focused = value 同步传下去。否则 TUI 只会把 focused 设到 Dialog 上，Dialog 自己 render 不含光标，用户打 IME 还是乱飘。

```ts
class SearchDialog extends Container implements Focusable {
  private _focused = false;
  get focused() { return this._focused; }
  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;  // 关键：传给实际 emit marker 的子组件
  }
}
```

这是"哪个组件实际绘光标"和"哪个组件有焦点"的分离。分离之后，各种嵌套容器都能正常工作。

---

## 3. 在组件内如何 emit marker

README 示范：

```ts
render(width: number): string[] {
  const marker = this.focused ? CURSOR_MARKER : "";
  return [`> ${beforeCursor}${marker}\x1b[7m${atCursor}\x1b[27m${afterCursor}`];
}
```

- **marker 紧挨伪光标之前**：这样 IME 候选窗就出现在伪光标旁边。
- `\x1b[7m...\x1b[27m` 是伪光标（反色），**用户看到的那格**。
- `marker` 是零宽度的，不改变视觉长度，完全不影响 `visibleWidth`。

这种"marker 作为 render output 的一部分"的写法有两个巨大优势：

1. **组件**仍然只管"输出一行字符串"，不需要和 TUI 对话。
2. 光标位置**自动跟随**内容的滚动、过滤、换行。没有任何额外同步代码。

---

## 4. TUI 侧：一次扫描提取位置，然后移除 marker

```ts
private extractCursorPosition(lines: string[], height: number): { row: number; col: number } | null {
  const viewportTop = Math.max(0, lines.length - height);
  for (let row = lines.length - 1; row >= viewportTop; row--) {
    const line = lines[row];
    const markerIndex = line.indexOf(CURSOR_MARKER);
    if (markerIndex !== -1) {
      const beforeMarker = line.slice(0, markerIndex);
      const col = visibleWidth(beforeMarker);
      lines[row] = line.slice(0, markerIndex) + line.slice(markerIndex + CURSOR_MARKER.length);
      return { row, col };
    }
  }
  return null;
}
```

三点精妙：

### 4.1 **从下往上**只扫可见区

- 可见区域的底部几行最有可能包含 editor（因为输入框通常在屏幕底部）。
- 只扫 `viewportTop` 之后的行，避免历史内容里偶然出现同样的序列（不太可能，但算法上安全）。

### 4.2 col 用 `visibleWidth` 计算

marker 前的字符串里可能有：

- ANSI 颜色 / 样式（如 `\x1b[32m`）→ 不占宽
- CJK 宽字符 → 占 2 列
- 零宽字符 → 占 0 列

`visibleWidth` 在 `utils.ts` 里用 East Asian Width 规则处理这些，确保 col 是**终端视觉列**，不是字符串 index。这是硬件光标能对上 IME 的前提。

### 4.3 马上 strip 掉 marker

把 marker 从字符串切除，后续：

- diff 对比时看到的"新行"已经不含 marker。
- 写入终端的内容不含 marker（虽然 APC 无害，但省得多几字节）。
- 相邻两帧如果内容完全一样（只是光标没动），diff 也不会把这行标为 changed。

---

## 5. `positionHardwareCursor`：把真光标移到提取的位置

```ts
private positionHardwareCursor(cursorPos: { row: number; col: number } | null, totalLines: number): void {
  if (!cursorPos || totalLines <= 0) { this.terminal.hideCursor(); return; }
  const targetRow = Math.max(0, Math.min(cursorPos.row, totalLines - 1));
  const targetCol = Math.max(0, cursorPos.col);

  const rowDelta = targetRow - this.hardwareCursorRow;
  let buffer = "";
  if (rowDelta > 0) buffer += `\x1b[${rowDelta}B`;
  else if (rowDelta < 0) buffer += `\x1b[${-rowDelta}A`;
  buffer += `\x1b[${targetCol + 1}G`;   // 移到绝对列（1-indexed）

  if (buffer) this.terminal.write(buffer);
  this.hardwareCursorRow = targetRow;
  if (this.showHardwareCursor) this.terminal.showCursor();
  else this.terminal.hideCursor();
}
```

注意几件事：

- `\x1b[${n}B` / `\x1b[${n}A` 是"向下/向上移 n 行"；`\x1b[${col+1}G` 是移到绝对列。两者结合做相对-绝对的混合移动，不会受屏幕滚动影响。
- **默认硬件光标保持隐藏**（`showHardwareCursor = false`）。IME 不需要光标可见，它只需要光标"在正确位置"。这样既不露出闪烁的光标（用户全靠伪光标感知），又让 IME 开心。
- 环境变量 `PI_HARDWARE_CURSOR=1` 能把硬件光标显示出来，用于调试"伪光标和硬件光标对得齐不齐"。

### 5.1 没 marker 时显式 `hideCursor`

```ts
if (!cursorPos || totalLines <= 0) { this.terminal.hideCursor(); return; }
```

当前帧没人 emit marker → 说明没有焦点输入组件 → 硬件光标应该消失。这条关闭让"从 Editor 切走焦点时硬件光标还留在原处"的 bug 根本不会发生。

---

## 6. 和差分渲染怎么协作

`doRender` 的顺序（第 9 篇讲过一半，这里补完）：

```
1. child.render() → 原始 string[]
2. compositeOverlays()  → 叠加模态层
3. extractCursorPosition() → 扫 marker，得 (row, col)，并从 lines 里移除
4. applyLineResets()   → 给每行末尾补 SGR reset
5. 差分写出
6. positionHardwareCursor()  → 最后一步把真光标放好
```

这个顺序有几个关键保证：

- **overlay 盖住了 marker 怎么办**：`extractCursorPosition` 在合成之后扫，如果 overlay 把 marker 的那几列覆盖了，扫不到 → 自动隐藏硬件光标。IME 无处显示，但不会错位。
- **marker 不参与 diff**：提取后 lines 是"干净"的，相邻两帧仅光标移动不会被 diff 判为变化。只有光标位置不同、硬件光标被重新定位。这让"光标移动"变成零成本操作。
- **光标定位总在 buffer 输出之后**：如果你反过来——先定位光标、再写内容——渲染时终端会把内容写到你刚放的位置，光标立刻漂走。顺序错一行，整个交互都会塌。

---

## 7. 可以直接带走的套路

1. **自定义 APC 序列做零宽锚点**：`\x1b _ {ns}:{payload} \x07` 既符合终端协议又不占显示。
2. **opt-in Focusable 接口**：不需要硬件光标的组件零负担。
3. **marker 由组件 emit、TUI 统一提取**：组件不需要知道自己在屏幕上哪一行。
4. **`visibleWidth` 配合 marker 前的字符串**：精确算出终端视觉列。
5. **提取后立刻从 lines 里移除 marker**：不污染 diff，不污染终端输出。
6. **没 marker → 隐藏硬件光标**：没有"光标飘在上次位置"的 bug。
7. **渲染顺序：render → overlay → extract cursor → diff → position cursor**：顺序错了就全错。
8. **Container 透传 `focused` 给子组件**：嵌套 UI 才能正常 IME。

这条设计几乎专门为 CJK 用户体验存在，但手段（"自定义转义标记 + 渲染后单次提取 + 元信息副通道"）在任何"渲染产物里需要携带额外位置元数据"的系统都通用——HTML diff 里的 DOM 节点 data-attr、PDF render pipeline 里的 anchor 追踪都能用。


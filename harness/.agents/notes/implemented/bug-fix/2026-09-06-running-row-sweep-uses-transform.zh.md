# Agent Note: Running-row glare travels on transform, not left

Status: implemented

[English](2026-09-06-running-row-sweep-uses-transform.md) | 中文

## Problem

DeepSeek Harness Desktop 的 WKWebView 会话在普通 Chat 使用几分钟后就会把整机拖进 swap。`com.apple.WebKit.WebContent` 单核占用 65–90%，物理占用 2–3.5 GB，而 Node 宿主几乎空闲。对渲染进程采样显示主线程每帧都在 `timerFired` → `RemoteLayerTreeDrawingArea::updateRendering` → `Page::layoutIfNeeded` → 递归的 `RenderBlock` / `RenderFlexibleBox` layout。

Chat 把 `order` 里的每个 Node 都挂上（`ChatView` 没有虚拟化）。一轮还在跑时，若干行会画一条无限扫光。这条光带把 `left` 从 `-300px` 动画到 `100%`。inset 几何是 layout 属性：WebKit 每帧弄脏包含块，再走完整棵未虚拟化的对话树。同一套 `left` 关键帧出现在 ToolRow、bash sample 行、GenericCommandCard、ReasoningRow 和 SkillRow。

## Decision

运行中行的扫光改为 `transform: translateX(...)`，并带 `will-change: transform`。覆盖层仍从 `left: 0; width: 300px` 起步，只有位移走合成器（`-100%` → `100vw`）。ToolRow 与 bash sample 在 `prefers-reduced-motion` 下关掉动画，与另外三张表一致。Chat 的 flow item 声明 `contain: layout`，即使以后有人再把 layout 属性写回动画，子树也无法弄脏整段 transcript。

拥有旧 `left` 关键帧的五张表就是全集：`ToolRow.module.css`、`bash-sample.module.css`、`GenericCommandCard.module.css`、`ReasoningRow.module.css` 和 `SkillRow.module.css`。

## Alternatives considered

**先给 Chat 做虚拟化，再动动画。** ChatView 已经把虚拟化写成最终测量单位，长对话的 DOM 上限仍该走那条路。它解释不了只有几十行工具调用时的 60 fps layout 风暴：渲染器每帧变脏是因为 `left`，不是因为节点数本身。虚拟化是另一项改动，长 transcript 仍然需要。

**直接在行上动画 `background-position`。** TurnStatus 的 shimmer 就是这样，也能离开 layout 树。扫光被否决：视觉是一条 300px 覆盖层，经过时要洗过图标和标题，文字节点的背景做不到。

**保留 `left`，只加 `contain: strict`。** 包含可以缩小脏区，但挡不住 WebKit 每秒六十次给这一行的 flex 做 layout，也修不了复制了同一套关键帧的另外四张表。

## Consequences

- 运行中的轮次仍显示同一条扫光；运动路径只走合成器，WKWebView 不再被动画定时器调度整树 layout。
- `100vw` 相对视口，极宽窗口里光带行程比旧的 `left: 100%`（相对行宽）略长。覆盖层被行上的 `overflow: hidden` 裁切，多出来的行程不可见。
- Chat 虚拟化仍未落地。挂着数千 Node 的超长会话仍会涨 JS 堆和 DOM；本改动只去掉每帧 layout 放大器。
- ui-tool、ui-conversation、ui-skill 的 CSS 文本规格会拒绝扫光 `@keyframes` 里再出现 `left`。

## Testing

`packages/client/ui-tool/tests/tool-row-styles.client.spec.ts` 读取 ToolRow 与 bash-sample 表，断言每套扫光 `@keyframes` 正文含 `transform: translateX` 且不含 `left`。`packages/client/ui-conversation/tests/running-sweep-styles.client.spec.ts` 对 GenericCommandCard 和 ReasoningRow 做同样断言。`packages/client/ui-skill/tests/skill-row-sweep-styles.client.spec.ts` 覆盖 SkillRow。这些是声明测试，因为 jsdom 没有 WebKit layout；它们钉住的是采样里 `layoutIfNeeded` 风暴的那个属性。

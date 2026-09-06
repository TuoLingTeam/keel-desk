# Agent Note: Chat windows long transcripts and caps tool output

Status: implemented

[English](2026-09-06-chat-windowing-and-output-caps.md) | 中文

## Problem

Chat 把加载窗口里的每个 Node 都挂上（`order.map` → `ChatNodeSeat`）。Trajectory 在超过 100 行后已经虚拟化；Chat 没有。带几十行工具调用再加长 bash/read 输出的会话，会把整段 transcript 留在 WKWebView 的 layout 树里。再叠上运行中行的扫光（已在[transform 扫光](2026-09-06-running-row-sweep-uses-transform.md)修掉），这棵树每帧都被走一遍。同一条路上还有两个放大器：聊天行的 `TerminalBlock` 用 `maxLines={Infinity}`，长命令会画出每一行输出；`highlightToHtml` / `highlightLines` 会对任意长度的 fence 做出一整棵 Shiki span 树。

## Decision

ChatView 在 `order.length` 超过 40 后用 `@tanstack/react-virtual` 窗口化已加载的 order。虚拟列表是相对定位宿主，测过的行绝对偏移；查找（`ChatNav` 的 `onFindActiveChange`）会重新挂上整窗，让现有 DOM 扫描器仍能看见每个已加载 Node。跳转列表在 DOM 查找前先 `scrollToIndex`。逻辑行数发布为 `data-chat-row-count`，滚动 e2e 不必再数已挂载的 seat。

聊天行终端正文使用 `CHAT_TERMINAL_MAX_LINES = 8`，与 read/diff/search 的聊天上限一致。详情面板仍用原语默认值（16）。`highlightToHtml` 和 `highlightLines` 跳过长于 `HIGHLIGHT_MAX_CHARS`（32_768）的源，走纯文本回退；复制仍用原始源。

## Alternatives considered

**从第一行就开始虚拟化。** 否决：短 transcript（jsdom 的 ChatView fixture、一轮会话）会为没有上限收益去付绝对定位和估算高度。40 行阈值让这些路径仍走普通 flex 流。

**聊天行继续 `maxLines={Infinity}`，只在 CSS 里裁。** 否决：`overflow` 只裁绘制，挡不住 TerminalBlock 把每一行 ANSI 建进 React 树。

**大 fence 异步分词。** 这次不做：预算已经是同步 miss（`undefined` → 纯 `<pre>`），与未知语言同一条路。worker 高亮是另一份架构说明。

## Consequences

- 48 行的已加载窗口不再挂 48 个 ChatNodeSeat；overscan 仍保住可视切片和邻居。
- 超大窗口上查找会变慢，因为它会关掉虚拟化来扫描。这是复用 `collectMatches`、不做第二套索引的代价。
- Chat 里的长 bash 输出收成 8 行头尾加展开；详情面板仍是 16 行原语上限。
- 4 万字符的 TypeScript fence 会以纯文本渲染，直到源低于预算。

## Testing

`packages/client/ui-conversation/tests/chat-view.client.spec.tsx` 渲染 48 个 user 节点，断言 `data-chat-row-count="48"` 且已挂载的 `[data-chat-flow-key]` 更少。`packages/client/ui-tool/tests/terminal-card.client.spec.tsx` 钉住 `CHAT_TERMINAL_MAX_LINES < 16`。`packages/client/ui-primitives/tests/code-block.client.spec.tsx` 断言超预算时 `highlightToHtml` 返回 undefined。`apps/web/tests/chat-scroll-contract.e2e.ts` 用 `data-chat-row-count` 看翻页增长，并在断言第 1 轮标记前滚到历史起点。

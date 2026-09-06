# Agent Note: Chat windows long transcripts and caps tool output

Status: implemented

English | [中文](2026-09-06-chat-windowing-and-output-caps.zh.md)

## Problem

Chat mounted every Node in the loaded window (`order.map` → `ChatNodeSeat`). Trajectory already virtualized past 100 rows; Chat did not. A session with tens of tool rows plus long bash/read output therefore kept the whole transcript in the WKWebView layout tree. Combined with the running-row glare (fixed in [the transform sweep](2026-09-06-running-row-sweep-uses-transform.md)), that tree was walked every frame. Two further amplifiers sat on the same path: chat-row `TerminalBlock` used `maxLines={Infinity}`, so a long command painted every output line, and `highlightToHtml` / `highlightLines` tokenized fences of any length into a Shiki span tree.

## Decision

ChatView windows the loaded order with `@tanstack/react-virtual` once `order.length` exceeds 40. The virtual list is a relatively positioned host whose measured rows are absolutely offset; find-in-page (`ChatNav` `onFindActiveChange`) remounts the full window so the existing DOM scanner still sees every loaded Node. Jump-list reveal calls `scrollToIndex` before the DOM lookup. Logical row count is published as `data-chat-row-count` so scroll e2e can assert paging without counting mounted seats.

Chat-row terminal bodies use `CHAT_TERMINAL_MAX_LINES = 8`, matching the read/diff/search chat caps. The details panel keeps the primitive default (16). `highlightToHtml` and `highlightLines` skip sources longer than `HIGHLIGHT_MAX_CHARS` (32_768) and return the plain fallback; copy still uses the original source.

## Alternatives considered

**Virtualize from the first row.** Rejected: short transcripts (the jsdom ChatView fixture, a one-turn session) would pay absolute positioning and estimated heights for no bound. The 40-row threshold keeps those paths as ordinary flex flow.

**Keep `maxLines={Infinity}` on the chat row and cap only in CSS.** Rejected: `overflow` clips paint, it does not stop TerminalBlock from building every ANSI line into the React tree.

**Tokenize large fences asynchronously.** Rejected for this change: the budget already exists as a synchronous miss (`undefined` → plain `<pre>`), which is the same path unknown languages take. A worker highlighter is a separate architecture note.

## Consequences

- A 48-row loaded window no longer mounts 48 ChatNodeSeats; overscan still keeps the visible slice plus neighbors.
- Find-in-page is slower on a huge window because it turns virtualization off for the scan. That is the cost of reusing `collectMatches` without a second index.
- Long bash output in Chat collapses to an 8-line head/tail with an expand control; the details panel still shows the 16-line primitive cap.
- A 40k-character TypeScript fence renders as plain text until the source shrinks below the budget.

## Testing

`packages/client/ui-conversation/tests/chat-view.client.spec.tsx` renders 48 user nodes and asserts `data-chat-row-count="48"` with fewer mounted `[data-chat-flow-key]` seats. `packages/client/ui-tool/tests/terminal-card.client.spec.tsx` pins `CHAT_TERMINAL_MAX_LINES < 16`. `packages/client/ui-primitives/tests/code-block.client.spec.tsx` asserts `highlightToHtml` returns undefined over the budget. `apps/web/tests/chat-scroll-contract.e2e.ts` reads `data-chat-row-count` for paging growth and scrolls to history start before asserting turn-1's marker.

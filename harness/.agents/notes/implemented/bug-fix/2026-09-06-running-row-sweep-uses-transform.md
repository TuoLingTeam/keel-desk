# Agent Note: Running-row glare travels on transform, not left

Status: implemented

English | [中文](2026-09-06-running-row-sweep-uses-transform.zh.md)

## Problem

A live WKWebView session of DeepSeek Harness Desktop kept the machine swapping after a few minutes of ordinary Chat use. `com.apple.WebKit.WebContent` sat at 65–90% of one core with a 2–3.5 GB physical footprint while the Node host was idle. Sampling the renderer showed the main thread in `timerFired` → `RemoteLayerTreeDrawingArea::updateRendering` → `Page::layoutIfNeeded` → recursive `RenderBlock` / `RenderFlexibleBox` layout on every display refresh.

Chat mounts every Node in `order` (`ChatView` has no virtualizer). While a turn is running, several rows paint an infinite glare band. That band animated `left` from `-300px` to `100%`. Inset geometry is a layout property: WebKit dirties the containing block every frame and then walks the whole unvirtualized transcript. The same `left` keyframes lived on ToolRow, the bash sample row, GenericCommandCard, ReasoningRow, and SkillRow.

## Decision

Running-row glare animates `transform: translateX(...)` with `will-change: transform`. The overlay still starts at `left: 0; width: 300px`; only the travel is a compositor transform (`-100%` → `100vw`). ToolRow and the bash sample also drop the animation under `prefers-reduced-motion`, matching the other three sheets. Chat flow items declare `contain: layout` so a descendant animation cannot dirty-layout the whole transcript even if a future sheet reintroduces a layout property.

The five sheets that owned the old `left` keyframes are the complete set: `ToolRow.module.css`, `bash-sample.module.css`, `GenericCommandCard.module.css`, `ReasoningRow.module.css`, and `SkillRow.module.css`.

## Alternatives considered

**Virtualize Chat before touching the animation.** ChatView already documents a virtualizer as the eventual measurement unit, and that remains the right long-term bound on DOM size. It does not explain a 60 fps layout storm on a session with tens of tool rows: the renderer was dirty every frame because of `left`, not because of node count alone. Virtualization is a separate change and still needed for long transcripts.

**Animate `background-position` on the row itself.** That is how TurnStatus shimmers, and it would also stay off the layout tree. Rejected for the glare band: the visual is a 300px overlay that must wash icon and title as it passes, which a background on the text node cannot do.

**Leave `left` and add `contain: strict` only.** Containment would shrink the dirty region. It would not stop WebKit from laying out the row's own flex line sixty times a second, and it would not fix the four sibling sheets that copy the same keyframes.

## Consequences

- A running turn still shows the same glare; the motion path is compositor-only, so WKWebView no longer schedules full-tree layout from the animation timer.
- `100vw` is viewport-relative, so a very wide window travels the band slightly farther than the old `left: 100%` (percentage of the row). The overlay is clipped by `overflow: hidden` on the row, so the extra travel is invisible.
- Chat virtualization is still absent. A multi-hour session with thousands of mounted Nodes can still grow JS heap and DOM; this change only removes the per-frame layout amplifier.
- CSS-text specs in ui-tool, ui-conversation, and ui-skill reject a regression to `left` inside the sweep `@keyframes`.

## Testing

`packages/client/ui-tool/tests/tool-row-styles.client.spec.ts` reads ToolRow and bash-sample sheets and asserts each sweep `@keyframes` body contains `transform: translateX` and no `left`. `packages/client/ui-conversation/tests/running-sweep-styles.client.spec.ts` does the same for GenericCommandCard and ReasoningRow. `packages/client/ui-skill/tests/skill-row-sweep-styles.client.spec.ts` covers SkillRow. These are declaration tests because jsdom has no WebKit layout; they pin the property that caused the sampled `layoutIfNeeded` storm.

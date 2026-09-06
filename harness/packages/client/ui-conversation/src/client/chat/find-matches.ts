// In-transcript find: collect case-insensitive text-node ranges under the
// message column and paint them with the CSS Custom Highlight API, which
// styles Ranges without mutating the DOM — so React never fights the marks and
// streaming re-renders cannot orphan a wrapper element. Where the API is
// absent (older WebKit) collection and navigation still work; only the paint is
// skipped, so the caller keeps scrolling to the live match either way.

/** One highlight name shared process-wide; a second name paints the active hit. */
const ALL_HIGHLIGHT = 'dsh-chat-find'
const CURRENT_HIGHLIGHT = 'dsh-chat-find-current'

interface HighlightRegistry {
  set: (name: string, highlight: unknown) => void
  delete: (name: string) => void
}

type HighlightConstructor = new (...ranges: Range[]) => unknown

/** The registry, or null when this engine ships no Custom Highlight API. */
function registry(): HighlightRegistry | null {
  if (typeof CSS === 'undefined') return null
  const owner = CSS as unknown as { highlights?: HighlightRegistry }
  return owner.highlights ?? null
}

/** The `Highlight` constructor, or null when unsupported. */
function highlightCtor(): HighlightConstructor | null {
  return (globalThis as { Highlight?: HighlightConstructor }).Highlight ?? null
}

/**
 * Every case-insensitive occurrence of `query` under `root`, in document order.
 * Matches never span element boundaries — the ordinary find-in-page contract —
 * and text inside the nav chrome itself (`[data-chat-nav]`) is excluded so the
 * search box never finds its own echo.
 * @param root - the message column to scan.
 * @param query - raw query; empty or whitespace yields no matches.
 * @returns one Range per occurrence.
 */
export function collectMatches(root: HTMLElement, query: string): Range[] {
  const needle = query.toLowerCase()
  if (needle.length === 0) return []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node): number {
      const value = node.nodeValue
      if (value === null || value.length === 0) return NodeFilter.FILTER_REJECT
      const parent = node.parentElement
      if (parent === null) return NodeFilter.FILTER_REJECT
      if (parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE') return NodeFilter.FILTER_REJECT
      if (parent.closest('[data-chat-nav]') !== null) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    },
  })
  const ranges: Range[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const haystack = (node.nodeValue ?? '').toLowerCase()
    let from = 0
    for (;;) {
      const at = haystack.indexOf(needle, from)
      if (at === -1) break
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + needle.length)
      ranges.push(range)
      from = at + needle.length
    }
  }
  return ranges
}

/**
 * Paint all matches, with the active one in its own highlight so CSS can give
 * it a stronger colour. No-op without the Custom Highlight API.
 * @param ranges - all matches in document order.
 * @param current - index of the active match, or -1 for none.
 */
export function paintMatches(ranges: readonly Range[], current: number): void {
  const highlights = registry()
  const Ctor = highlightCtor()
  if (highlights === null || Ctor === null) return
  const others = ranges.filter((_, index) => index !== current)
  highlights.set(ALL_HIGHLIGHT, new Ctor(...others))
  const active = ranges[current]
  if (active === undefined) highlights.delete(CURRENT_HIGHLIGHT)
  else highlights.set(CURRENT_HIGHLIGHT, new Ctor(active))
}

/** Drop both highlights; safe to call when the API is absent. */
export function clearMatches(): void {
  const highlights = registry()
  if (highlights === null) return
  highlights.delete(ALL_HIGHLIGHT)
  highlights.delete(CURRENT_HIGHLIGHT)
}

/**
 * The match nearest the top of the scrollport — the least jarring landing when
 * a query first resolves, since it keeps the reader where they already are
 * instead of snapping to the top of the transcript.
 * @param ranges - matches in document order.
 * @param scrollport - the resolved scroll container.
 * @returns an index into `ranges`, or 0 when none sit at/below the fold.
 */
export function nearestMatchIndex(ranges: readonly Range[], scrollport: HTMLElement): number {
  const top = scrollport.getBoundingClientRect().top
  for (let index = 0; index < ranges.length; index += 1) {
    const range = ranges[index]
    if (range !== undefined && range.getBoundingClientRect().bottom >= top) return index
  }
  return 0
}

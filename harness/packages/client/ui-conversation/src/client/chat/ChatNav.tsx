// ChatNav: the in-transcript navigation band — find-in-page (Cmd/Ctrl+F) and a
// jump list of every message the reader sent. It floats in a zero-height sticky
// slot at the top of the scrollport and never enters the message flow, so the
// column's own layout and the find scanner (which reads only the column) are
// untouched. Highlighting rides the CSS Custom Highlight API; scrolling targets
// the resolved scrollport the way ChatView's own paging anchors do.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RefObject } from 'react'
import {
  IconChecklistOutline14, IconChevronDownOutline14, IconChevronUpOutline14,
  IconCloseOutline16, IconSearchOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { clearMatches, collectMatches, nearestMatchIndex, paintMatches } from './find-matches.ts'
import css from './ChatNav.module.css'

/** Clearance kept above a scrolled-to target so the sticky band never hides it. */
const TOP_CLEARANCE = 56

/** One row in the sent-message jump list. */
export interface OutlineEntry {
  /** The row's `data-chat-anchor-key`, used to scroll it into view. */
  readonly anchorKey: string
  /** 1-based position among sent messages. */
  readonly ordinal: number
  /** Collapsed preview text; empty when the message carried only images. */
  readonly text: string
  /** Whether the message included at least one image. */
  readonly hasImage: boolean
}

interface RawNode {
  readonly key?: unknown
  readonly kind?: unknown
  readonly data?: { readonly content?: unknown }
}

/**
 * Derive the sent-message outline from the ordered node keys. User and admitted
 * steering nodes are "our" messages; everything else (assistant, tools, system
 * context) is skipped. Reads the same node identity the DOM row exposes as
 * `data-chat-anchor-key`, so each entry can be scrolled to without guessing.
 * @param order - ordered node keys as rendered.
 * @param nodes - the chat node store (any map exposing `get`).
 * @returns one entry per sent message, in conversation order.
 */
export function buildOutline(
  order: readonly string[],
  nodes: { readonly get: (key: string) => unknown },
): OutlineEntry[] {
  const entries: OutlineEntry[] = []
  let ordinal = 0
  for (const key of order) {
    const node = nodes.get(key) as RawNode | undefined
    if (node === undefined) continue
    if (node.kind !== 'user' && node.kind !== 'steering') continue
    const content = node.data?.content
    if (!Array.isArray(content)) continue
    ordinal += 1
    let text = ''
    let hasImage = false
    for (const block of content) {
      const part = block as { type?: unknown; text?: unknown }
      if (part.type === 'text' && typeof part.text === 'string') text += part.text
      else if (part.type === 'image') hasImage = true
    }
    entries.push({
      anchorKey: typeof node.key === 'string' ? node.key : key,
      ordinal,
      text: text.replace(/\s+/g, ' ').trim(),
      hasImage,
    })
  }
  return entries
}

export interface ChatNavProps {
  /** The `.scroll` element; its resolved scrollport owns programmatic scrolls. */
  readonly listRef: RefObject<HTMLDivElement | null>
  /** The message column (`[data-chat-flow]`) — the only subtree find scans. */
  readonly columnRef: RefObject<HTMLDivElement | null>
  /** ChatView's scrollport resolver (active column host, else the view scroller). */
  readonly scrollportOf: (from: HTMLElement) => HTMLElement
  /** Sent-message jump list, precomputed by ChatView from the LOADED window. */
  readonly outline: readonly OutlineEntry[]
  /** Monotonic content signature; a change re-scans matches while find is open. */
  readonly revision: number
  /** Whether older history remains to page in (sent messages may be up there). */
  readonly hasMore: boolean
  /** Whether an older page is loading right now. */
  readonly loadingOlder: boolean
  /** Load one older page of history. */
  readonly loadOlder: () => void
  /** Report whether find-in-page is open so ChatView can mount the full window. */
  readonly onFindActiveChange?: (active: boolean) => void
  /** Scroll a possibly unmounted row into the virtual window before DOM lookup. */
  readonly onRevealAnchor?: (anchorKey: string) => void
  /** The owning view's locale seat. */
  readonly t: ChatViewSlotProps['t']
}

/**
 * The find + jump-list band. Mounted inside `.scroll` above the column so its
 * sticky slot pins to the scrollport top in both the active-host and
 * standalone layouts.
 */
export function ChatNav({
  listRef, columnRef, scrollportOf, outline, revision, hasMore, loadingOlder, loadOlder,
  onFindActiveChange, onRevealAnchor, t,
}: ChatNavProps) {
  const [findOpen, setFindOpen] = useState(false)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [matchCount, setMatchCount] = useState(0)
  const [activeIndex, setActiveIndex] = useState(-1)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const matchesRef = useRef<Range[]>([])

  // Latest-closure mirrors: the document key listener binds once, and the
  // revision effect must not capture a stale query/open flag.
  const findOpenRef = useRef(findOpen); findOpenRef.current = findOpen
  const outlineOpenRef = useRef(outlineOpen); outlineOpenRef.current = outlineOpen
  const queryRef = useRef(query); queryRef.current = query
  const activeIndexRef = useRef(activeIndex); activeIndexRef.current = activeIndex

  /** The resolved scrollport, or null before the list commits. */
  const scrollport = (): HTMLElement | null => {
    const list = listRef.current
    return list === null ? null : scrollportOf(list)
  }

  /** Only the visible conversation answers a global shortcut. */
  const isVisible = (): boolean => {
    const el = rootRef.current
    return el !== null && el.getBoundingClientRect().width > 0
  }

  const scrollToRect = (rect: DOMRect): void => {
    const port = scrollport()
    if (port === null) return
    const portRect = port.getBoundingClientRect()
    // Leave a scrolled-to hit where it already sits if it is comfortably in view.
    if (rect.top >= portRect.top + TOP_CLEARANCE && rect.bottom <= portRect.bottom - 24) return
    port.scrollTop = Math.max(0, rect.top - portRect.top + port.scrollTop - TOP_CLEARANCE)
  }

  const revealRange = (range: Range): void => {
    scrollToRect(range.getBoundingClientRect())
  }

  const revealAnchor = (anchorKey: string): void => {
    onRevealAnchor?.(anchorKey)
    const column = columnRef.current
    const port = scrollport()
    if (column === null || port === null) return
    for (const row of column.querySelectorAll<HTMLElement>('[data-chat-anchor-key]')) {
      if (row.dataset.chatAnchorKey !== anchorKey) continue
      const portRect = port.getBoundingClientRect()
      const rowRect = row.getBoundingClientRect()
      port.scrollTop = Math.max(0, rowRect.top - portRect.top + port.scrollTop - TOP_CLEARANCE)
      return
    }
  }

  const applyActive = (matches: readonly Range[], index: number): void => {
    setActiveIndex(index)
    paintMatches(matches, index)
    const range = matches[index]
    if (range !== undefined) revealRange(range)
  }

  /** Re-scan the column for `value` and land on a sensible match. */
  const refresh = (value: string, keepIndex: boolean): void => {
    const column = columnRef.current
    const port = scrollport()
    if (column === null || port === null) return
    const matches = collectMatches(column, value)
    matchesRef.current = matches
    setMatchCount(matches.length)
    if (matches.length === 0) {
      setActiveIndex(-1)
      clearMatches()
      return
    }
    const index = keepIndex
      ? Math.min(Math.max(activeIndexRef.current, 0), matches.length - 1)
      : nearestMatchIndex(matches, port)
    applyActive(matches, index)
  }

  const step = (delta: number): void => {
    const matches = matchesRef.current
    if (matches.length === 0) return
    const next = (activeIndexRef.current + delta + matches.length) % matches.length
    applyActive(matches, next)
  }

  const openFind = (): void => {
    setOutlineOpen(false)
    setFindOpen(true)
  }

  const closeFind = (): void => {
    setFindOpen(false)
    clearMatches()
  }

  const onQueryChange = (value: string): void => {
    setQuery(value)
    if (value.length === 0) {
      matchesRef.current = []
      setMatchCount(0)
      setActiveIndex(-1)
      clearMatches()
      return
    }
    refresh(value, false)
  }

  const jumpTo = (entry: OutlineEntry): void => {
    setOutlineOpen(false)
    revealAnchor(entry.anchorKey)
  }

  // Focus and re-scan when find opens; drop paint when it closes or unmounts.
  useEffect(() => {
    onFindActiveChange?.(findOpen)
    if (findOpen) {
      inputRef.current?.focus()
      inputRef.current?.select()
      if (queryRef.current.length > 0) refresh(queryRef.current, false)
    } else {
      clearMatches()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh reads live refs
  }, [findOpen, onFindActiveChange])

  useEffect(() => () => { clearMatches() }, [])

  // New/streamed content invalidates ranges; keep the active hit while open.
  const onRevisionRef = useRef(() => {})
  onRevisionRef.current = () => {
    if (findOpenRef.current && queryRef.current.length > 0) refresh(queryRef.current, true)
  }
  useEffect(() => { onRevisionRef.current() }, [revision])

  // Global Cmd/Ctrl+F on the visible conversation, and Esc to dismiss.
  const keyHandlerRef = useRef((_event: KeyboardEvent) => {})
  keyHandlerRef.current = (event: KeyboardEvent): void => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && (event.key === 'f' || event.key === 'F')) {
      if (!isVisible()) return
      event.preventDefault()
      openFind()
      inputRef.current?.focus()
      inputRef.current?.select()
      return
    }
    if (event.key === 'Escape') {
      if (findOpenRef.current) { event.preventDefault(); closeFind() }
      else if (outlineOpenRef.current) setOutlineOpen(false)
    }
  }
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { keyHandlerRef.current(event) }
    // Capture beats the engine's own find binding before it opens a native bar.
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('keydown', onKey, true) }
  }, [])

  // Sent messages scrolled out of the loaded window are missing from the
  // outline (which is built from that window). When the outline opens on a
  // transcript that still has older pages, pull pages until the first sent
  // messages surface — bounded, so a huge transcript never force-loads whole.
  // The "load earlier" row then keeps pulling beyond that on demand.
  const AUTO_LOAD_PAGE_CAP = 40
  const [autoLoading, setAutoLoading] = useState(false)
  const autoLoadPagesRef = useRef(0)

  useEffect(() => {
    if (outlineOpen && hasMore) { autoLoadPagesRef.current = 0; setAutoLoading(true) }
    else if (!outlineOpen) setAutoLoading(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the pump starts on open only
  }, [outlineOpen])

  useEffect(() => {
    if (!autoLoading) return
    if (!hasMore || outline.length > 0 || autoLoadPagesRef.current >= AUTO_LOAD_PAGE_CAP) {
      setAutoLoading(false)
      return
    }
    if (loadingOlder) return
    autoLoadPagesRef.current += 1
    loadOlder()
  }, [autoLoading, hasMore, loadingOlder, outline.length, loadOlder])

  const loadEarlier = (): void => { if (hasMore && !loadingOlder) loadOlder() }

  // Dismiss the outline on any click outside the band.
  useEffect(() => {
    if (!outlineOpen) return
    const onDown = (event: MouseEvent): void => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) setOutlineOpen(false)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => { document.removeEventListener('mousedown', onDown, true) }
  }, [outlineOpen])

  const countLabel = useMemo(() => {
    if (query.length === 0) return ''
    if (matchCount === 0) return t('find.none')
    return t('find.count', { index: String(activeIndex + 1), total: String(matchCount) })
  }, [query, matchCount, activeIndex, t])

  const noMatches = query.length > 0 && matchCount === 0

  return (
    <div ref={rootRef} className={css.region} data-chat-nav="">
      {!findOpen && (
        <div className={css.dock}>
          <button
            type="button"
            className={css.iconButton}
            aria-label={t('find.open')}
            title={t('find.open')}
            onClick={openFind}
          >
            <IconSearchOutline16 />
          </button>
          <button
            type="button"
            className={css.iconButton}
            data-active={outlineOpen}
            aria-label={t('outline.open')}
            title={t('outline.open')}
            aria-expanded={outlineOpen}
            onClick={() => { setFindOpen(false); setOutlineOpen(open => !open) }}
          >
            <IconChecklistOutline14 />
          </button>
        </div>
      )}

      {findOpen && (
        <div className={css.findBar} role="search">
          <span className={css.findGlyph} aria-hidden><IconSearchOutline16 /></span>
          <input
            ref={inputRef}
            type="search"
            className={css.findInput}
            placeholder={t('find.placeholder')}
            value={query}
            onChange={event => { onQueryChange(event.target.value) }}
            onKeyDown={event => {
              if (event.key === 'Enter') {
                event.preventDefault()
                step(event.shiftKey ? -1 : 1)
              } else if (event.key === 'Escape') {
                event.preventDefault()
                closeFind()
              }
            }}
          />
          <span className={css.findCount} data-empty={noMatches}>{countLabel}</span>
          <span className={css.divider} aria-hidden />
          <button
            type="button"
            className={css.stepButton}
            aria-label={t('find.prev')}
            title={t('find.prev')}
            disabled={matchCount === 0}
            onClick={() => { step(-1) }}
          >
            <IconChevronUpOutline14 />
          </button>
          <button
            type="button"
            className={css.stepButton}
            aria-label={t('find.next')}
            title={t('find.next')}
            disabled={matchCount === 0}
            onClick={() => { step(1) }}
          >
            <IconChevronDownOutline14 />
          </button>
          <button
            type="button"
            className={css.stepButton}
            aria-label={t('find.close')}
            title={t('find.close')}
            onClick={closeFind}
          >
            <IconCloseOutline16 />
          </button>
        </div>
      )}

      {outlineOpen && (
        <div className={css.outlinePanel} role="dialog" aria-label={t('outline.title')}>
          <div className={css.outlineHeader}>
            <span>{t('outline.title')}</span>
            <span>{outline.length}{hasMore ? '+' : ''}</span>
          </div>
          {outline.length === 0 && !hasMore && !autoLoading && !loadingOlder
            ? <div className={css.outlineEmpty}>{t('outline.empty')}</div>
            : (
              <ul className={css.outlineList}>
                {outline.map(entry => (
                  <li key={entry.anchorKey}>
                    <button type="button" className={css.outlineItem} onClick={() => { jumpTo(entry) }}>
                      <span className={css.outlineOrdinal}>{entry.ordinal}</span>
                      <span className={css.outlineText}>
                        {entry.text.length > 0 ? entry.text : t('outline.imageOnly')}
                      </span>
                    </button>
                  </li>
                ))}
                {hasMore && (
                  <li>
                    <button
                      type="button"
                      className={css.outlineMore}
                      disabled={autoLoading || loadingOlder}
                      onClick={loadEarlier}
                    >
                      {autoLoading || loadingOlder ? t('outline.loading') : t('outline.loadOlder')}
                    </button>
                  </li>
                )}
              </ul>
            )}
        </div>
      )}
    </div>
  )
}

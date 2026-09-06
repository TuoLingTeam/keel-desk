// @vitest-environment jsdom
// ChatNav: the sent-message outline is derived purely from ordered nodes, and
// find collects case-insensitive text-node ranges under the column while
// excluding the nav chrome. The DOM-geometry and Highlight-API paths degrade to
// no-ops under jsdom, so the interaction tests assert structure, not pixels.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { ChatNav, buildOutline } from '../src/client/chat/ChatNav.tsx'
import { collectMatches } from '../src/client/chat/find-matches.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

const t = makeTranslate(zh, commonZh)

const node = (key: string, kind: string, content: unknown[]): unknown => ({ key, kind, data: { content } })

describe('buildOutline', () => {
  const nodes = new Map<string, unknown>([
    ['n1', node('k-u1', 'user', [{ type: 'text', text: 'Hello world' }])],
    ['n2', node('k-a1', 'assistant-step', [])],
    ['n3', node('k-u2', 'user', [{ type: 'image', attachment: {} }])],
    ['n4', node('k-s1', 'steering', [{ type: 'text', text: '  spaced\n\ttext ' }])],
  ])
  const order = ['n1', 'n2', 'n3', 'n4']

  it('keeps only sent (user/steering) nodes, in order, numbered from one', () => {
    const outline = buildOutline(order, nodes)
    expect(outline.map(entry => entry.ordinal)).toEqual([1, 2, 3])
    expect(outline.map(entry => entry.anchorKey)).toEqual(['k-u1', 'k-u2', 'k-s1'])
  })

  it('extracts collapsed text and flags image-only messages', () => {
    const outline = buildOutline(order, nodes)
    expect(outline[0]).toMatchObject({ text: 'Hello world', hasImage: false })
    expect(outline[1]).toMatchObject({ text: '', hasImage: true })
    expect(outline[2]).toMatchObject({ text: 'spaced text', hasImage: false })
  })

  it('skips missing nodes and non-array content without throwing', () => {
    const sparse = new Map<string, unknown>([['x', undefined], ['y', { key: 'k', kind: 'user', data: {} }]])
    expect(buildOutline(['x', 'y', 'z'], sparse)).toEqual([])
  })
})

describe('collectMatches', () => {
  function column(html: string): HTMLElement {
    const root = document.createElement('div')
    root.innerHTML = html
    return root
  }

  it('finds every case-insensitive occurrence across nodes, in document order', () => {
    const ranges = collectMatches(column('<p>Foo bar FOO</p><span>baz foo</span>'), 'foo')
    expect(ranges.length).toBe(3)
    expect(ranges.map(range => range.toString().toLowerCase())).toEqual(['foo', 'foo', 'foo'])
  })

  it('excludes the nav chrome and empty/absent queries', () => {
    const root = column('<p>alpha</p><div data-chat-nav="">alpha in nav</div>')
    expect(collectMatches(root, 'alpha').length).toBe(1)
    expect(collectMatches(root, '')).toEqual([])
    expect(collectMatches(root, 'zzz')).toEqual([])
  })
})

describe('ChatNav interactions', () => {
  function mount(outline = buildOutline([], new Map())) {
    const column = document.createElement('div')
    column.innerHTML = '<div data-chat-anchor-key="k-u1">column body text</div>'
    document.body.appendChild(column)
    const list = document.createElement('div')
    document.body.appendChild(list)
    return render(
      <ChatNav
        listRef={{ current: list }}
        columnRef={{ current: column }}
        scrollportOf={() => list}
        outline={outline}
        revision={0}
        hasMore={false}
        loadingOlder={false}
        loadOlder={() => {}}
        t={t}
      />,
    )
  }

  it('opens the find bar from the search control', () => {
    mount()
    expect(screen.queryByPlaceholderText(zh['find.placeholder'])).toBeNull()
    fireEvent.click(screen.getByLabelText(zh['find.open']))
    expect(screen.getByPlaceholderText(zh['find.placeholder'])).not.toBeNull()
  })

  it('lists sent messages in the outline panel', () => {
    const outline = buildOutline(['n1'], new Map([['n1', node('k-u1', 'user', [{ type: 'text', text: 'Hello world' }])]]))
    mount(outline)
    fireEvent.click(screen.getByLabelText(zh['outline.open']))
    expect(screen.getByText('Hello world')).not.toBeNull()
    // The header count and the row ordinal both read "1".
    expect(screen.getAllByText('1').length).toBe(2)
  })
})

// @vitest-environment jsdom
/**
 * Sidebar-foot theme toggle: the label only rides the wide column, the glyph
 * advertises the destination scheme, and the write goes through `setTheme` so
 * the control and Settings → Appearance stay in step. The registration is
 * composition-conditional on the theme service.
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  createSnapshotStore, SlotRegistry,
  type SessionListState, type WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import { apply, inject } from '../src/client/index.ts'
import { ThemeToggle, type ThemeColorScheme, type ThemeToggleProps } from '../src/client/ThemeToggle.tsx'

afterEach(cleanup)

const COPY: Record<string, string> = {
  'theme': 'Theme',
  'theme.light': 'Light',
  'theme.dark': 'Dark',
  'theme.toLight': 'Switch to the light theme',
  'theme.toDark': 'Switch to the dark theme',
}

/** Empty global standard-kit hooks (the toggle reads neither). */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  return bindSnapshotSelector(store)
}
function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

function mount(scheme: ThemeColorScheme, wide = true) {
  const toggle = vi.fn()
  const props: ThemeToggleProps = {
    wide,
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useColorScheme: (select: (s: ThemeColorScheme) => unknown) => select(scheme),
    toggle,
    t: (key: string) => COPY[key] ?? key,
  } as unknown as ThemeToggleProps
  render(<ThemeToggle {...props} />)
  return { toggle }
}

/** A theme service stub exposing only what the toggle's inject face reads. */
function themeStub(scheme: ThemeColorScheme) {
  const setTheme = vi.fn()
  return {
    setTheme,
    service: {
      getTheme: () => ({
        preference: 'system',
        active: { id: scheme, colorScheme: scheme, tokens: {} },
        themes: [],
        revision: 0,
      }),
      setTheme,
    },
  }
}

async function bench(theme?: { service: unknown }) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
    getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
    subscribe: () => () => {},
  } as never)
  ctx.provide('connection', {
    api: { settings: { describe: async () => ({ result: { ok: false } }) } },
    isLoopback: false,
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  if (theme !== undefined) ctx.provide('theme', theme.service as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register(
    { name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { ctx, slots }
}

describe('ThemeToggle', () => {
  it('shows the current-scheme label when wide, icon only on the rail', () => {
    mount('light')
    // 宽栏文案随当前主题显示：浅色时是 Light，深色时是 Dark（不再是固定的 Theme）。
    expect(screen.queryByText('Light')).not.toBeNull()
    cleanup()
    mount('dark')
    expect(screen.queryByText('Dark')).not.toBeNull()
    cleanup()
    mount('light', false)
    expect(screen.queryByText('Light')).toBeNull()
    expect(screen.getByRole('button')).toBeDefined()
  })

  it('names the destination scheme, not the current one', () => {
    mount('light')
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(COPY['theme.toDark'])
    cleanup()
    mount('dark')
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(COPY['theme.toLight'])
  })

  it('click drives the injected toggle', () => {
    const b = mount('light')
    fireEvent.click(screen.getByRole('button'))
    expect(b.toggle).toHaveBeenCalledTimes(1)
  })
})

describe('theme toggle registration', () => {
  it('seats itself beside Settings once the theme service is present', async () => {
    const theme = themeStub('light')
    const b = await bench(theme)
    const entries = b.slots.entries('settings.trigger.action')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options.id).toBe('theme')
    expect(entries[0]!.component).toBe(ThemeToggle)
  })

  it('stays out of a composition with no theme service', async () => {
    const b = await bench()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(1)
    expect(b.slots.entries('settings.trigger.action')).toHaveLength(0)
  })

  it('reads the resolved scheme and writes the opposite explicit preference', async () => {
    for (const [scheme, expected] of [['light', 'dark'], ['dark', 'light']] as const) {
      const theme = themeStub(scheme)
      const b = await bench(theme)
      const injected = (b.slots.entries('settings.trigger.action')[0]!.inject as () => {
        hooks: { colorScheme: { getSnapshot: () => ThemeColorScheme } }
        toggle: () => void
      })()
      expect(injected.hooks.colorScheme.getSnapshot()).toBe(scheme)
      injected.toggle()
      // `system` resolves to a concrete scheme, so a flip always lands on an
      // explicit preference rather than cycling back through `system`.
      expect(theme.setTheme).toHaveBeenCalledWith(expected)
    }
  })
})

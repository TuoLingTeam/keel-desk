/**
 * Light/dark toggle seated beside Settings at the sidebar foot. It is a thin
 * face over `ctx.theme`: the glyph advertises the scheme a click would move
 * to, and the write goes through `setTheme`, so this control and the
 * Settings → Appearance row stay in step in both directions without knowing
 * about each other.
 */
import clsx from 'clsx'
import { IconDarkOutline16, IconLightOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ThemeToggle.module.css'

/** The resolved scheme the presenter is currently painting. */
export type ThemeColorScheme = 'light' | 'dark'

/** Registrant-private share: the live scheme plus the single write path. */
export type ThemeToggleInjected = {
  hooks: {
    /** Resolved scheme, republished on every `theme/change`. */
    colorScheme: HostObservable<ThemeColorScheme>
  }
  /** Flip the persisted preference to the opposite explicit scheme. */
  toggle: () => void
}

/** Full component props: column state, locale seat, and the injected face. */
export type ThemeToggleProps =
  PropsRuntime<'settings.trigger.action'>
  & PropsLocale<'settings'>
  & InjectFace<ThemeToggleInjected>

/**
 * Render the theme toggle button.
 * @param props - composed slot props.
 * @returns the toggle button element.
 */
export function ThemeToggle({ wide, t, useColorScheme, toggle }: ThemeToggleProps) {
  const scheme = useColorScheme(s => s)
  const dark = scheme === 'dark'
  // The icon names the destination, not the current state: a moon while light
  // means "click for dark".
  const Icon = dark ? IconLightOutline16 : IconDarkOutline16
  return (
    <button
      type="button"
      className={clsx(css.toggle, !wide && css.rail)}
      aria-label={t(dark ? 'theme.toLight' : 'theme.toDark')}
      title={wide ? undefined : t(dark ? 'theme.toLight' : 'theme.toDark')}
      onClick={toggle}
    >
      <Icon size={wide ? 16 : 18} />
      {wide && <span className={css.label}>{t('theme')}</span>}
    </button>
  )
}

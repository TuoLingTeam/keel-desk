// dsh-open-external — CLIENT half. Rendered content in the Harness UI marks
// external links with target="_blank", which a WKWebView cannot honour on its
// own (no tabs), so clicking one does nothing. Running inside the loopback
// Harness iframe — whose origin already holds the opener capability — this
// intercepts left-clicks on external http(s) anchors and hands the URL to the
// system browser through tauri-plugin-opener. Same-origin links keep their
// in-app behaviour, and modified clicks (⌘/ctrl/middle) are left alone.

const OPEN_COMMAND = 'plugin:opener|open_url'

interface TauriInternals { invoke?: (cmd: string, args: unknown) => Promise<unknown> }

/** Message the parent shell posts to when it cannot open a URL from this frame. */
const PARENT_OPEN_MESSAGE = 'dsh-open-external'

function openExternal(url: string): void {
  const internals = (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__
  const invoke = internals?.invoke
  if (typeof invoke === 'function') {
    void Promise.resolve(invoke(OPEN_COMMAND, { url })).catch(() => { fallback(url) })
    return
  }
  fallback(url)
}

/**
 * When this iframe cannot reach the opener directly, ask the parent shell (which
 * always can) over postMessage; if there is no parent, try a plain new window.
 */
function fallback(url: string): void {
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: PARENT_OPEN_MESSAGE, url }, '*')
      return
    }
  } catch { /* cross-origin parent access denied — fall through */ }
  try { window.open(url, '_blank', 'noopener,noreferrer') } catch { /* nothing else to try */ }
}

/** True for an absolute http(s) URL on a different origin than this frame. */
export function isExternalHttp(href: string): boolean {
  if (!/^https?:\/\//i.test(href)) return false
  try { return new URL(href).origin !== window.location.origin } catch { return false }
}

function installExternalLinkOpener(): () => void {
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.button !== 0
      || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const start = event.target as Element | null
    const anchor = start !== null && typeof start.closest === 'function'
      ? start.closest('a[href]') as HTMLAnchorElement | null
      : null
    if (anchor === null) return
    const href = anchor.href
    if (!isExternalHttp(href)) return
    // Preempt the dead target="_blank" navigation and open it for real.
    event.preventDefault()
    event.stopPropagation()
    openExternal(href)
  }
  document.addEventListener('click', onClick, true)
  return () => { document.removeEventListener('click', onClick, true) }
}

export const inject: string[] = []

export function apply(ctx: any): void {
  ctx.effect(installExternalLinkOpener, 'dsh-open-external: intercept external links')
}

export const internals = { isExternalHttp }

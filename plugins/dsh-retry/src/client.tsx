// dsh-retry — CLIENT half. A General-settings row for the global model-request
// retry count. Reads/writes the host store over HTTP; autosaves on blur / Enter
// (no save button) and refuses blank or non-integer values by refilling the last
// good one. Owner projects nothing here — copy, value, and write path are ours.

import { useEffect, useRef, useState } from 'react'

const NS = 'dsh-retry'
const CLIENT_BUNDLE_ID = 'dsh-retry'
const ROUTE_PREFIX = '/dsh-retry'
const DEFAULT_MAX_RETRIES = 99999

const zh = {
  'title': '模型请求重试次数',
  'desc': '单次模型请求失败后最多自动重试多少次（对所有模型生效）。默认 99999 ≈ 一直重试；填 0 表示不重试。',
  'unit': '次',
}
const en: Record<keyof typeof zh, string> = {
  'title': 'Model request retries',
  'desc': 'How many times a failed model request retries automatically (applies to every model). Default 99999 ≈ retry forever; 0 disables retries.',
  'unit': 'times',
}

type CopyKey = keyof typeof zh
type Translate = (key: CopyKey) => string

function fallbackTranslate(key: CopyKey): string {
  const dict = typeof navigator !== 'undefined' && navigator.language.startsWith('zh') ? zh : en
  return dict[key] ?? key
}

interface RowProps { t?: Translate }

function RetryCountRow({ t: injected }: RowProps) {
  const t = injected ?? fallbackTranslate
  const [value, setValue] = useState<number>(DEFAULT_MAX_RETRIES)
  const [draft, setDraft] = useState<string>(String(DEFAULT_MAX_RETRIES))
  const [invalid, setInvalid] = useState(false)
  const loaded = useRef(false)

  useEffect(() => {
    let alive = true
    void fetch(`${ROUTE_PREFIX}`, { cache: 'no-store' })
      .then(response => response.json())
      .then((data) => {
        if (!alive || data == null || typeof data.maxRetries !== 'number') return
        loaded.current = true
        setValue(data.maxRetries)
        setDraft(String(data.maxRetries))
      })
      .catch(() => { /* keep the default */ })
    return () => { alive = false }
  }, [])

  const commit = (): void => {
    const trimmed = draft.trim()
    const next = Number(trimmed)
    if (trimmed === '' || !Number.isSafeInteger(next) || next < 0) {
      // Reject: flag red briefly and refill the last good value.
      setInvalid(true)
      setDraft(String(value))
      window.setTimeout(() => { setInvalid(false) }, 1200)
      return
    }
    setInvalid(false)
    if (next === value) { setDraft(String(next)); return }
    setValue(next)
    setDraft(String(next))
    void fetch(`${ROUTE_PREFIX}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxRetries: next }),
    }).catch(() => { /* best effort; the host keeps the prior value */ })
  }

  return (
    <div className="dsh-retry-row">
      <div className="dsh-retry-text">
        <div className="dsh-retry-title">{t('title')}</div>
        <div className="dsh-retry-desc">{t('desc')}</div>
      </div>
      <div className="dsh-retry-control">
        <input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          className={`dsh-retry-input${invalid ? ' dsh-retry-input-invalid' : ''}`}
          value={draft}
          aria-label={t('title')}
          onChange={event => { setDraft(event.target.value) }}
          onBlur={commit}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); (event.target as HTMLInputElement).blur() }
          }}
        />
        <span className="dsh-retry-unit">{t('unit')}</span>
      </div>
    </div>
  )
}

const STYLES = String.raw`
.dsh-retry-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.dsh-retry-text{display:flex;flex:1 1 auto;min-width:0;flex-direction:column;gap:2px}
.dsh-retry-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:500}
.dsh-retry-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsh-retry-control{flex:none;display:inline-flex;align-items:center;gap:6px}
.dsh-retry-input{box-sizing:border-box;width:110px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right;font-variant-numeric:tabular-nums}
.dsh-retry-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-retry-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.dsh-retry-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
`

function installStyles(): () => void {
  if (document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`) !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = CLIENT_BUNDLE_ID
  style.textContent = STYLES
  document.head.appendChild(style)
  return () => { style.remove() }
}

export const inject = ['slots', 'locale']

export function apply(ctx: any): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-retry: dictionaries')
  ctx.effect(installStyles, 'dsh-retry: styles')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register(
    { name: 'settings.general.item', id: 'dsh-retry', order: 50, locale: NS },
    RetryCountRow,
  ))
}

export const internals = { RetryCountRow }

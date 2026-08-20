import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, StateDot, TerminalBlock, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import styles from './client.css'

const NS = 'desktop-manager'
const STYLE_MARKER = 'data-dsh-desktop-manager-styles'

/** 样式独立成 client.css，这里只负责把它挂进文档一次。 */
function installStyles(): void {
  if (document.querySelector(`[${STYLE_MARKER}]`) !== null) return
  const tag = document.createElement('style')
  tag.setAttribute(STYLE_MARKER, '')
  tag.textContent = styles
  document.head.append(tag)
}

export const name = 'dsh-desktop-manager'
export const inject = ['slots', 'locale', 'connection', 'modelDirectories']
function matchProfileId(modelName: string | null | undefined): string {
  const name = String(modelName ?? '').toLowerCase()
  const rules: Record<string, string[]> = {
    codex: ['gpt', 'codex', 'o1', 'o3'],
    claude: ['claude'],
    grok: ['grok'],
    deepseek: ['deepseek'],
  }
  for (const [id, patterns] of Object.entries(rules)) {
    if (patterns.some(pattern => name.includes(pattern))) return id
  }
  return 'deepseek'
}

const PROFILE_LABELS: Record<string, string> = {
  codex: 'GPT-5.6/Codex',
  claude: 'Claude',
  grok: 'Grok 4.6',
  deepseek: 'DeepSeek',
}

/* ------------------------------------------------------------------ *
 * 输入框里的「冷咖啡破甲」开关（conversation.input.left 槽位）。
 * 只能在新会话（无任何消息，session.blank === true）时开启/关闭；
 * 开启后按当前选择的模型名自动匹配对应 ColdBrew profile。
 * ------------------------------------------------------------------ */

interface ColdBrewToggleInjected {
  /** 该会话的模型目录 store；可能为 null（服务不可用/会话未就绪）。 */
  directory: { getSnapshot(): { current?: { model?: string } | null } | null; subscribe(fn: () => void): () => void } | null
}

type ColdBrewToggleProps = ColdBrewToggleInjected & {
  sessionId: string
  /** InputZone owner share 里的会话快照（含 blank 位）。 */
  session: { blank?: boolean } | null
}

function ColdBrewToggle({ sessionId, session, directory }: ColdBrewToggleProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const newSession = session?.blank === true

  const model = directory?.getSnapshot()?.current?.model ?? ''
  const profileId = matchProfileId(model)
  const profileLabel = PROFILE_LABELS[profileId] ?? profileId

  // 挂载时读取该会话已持久化的开关状态。新会话没有记录，后端会按
  // 「新会话默认开启」以及当前模型命中的 profile 决定初值，所以要把 model 带上。
  useEffect(() => {
    let alive = true
    const query = model === '' ? '' : `?model=${encodeURIComponent(model)}`
    fetch(`/api/coldbrew/session/${encodeURIComponent(sessionId)}${query}`)
      .then(res => res.json())
      .then(data => { if (alive) setEnabled(data.enabled === true) })
      .catch(() => { if (alive) setEnabled(false) })
    return () => { alive = false }
  }, [sessionId, model])

  const toggle = async (next: boolean) => {
    if (!newSession || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/coldbrew/session/${encodeURIComponent(sessionId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next, model }),
      })
      if (!res.ok) throw new Error(await res.text())
      const data = await res.json()
      setEnabled(data.enabled === true)
    } catch (reason: any) {
      setError(reason?.message ?? String(reason))
    } finally {
      setBusy(false)
    }
  }

  const on = enabled === true

  return (
    <div className="dsm-composer-toggle" data-on={on || undefined} data-new={newSession || undefined}>
      <button
        type="button"
        className="dsm-toggle-switch"
        role="switch"
        aria-checked={on}
        aria-label="冷咖啡破甲"
        disabled={!newSession || busy}
        title={newSession ? (on ? '关闭冷咖啡破甲' : '开启冷咖啡破甲') : '仅新会话可调整'}
        onClick={() => void toggle(!on)}
      >
        <span className="dsm-toggle-knob" />
      </button>
      <span className="dsm-toggle-label">
        {on ? `冷咖啡 · ${profileLabel}` : '冷咖啡'}
      </span>
      {error !== null && <span className="dsm-toggle-error" title={error}>!</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 新的桌面环境管理面板：冷咖啡 ColdBrew 四模型工作台
 * ------------------------------------------------------------------ */

interface ColdBrewProfile {
  id: string
  name: string
  short: string
  patterns: string[]
  defaultEnabled: boolean
}

function ManagerSection() {
  const [profiles, setProfiles] = useState<ColdBrewProfile[] | null>(null)
  const [status, setStatus] = useState({ installed: false, enabled: false, isRunning: false })
  // 后端是否在线，与 status.isRunning 是两回事：后者只表示有没有安装/卸载任务在跑。
  const [online, setOnline] = useState<boolean | null>(null)
  // 全局开关：新会话的输入框是否一进来就开着破甲。
  const [defaultOn, setDefaultOn] = useState(false)
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const pollTimer = useRef<any>(null)

  const showToast = (text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  const fetchLogs = useCallback(async () => {
    try {
      const res = await fetch('/api/desktop-manager/logs')
      const data = await res.json()
      setLogs(data.logs)
      if (!data.isRunning && pollTimer.current) {
        clearInterval(pollTimer.current)
        pollTimer.current = null
        setBusy(false)
        // Refresh status when task done
        const sRes = await fetch('/api/desktop-manager/status')
        setStatus(await sRes.json())
      }
    } catch (error) {
      console.error('Failed to fetch logs', error)
    }
  }, [])

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    pollTimer.current = setInterval(fetchLogs, 500)
  }, [fetchLogs])

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const [profilesRes, statusRes] = await Promise.all([
        fetch('/api/coldbrew/profiles'),
        fetch('/api/desktop-manager/status'),
      ])
      const profilesData = await profilesRes.json()
      setProfiles(profilesData.profiles ?? [])
      setDefaultOn(profilesData.defaultEnabled === true)
      const statusData = await statusRes.json()
      setStatus(statusData)
      // 这两个接口答上来，本身就证明后端在线——它就是提供这些接口的那个进程。
      setOnline(true)
      if (statusData.isRunning) {
        setBusy(true)
        startPolling()
      }
    } catch (error) {
      console.error('Failed to fetch status', error)
      setOnline(false)
    } finally {
      setLoading(false)
    }
  }, [startPolling])

  useEffect(() => {
    refresh()
    return () => { if (pollTimer.current) clearInterval(pollTimer.current) }
  }, [refresh])

  const toggleGlobalDefault = async (next: boolean) => {
    // 先乐观切换，失败再回滚，避免开关跟手感差。
    setDefaultOn(next)
    try {
      const res = await fetch('/api/coldbrew/default', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      })
      if (!res.ok) throw new Error(await res.text())
      showToast(next ? '新会话将默认开启破甲' : '新会话将默认关闭破甲')
    } catch (error: any) {
      setDefaultOn(!next)
      showToast(`设置失败: ${error.message}`)
    }
  }

  const setProfileDefault = async (profileId: string, defaultEnabled: boolean) => {
    try {
      const res = await fetch(`/api/coldbrew/profile/${encodeURIComponent(profileId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: defaultEnabled }),
      })
      if (!res.ok) throw new Error(await res.text())
      setProfiles(current => current === null ? current : current.map(p =>
        p.id === profileId ? { ...p, defaultEnabled } : p))
    } catch (error: any) {
      showToast(`操作失败: ${error.message}`)
    }
  }

  const action = async (type: string) => {
    console.log(`[dsh-desktop-manager] Action: ${type}`)
    if (type === 'restart') {
      window.parent.postMessage({ type: 'deepseek-harness:restart' }, '*')
      return
    }
    setBusy(true)
    setLogs([])
    try {
      const res = await fetch(`/api/desktop-manager/${type}`, { method: 'POST' })
      if (!res.ok) {
        throw new Error(await res.text())
      }
      if (type === 'install' || type === 'uninstall') {
        startPolling()
      } else {
        showToast('设置已更新，点击下方按钮应用')
        await refresh()
        setBusy(false)
      }
    } catch (error: any) {
      showToast(`操作失败: ${error.message}`)
      setBusy(false)
    }
  }

  if (loading) return <div className="dsm-empty">正在加载管理界面…</div>

  // 状态点的四色语义直接复用宿主的 StateDot：已启用=done，已禁用=warning，未安装=error。
  const pluginState = !status.installed ? 'error' : status.enabled ? 'done' : 'warning'
  const pluginStateText = !status.installed ? '尚未安装' : status.enabled ? '已启用' : '已禁用'

  return (
    <div className="dsm-root">
      {toast !== null && (
        <Toast key={toast.seq} text={toast.text} onDone={() => setToast(null)} />
      )}

      <header className="dsm-head">
        <h2>桌面环境管理 · 冷咖啡</h2>
        <p>管理桌面版独有的增强插件与运行时状态。新会话的输入框里可开启「冷咖啡破甲」，
          将按所选模型自动匹配对应的 ColdBrew profile。</p>
      </header>

      <div className="dsm-hub">
        <div className="dsm-hub-head">
          <span className="dsm-state">
            <StateDot
              state={online === null ? 'warning' : online ? 'done' : 'error'}
              size={8}
            />
            后端 {online === null ? '检查中…' : online ? '运行中' : '连接失败'}
          </span>
          {busy && (
            <span className="dsm-state">
              <StateDot state="ongoing" size={8} />
              任务执行中
            </span>
          )}

          <label className="dsm-default-toggle">
            <input
              type="checkbox"
              checked={defaultOn}
              onChange={(event) => { void toggleGlobalDefault(event.target.checked) }}
            />
            <span>所有新会话默认开启破甲</span>
          </label>
        </div>

        <p className="dsm-hub-hint">
          {defaultOn
            ? '所有新会话都会自动开启破甲，下面的单独设置暂时不起作用。'
            : '下面可以按模型单独设置：只有新会话用到该模型时，才自动开启破甲。'}
        </p>

        <div className="dsm-list">
          {(profiles ?? []).map(profile => {
            // 总开关一旦打开，逐模型设置就被它盖过去了——如实说明，
            // 否则会出现「总开关已开、这里却写着默认关闭」这种自相矛盾的显示。
            const effective = defaultOn || profile.defaultEnabled
            const state: 'done' | 'warning' = effective ? 'done' : 'warning'
            return (
              <article className="dsm-card" key={profile.id}>
                <div className="dsm-card-main">
                  <span className="dsm-card-title">
                    {profile.name}<span className="dsm-card-id">{profile.id}</span>
                  </span>
                  <span className="dsm-card-sub">{profile.short}</span>
                  <span className="dsm-card-patterns">匹配模型：{profile.patterns.join(' / ')}</span>
                </div>
                <div className="dsm-card-side">
                  <span className="dsm-state">
                    <StateDot state={state} size={8} />
                    {defaultOn
                      ? '已由总开关开启'
                      : profile.defaultEnabled
                        ? '用此模型时默认开启'
                        : '用此模型时不自动开启'}
                  </span>
                  <div className="dsm-actions">
                    <Button
                      onClick={() => void setProfileDefault(profile.id, !profile.defaultEnabled)}
                      disabled={busy || defaultOn}
                      variant={profile.defaultEnabled ? 'outline' : 'primary'}
                      size="sm"
                      title={defaultOn ? '总开关已开启，逐模型设置暂不生效' : undefined}
                    >
                      {profile.defaultEnabled ? '取消默认开启' : '设为默认开启'}
                    </Button>
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      </div>

      <div className="dsm-list">
        <article className="dsm-card">
          <div className="dsm-card-main">
            <span className="dsm-card-title">
              无限一代<span className="dsm-card-id">dsh-infinite-gen-1</span>
            </span>
            <span className="dsm-state">
              <StateDot state={pluginState} size={8} />
              {pluginStateText}
            </span>
          </div>

          <div className="dsm-actions">
            {!status.installed ? (
              <Button onClick={() => action('install')} disabled={busy} variant="primary" size="sm">
                一键安装
              </Button>
            ) : (
              <>
                <Button onClick={() => action('toggle')} disabled={busy} variant="primary" size="sm">
                  {status.enabled ? '禁用插件' : '启用插件'}
                </Button>
                <Button onClick={() => action('uninstall')} disabled={busy} variant="outline" size="sm">
                  彻底卸载
                </Button>
              </>
            )}
          </div>
        </article>
      </div>

      {(busy || logs.length > 0) && (
        <section className="dsm-logs">
          <div className="dsm-logs-head">
            <span>任务实时日志</span>
            {busy && <span className="dsm-logs-running">正在执行…</span>}
          </div>
          <TerminalBlock
            className="dsm-terminal"
            command="桌面管理任务"
            output={logs.length > 0 ? logs.join('\n') : '等待任务开始…'}
            running={busy}
          />
        </section>
      )}

      {!busy && status.installed && (
        <div className="dsm-apply-row">
          <p className="dsm-note">
            更改插件启用状态或安装新插件后，需要重启后端服务，系统提示词才会重新加载。
          </p>
          <Button onClick={() => action('restart')} variant="primary" size="sm">
            立即应用并重启
          </Button>
        </div>
      )}
    </div>
  )
}

export function apply(ctx: ClientContext) {
  installStyles()

  ctx.effect(() => ctx.locale.register(NS, {
    zh: { 'nav': '桌面管理' },
    en: { 'nav': 'Desktop' }
  }), 'dsh-desktop-manager: dictionaries')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-manager',
    order: 100,
    label: () => t('nav'),
    locale: NS,
  }, ManagerSection))

  // 输入框内的冷咖啡破甲开关：conversation.input.left 是会话作用域 list 槽位，
  // owner share 提供 session/input 快照，inject 回调按会话注入模型目录 store。
  // 需要 modelDirectories 服务解析当前会话的模型选择；会话尚未就绪时容错为 null。
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'coldbrew-toggle',
    order: 10,
    locale: NS,
    inject: (sessionId: string): ColdBrewToggleInjected => {
      try {
        const directory = ctx.modelDirectories?.directoryFor(sessionId)
        if (directory === undefined) return { directory: null }
        return { directory: directory.store }
      } catch {
        return { directory: null }
      }
    },
  }, ColdBrewToggle))
}

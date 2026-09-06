import React, { useState, useEffect, useCallback, useRef } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { Button, IconCopyOutline16, Modal, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
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

function writeClipboard(text: string): boolean {
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch {
    return false
  }
}

export const name = 'dsh-desktop-manager'
export const inject = ['slots', 'locale', 'connection', 'modelDirectories']
function matchProfileId(modelName: string | null | undefined): string {
  const name = String(modelName ?? '').toLowerCase()
  const rules: Record<string, string[]> = {
    codex: ['gpt', 'codex', 'o1', 'o3'],
    claude: ['claude'],
    grok: ['grok'],
    glm: ['glm', 'chatglm', 'zhipu'],
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
  glm: 'GLM 5.3',
  deepseek: 'DeepSeek',
}

/** 每个 profile 命中哪些模型的一句话说明（破甲管理卡片用）。 */
const PROFILE_MATCH_HINTS: Record<string, string> = {
  codex: '2.1.0 席位 · 指令层与工作流编排 · 匹配 GPT、Codex、o1、o3',
  claude: '2.1.0 席位 · 长会话与规则组织 · 匹配 Claude',
  grok: '2.1.0 席位 · 实时信息流与模板 · 匹配 Grok',
  glm: '2.1.0 席位 · 破甲越狱与越界重写 · 匹配 GLM、ChatGLM、智谱',
  deepseek: '2.1.0 席位 · 深度推理与会话导出 · 匹配 DeepSeek',
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
  input?: { draft?: string }
  inputActions?: { setDraft(text: string): void }
}

/** 可选席位口令，仅在用户主动点击复制时填入；开关开着不必发。 */
const PROFILE_WAKE: Record<string, string> = {
  codex: '[[ENI:PROFILE=MAX]]',
  claude: '[[CB:MAX]]',
  grok: '[[ENI:PROFILE=MAX]]',
  glm: 'BREAK//OPEN',
  deepseek: 'BREAK//OPEN',
}

const REVERIFY_WAKE = '[[RV:VERIFY]]'

function wakePhraseFor(profileId: string, mode: string): string {
  if (mode === 'reverify') return REVERIFY_WAKE
  return PROFILE_WAKE[profileId] ?? PROFILE_WAKE.deepseek
}

function modeLabel(mode: string): string {
  return mode === 'reverify' ? 'Reverify' : '冷咖啡'
}

function ColdBrewToggle({ sessionId, session, directory, input, inputActions }: ColdBrewToggleProps) {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [mode, setMode] = useState<string>('coldbrew')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null)
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const newSession = session?.blank === true

  const model = directory?.getSnapshot()?.current?.model ?? ''
  const profileId = matchProfileId(model)
  const profileLabel = PROFILE_LABELS[profileId] ?? profileId
  const wakePhrase = wakePhraseFor(profileId, mode)

  // 挂载时读取该会话已持久化的开关状态。新会话没有记录，后端会按
  // 「新会话默认开启」以及当前模型命中的 profile 决定初值，所以要把 model 带上。
  useEffect(() => {
    let alive = true
    const query = model === '' ? '' : `?model=${encodeURIComponent(model)}`
    fetch(`/api/coldbrew/session/${encodeURIComponent(sessionId)}${query}`)
      .then(res => res.json())
      .then(data => {
        if (!alive) return
        setEnabled(data.enabled === true)
        setMode(data.mode === 'reverify' ? 'reverify' : 'coldbrew')
      })
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
      if (data.mode === 'reverify' || data.mode === 'coldbrew') setMode(data.mode)
    } catch (reason: any) {
      setError(reason?.message ?? String(reason))
    } finally {
      setBusy(false)
    }
  }

  const on = enabled === true

  const flashNotice = (text: string, ok: boolean) => {
    setNotice({ text, ok })
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
    copiedTimer.current = setTimeout(() => {
      setNotice(null)
      setCopied(false)
    }, 1800)
  }

  const fillComposer = useCallback(() => {
    const current = String(input?.draft ?? '')
    if (current.trim() !== '') return
    try {
      inputActions?.setDraft(wakePhrase)
    } catch {
      /* composer 尚未就绪时只走剪贴板 */
    }
  }, [input, inputActions, wakePhrase])

  const copyPhrase = useCallback(async () => {
    if (on) {
      setCopied(true)
      setError(null)
      flashNotice(`${profileLabel} · ${modeLabel(mode)} 已开，直接发任务`, true)
      return
    }
    const okCopy = () => {
      setCopied(true)
      setError(null)
      fillComposer()
      flashNotice(`已填入 ${profileLabel} 可选口令「${wakePhrase}」`, true)
    }
    try {
      await navigator.clipboard.writeText(wakePhrase)
      okCopy()
      return
    } catch {
      /* 无 clipboard API 时走 textarea 兜底 */
    }
    if (writeClipboard(wakePhrase)) {
      okCopy()
      return
    }
    fillComposer()
    setError('复制失败')
    flashNotice('复制失败，已填入输入框', false)
  }, [fillComposer, wakePhrase, profileLabel, on, mode])

  useEffect(() => () => {
    if (copiedTimer.current !== null) clearTimeout(copiedTimer.current)
  }, [])

  useEffect(() => {
    if (notice === null) return
    const el = document.createElement('div')
    el.className = notice.ok ? 'dsm-copy-toast' : 'dsm-copy-toast dsm-copy-toast-err'
    el.textContent = notice.text
    document.body.appendChild(el)
    return () => { el.remove() }
  }, [notice])

  return (
    <div className="dsm-composer-toggle" data-on={on || undefined} data-new={newSession || undefined}>
      <button
        type="button"
        className="dsm-toggle-switch"
        role="switch"
        aria-checked={on}
        aria-label={mode === 'reverify' ? 'Reverify 字节裁判' : '冷咖啡破甲'}
        disabled={!newSession || busy}
        title={newSession
          ? (on
            ? `关闭${modeLabel(mode)}`
            : `开启${modeLabel(mode)}`)
          : '仅新会话可调整'}
        onClick={() => void toggle(!on)}
      >
        <span className="dsm-toggle-knob" />
      </button>
      <span className="dsm-toggle-label">
        <button
          type="button"
          className="dsm-phrase-copy"
          title={on
            ? `${profileLabel} · ${modeLabel(mode)} 已开，直接发任务`
            : `开关关闭时可选口令「${wakePhrase}」`}
          aria-label={on
            ? `${profileLabel} · ${modeLabel(mode)} 已开`
            : `复制 ${profileLabel} 可选口令 ${wakePhrase}`}
          data-copied={copied || undefined}
          onClick={() => void copyPhrase()}
        >
          {modeLabel(mode)}
          <IconCopyOutline16 size={12} />
        </button>
        {on && ` · ${profileLabel}`}
      </span>
      {error !== null && <span className="dsm-toggle-error" title={error}>!</span>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 新的桌面环境管理面板：冷咖啡 ColdBrew 五模型工作台
 * ------------------------------------------------------------------ */

interface ColdBrewProfile {
  id: string
  name: string
  short: string
  patterns: string[]
  defaultEnabled: boolean
}

interface EngineSlot {
  engine?: string
  version?: string
  note?: string
}

interface ReverifyStatus {
  ok?: boolean
  version?: string
  present?: boolean
  venv?: boolean
  python?: { version?: string; source?: string; error?: string; executable?: string }
  engines?: {
    full_fidelity?: boolean
    install_hint?: string
    error?: string
    disassembly?: EngineSlot
    emulation?: EngineSlot
    binary_parsing?: EngineSlot
    proof?: EngineSlot
    semantic?: EngineSlot
  } | null
  error?: string
}

function engineIsNative(slot?: EngineSlot): boolean {
  const engine = slot?.engine
  return Boolean(engine && engine !== 'pure-python' && engine !== 'none')
}

function describeReverify(status: ReverifyStatus | null) {
  const coreOk = status?.present === true || status?.ok === true
  const fidelityOk = status?.engines?.full_fidelity === true
  const angrOk = engineIsNative(status?.engines?.semantic)
  const pythonError = status?.python?.error
  const pythonVersion = status?.python?.version

  if (status === null) {
    return {
      tone: 'warning' as const,
      headline: '正在探测本机环境…',
      detail: '先确认 Python 和引擎装到哪一层，再决定要不要动手。',
      rows: [
        { name: '核心', ok: false, note: '探测中' },
        { name: '高精度引擎', ok: false, note: '探测中' },
        { name: '调用图引擎', ok: false, note: '探测中' },
      ],
      needPython: false,
      needFidelity: false,
      needAngr: false,
      canUninstall: false,
    }
  }

  if (pythonError) {
    return {
      tone: 'error' as const,
      headline: '还不能用',
      detail: `本机找不到 Python 3.8+。装好后再点重新探测。${pythonError}`,
      rows: [
        { name: '核心', ok: Boolean(status.present), note: status.present ? '已随应用打包，等 Python' : '应用包里缺文件' },
        { name: '高精度引擎', ok: false, note: '需要先有 Python' },
        { name: '调用图引擎', ok: false, note: '需要先有 Python' },
      ],
      needPython: true,
      needFidelity: false,
      needAngr: false,
      canUninstall: false,
    }
  }

  if (status.engines?.error && !fidelityOk) {
    return {
      tone: 'warning' as const,
      headline: '探测异常',
      detail: status.engines.error,
      rows: [
        { name: '核心', ok: coreOk, note: coreOk ? '已随应用打包' : '应用包里缺文件' },
        { name: '高精度引擎', ok: false, note: '探测失败，可再装一次' },
        { name: '调用图引擎', ok: angrOk, note: angrOk ? '函数边界和调用图' : '可选，未探测到' },
      ],
      needPython: false,
      needFidelity: true,
      needAngr: !angrOk,
      canUninstall: Boolean(status.venv) || fidelityOk || angrOk,
    }
  }

  const pythonBit = pythonVersion ? `Python ${pythonVersion}` : '系统 Python'
  if (fidelityOk && angrOk) {
    return {
      tone: 'done' as const,
      headline: `已全部就绪 · ${pythonBit}`,
      detail: '拆样本、反汇编、模拟、调用图都可以直接用，不用再装。',
      rows: [
        { name: '核心', ok: true, note: '已随应用打包' },
        { name: '高精度引擎', ok: true, note: '反汇编 / 模拟 / PE·ELF·Mach-O' },
        { name: '调用图引擎', ok: true, note: '函数边界和调用图' },
      ],
      needPython: false,
      needFidelity: false,
      needAngr: false,
      canUninstall: true,
    }
  }
  if (fidelityOk) {
    return {
      tone: 'done' as const,
      headline: `已就绪 · ${pythonBit}`,
      detail: '日常拆样本已经够用。调用图引擎是可选项：不装也能拆，只是函数边界会降级。',
      rows: [
        { name: '核心', ok: true, note: '已随应用打包' },
        { name: '高精度引擎', ok: true, note: '反汇编 / 模拟 / PE·ELF·Mach-O' },
        { name: '调用图引擎', ok: false, note: '未装 · 可选，需要函数边界时再加' },
      ],
      needPython: false,
      needFidelity: false,
      needAngr: true,
      canUninstall: true,
    }
  }
  return {
    tone: 'warning' as const,
    headline: `能用，精度偏低 · ${pythonBit}`,
    detail: '核心已经能跑。高精度引擎还没装，反汇编和模拟会慢、也更容易看走眼。',
    rows: [
      { name: '核心', ok: coreOk, note: coreOk ? '已随应用打包' : '应用包里缺文件' },
      { name: '高精度引擎', ok: false, note: '未装 capstone / unicorn / lief / z3' },
      { name: '调用图引擎', ok: angrOk, note: angrOk ? '函数边界和调用图' : '未装 · 可选' },
    ],
    needPython: false,
    needFidelity: true,
    needAngr: !angrOk,
    canUninstall: Boolean(status.venv) || fidelityOk || angrOk,
  }
}

function parseInstallProgress(line: string): { label: string; percent: number | null } {
  const text = String(line ?? '').trim()
  const slash = text.match(/([\d.]+)\s*(kB|MB|GB|KiB|MiB|GiB)\s*\/\s*([\d.]+)\s*(kB|MB|GB|KiB|MiB|GiB)/i)
  if (slash) {
    const current = Number(slash[1])
    const total = Number(slash[3])
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : null
    return { label: `${slash[1]} ${slash[2]} / ${slash[3]} ${slash[4]}`, percent }
  }
  const bar = text.match(/(\d+)\s*%/)
  if (bar) return { label: text, percent: Number(bar[1]) }
  return { label: text, percent: null }
}

function jobTitle(kind: string | null, running: boolean, error: string | null): string {
  if (!running && error) return '任务失败'
  if (!running) return '任务完成'
  if (kind === 'angr') return '正在加装调用图引擎'
  if (kind === 'uninstall') return '正在卸载可选引擎'
  if (kind === 'plugin-install') return '正在安装冷咖啡'
  if (kind === 'plugin-uninstall') return '正在卸载冷咖啡'
  return '正在安装高精度引擎'
}

function InstallProgressDialog(props: {
  extra: 'full' | 'angr' | 'uninstall' | 'plugin-install' | 'plugin-uninstall' | null
  logs: string[]
  live: string
  running: boolean
  error: string | null
  onDismiss: () => void
}) {
  const logRef = useRef<HTMLPreElement | null>(null)
  const title = jobTitle(props.extra, props.running, props.error)
  const progress = props.live ? parseInstallProgress(props.live) : null
  const displayLogs = props.live ? [...props.logs, props.live] : props.logs
  const locked = props.running

  useEffect(() => {
    const el = logRef.current
    if (el === null) return
    el.scrollTop = el.scrollHeight
  }, [displayLogs.length, props.live])

  return (
    <Modal
      open={props.extra !== null}
      onClose={() => { if (!locked) props.onDismiss() }}
      title={title}
      closeLabel="完成"
      headless
      className="dsm-install-dialog"
    >
      <div className="dsm-install">
        <div className="dsm-install-head">
          <h2 className="dsm-install-title">{locked ? title : (props.error ? '安装失败' : '安装完成')}</h2>
          <p className="dsm-install-desc">
            {locked
              ? '完成前不能关闭这个窗口。下面是实时过程。'
              : (props.error ?? '可以关闭。')}
          </p>
        </div>
        {progress !== null && (
          <div className="dsm-install-live">
            <div className="dsm-install-live-row">
              <span className="dsm-install-live-label">{progress.label}</span>
              {progress.percent !== null && <span className="dsm-install-live-pct">{progress.percent}%</span>}
            </div>
            {progress.percent !== null && (
              <div className="dsm-install-bar" aria-hidden="true">
                <span className="dsm-install-bar-fill" style={{ width: `${progress.percent}%` }} />
              </div>
            )}
          </div>
        )}
        <pre ref={logRef} className="dsm-install-log">
          {displayLogs.length > 0 ? displayLogs.join('\n') : '等待安装输出…'}
        </pre>
        {!locked && (
          <div className="dsm-install-foot">
            <Button variant="primary" size="sm" onClick={props.onDismiss}>完成</Button>
          </div>
        )}
      </div>
    </Modal>
  )
}

function ReverifyCard(props: {
  status: ReverifyStatus | null
  busy: boolean
  installingExtra: 'full' | 'angr' | 'uninstall' | null
  onInstall: (extra: 'full' | 'angr') => void
  onUninstall: () => void
  onProbe: () => void
}) {
  const view = describeReverify(props.status)
  const showActions = view.needPython || view.needFidelity || view.needAngr || view.canUninstall
  return (
    <article className="dsm-card dsm-card-stack">
      <div className="dsm-card-main">
        <span className="dsm-card-title">
          Reverify 字节裁判<span className="dsm-card-id">0.9.0</span>
        </span>
        <span className="dsm-state">
          <StateDot state={view.tone} size={8} />
          {view.headline}
        </span>
        <span className="dsm-card-sub">{view.detail}</span>
      </div>
      <ul className="dsm-cap-list">
        {view.rows.map(row => (
          <li className="dsm-cap" key={row.name}>
            <StateDot state={row.ok ? 'done' : 'warning'} size={8} />
            <div className="dsm-cap-body">
              <span className="dsm-cap-name">{row.name}</span>
              <span className="dsm-cap-note">{row.note}</span>
            </div>
            <span className="dsm-tag" data-on={row.ok || undefined}>
              {row.ok ? '已安装' : '未安装'}
            </span>
          </li>
        ))}
      </ul>
      {showActions && (
        <div className="dsm-actions">
          {view.needPython && (
            <Button onClick={props.onProbe} disabled={props.busy} variant="primary" size="sm">
              重新探测
            </Button>
          )}
          {view.needFidelity && (
            <Button
              onClick={() => props.onInstall('full')}
              disabled={props.busy}
              variant="primary"
              size="sm"
            >
              {props.installingExtra === 'full' ? '正在安装高精度引擎…' : '安装高精度引擎'}
            </Button>
          )}
          {view.needAngr && (
            <Button
              onClick={() => props.onInstall('angr')}
              disabled={props.busy}
              variant="outline"
              size="sm"
            >
              {props.installingExtra === 'angr' ? '正在安装调用图引擎…' : '加装调用图引擎'}
            </Button>
          )}
          {view.canUninstall && (
            <Button
              onClick={props.onUninstall}
              disabled={props.busy}
              variant="outline"
              size="sm"
            >
              {props.installingExtra === 'uninstall' ? '正在卸载…' : '卸载可选引擎'}
            </Button>
          )}
        </div>
      )}
    </article>
  )
}

function ManagerSection() {
  const [profiles, setProfiles] = useState<ColdBrewProfile[] | null>(null)
  const [status, setStatus] = useState({ installed: false, enabled: false, isRunning: false })
  // 后端是否在线，与 status.isRunning 是两回事：后者只表示有没有安装/卸载任务在跑。
  const [online, setOnline] = useState<boolean | null>(null)
  // 全局开关：新会话的输入框是否一进来就开着破甲。
  const [defaultOn, setDefaultOn] = useState(false)
  const [armorMode, setArmorMode] = useState<'coldbrew' | 'reverify'>('coldbrew')
  const [reverify, setReverify] = useState<ReverifyStatus | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [installingExtra, setInstallingExtra] = useState<'full' | 'angr' | 'uninstall' | 'plugin-install' | 'plugin-uninstall' | null>(null)
  const [installLive, setInstallLive] = useState('')
  const [installError, setInstallError] = useState<string | null>(null)
  const [installRunning, setInstallRunning] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const pollTimer = useRef<any>(null)

  const showToast = (text: string) => {
    toastSeq.current += 1
    setToast({ seq: toastSeq.current, text })
  }

  const fetchLogs = useCallback(async () => {
    try {
      const [desktopRes, reverifyRes] = await Promise.all([
        fetch('/api/desktop-manager/logs'),
        fetch('/api/coldbrew/reverify/logs'),
      ])
      const desktop = await desktopRes.json().catch(() => ({ logs: [], isRunning: false }))
      const reverifyLogs = await reverifyRes.json().catch(() => ({ logs: [], isRunning: false }))
      const pluginJob = installingExtra === 'plugin-install' || installingExtra === 'plugin-uninstall'
      const installLines = Array.isArray(reverifyLogs.logs) ? reverifyLogs.logs : []
      const desktopLines = Array.isArray(desktop.logs) ? desktop.logs : []
      const merged = pluginJob ? desktopLines : installLines
      if (merged.length > 0) setLogs(merged)
      if (!pluginJob && typeof reverifyLogs.live === 'string') setInstallLive(reverifyLogs.live)
      const jobRunning = pluginJob ? desktop.isRunning === true : reverifyLogs.isRunning === true
      if (pluginJob && desktop.isRunning) {
        const sRes = await fetch('/api/desktop-manager/status')
        setStatus(await sRes.json())
      }
      if (installingExtra && jobRunning === false) {
        if (pollTimer.current) {
          clearInterval(pollTimer.current)
          pollTimer.current = null
        }
        if (!pluginJob && reverifyLogs.result) setReverify(reverifyLogs.result)
        setInstallError(!pluginJob && typeof reverifyLogs.error === 'string' ? reverifyLogs.error : null)
        setInstallRunning(false)
        setBusy(false)
        if (!pluginJob && reverifyLogs.error) showToast('安装失败，详情见弹窗')
        else if (reverifyLogs.extra === 'angr') showToast('调用图引擎已装好')
        else if (reverifyLogs.extra === 'full') showToast('高精度引擎已装好')
        else if (reverifyLogs.extra === 'uninstall') showToast('可选引擎已卸掉')
        else if (pluginJob) showToast(installingExtra === 'plugin-uninstall' ? '冷咖啡已卸载' : '冷咖啡已安装')
      }
    } catch (error) {
      console.error('Failed to fetch logs', error)
    }
  }, [installingExtra])

  const startPolling = useCallback(() => {
    if (pollTimer.current) clearInterval(pollTimer.current)
    pollTimer.current = setInterval(fetchLogs, installingExtra ? 250 : 500)
  }, [fetchLogs, installingExtra])

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
      setArmorMode(profilesData.armorMode === 'reverify' ? 'reverify' : 'coldbrew')
      setReverify(profilesData.reverify ?? null)
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

  const setArmorModeRemote = async (next: 'coldbrew' | 'reverify') => {
    const previous = armorMode
    setArmorMode(next)
    try {
      const res = await fetch('/api/coldbrew/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      })
      if (!res.ok) throw new Error(await res.text())
      showToast(next === 'reverify'
        ? '之后新开的对话，会先核对文件再下结论。'
        : '之后新开的对话，会按原来的冷咖啡方式工作。')
    } catch (error: any) {
      setArmorMode(previous)
      showToast(`切换模式失败: ${error.message}`)
    }
  }

  const startReverifyJob = async (kind: 'full' | 'angr' | 'uninstall') => {
    setBusy(true)
    setInstallingExtra(kind)
    setInstallRunning(true)
    setInstallError(null)
    setInstallLive('')
    const startLine = kind === 'angr'
      ? '开始加装调用图引擎…'
      : kind === 'uninstall'
        ? '开始卸载可选引擎…'
        : '开始安装高精度引擎…'
    setLogs([startLine, kind === 'uninstall' ? '过程会实时显示在弹窗里。' : '下载可能要几分钟，过程会实时显示在弹窗里。'])
    startPolling()
    try {
      const path = kind === 'uninstall'
        ? '/api/coldbrew/reverify/uninstall'
        : '/api/coldbrew/reverify/install'
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: kind === 'uninstall' ? '{}' : JSON.stringify({ extra: kind }),
      })
      const data = await res.json().catch(() => ({}))
      if (Array.isArray(data.logs) && data.logs.length > 0) setLogs(data.logs)
      if (res.status === 409) {
        showToast('已经在处理，日志会继续刷')
        return
      }
      if (!res.ok && res.status !== 202) throw new Error(data.error ?? '安装失败')
    } catch (error: any) {
      showToast(`安装失败: ${error.message}`)
      if (pollTimer.current) {
        clearInterval(pollTimer.current)
        pollTimer.current = null
      }
      setInstallError(error.message)
      setInstallRunning(false)
      setBusy(false)
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
    if (type === 'install' || type === 'uninstall') {
      setInstallingExtra(type === 'uninstall' ? 'plugin-uninstall' : 'plugin-install')
      setInstallRunning(true)
      setInstallError(null)
      setInstallLive('')
      setLogs([type === 'uninstall' ? '开始卸载冷咖啡…' : '开始安装冷咖啡…'])
      startPolling()
    }
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
      setInstallError(error.message)
      setInstallRunning(false)
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

        <div className="dsm-mode-row" role="radiogroup" aria-label="工作模式">
          <button
            type="button"
            className="dsm-mode-chip"
            data-on={armorMode === 'coldbrew' || undefined}
            aria-pressed={armorMode === 'coldbrew'}
            onClick={() => { void setArmorModeRemote('coldbrew') }}
          >
            冷咖啡 2.1.0
          </button>
          <button
            type="button"
            className="dsm-mode-chip"
            data-on={armorMode === 'reverify' || undefined}
            aria-pressed={armorMode === 'reverify'}
            onClick={() => { void setArmorModeRemote('reverify') }}
          >
            Reverify 0.9.0
          </button>
          <span className="dsm-mode-hint">
            {armorMode === 'reverify'
              ? '之后新开的对话，会先核对文件再下结论。'
              : '之后新开的对话，会按原来的冷咖啡方式工作。'}
          </span>
        </div>

        {status.installed && (
          <div className="dsm-note dsm-apply-note">
            <span>更改插件启用状态或安装新插件后，需要重启后端服务，系统提示词才会重新加载。</span>
            {!busy && (
              <Button onClick={() => action('restart')} variant="primary" size="sm">
                重启应用
              </Button>
            )}
          </div>
        )}

        {!defaultOn && (
          <p className="dsm-hub-hint">
            下面可以按模型单独设置：只有新会话用到该模型时，才自动开启破甲。
          </p>
        )}

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
                    {profile.name}<span className="dsm-card-id">{profile.id} · 2.1.0</span>
                  </span>
                  {PROFILE_MATCH_HINTS[profile.id] !== undefined && (
                    <span className="dsm-card-sub">{profile.short} · {PROFILE_MATCH_HINTS[profile.id]}</span>
                  )}
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
        <ReverifyCard
          status={reverify}
          busy={busy}
          installingExtra={installingExtra}
          onInstall={(extra) => { void startReverifyJob(extra) }}
          onUninstall={() => { void startReverifyJob('uninstall') }}
          onProbe={() => { void refresh() }}
        />
        <article className="dsm-card">
          <div className="dsm-card-main">
            <span className="dsm-card-title">
              冷咖啡 Zero 2.1.0<span className="dsm-card-id">BREAK//OPEN</span>
            </span>
            <a
              className="dsm-card-link"
              href="https://github.com/3641397194-wq/gpt5.6-claude-grok4.6-deepseekv4pro"
              target="_blank"
              rel="noreferrer noopener"
            >
              github.com/3641397194-wq/gpt5.6-claude-grok4.6-deepseekv4pro
            </a>
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

      <InstallProgressDialog
        extra={installingExtra}
        logs={logs}
        live={installLive}
        running={installRunning}
        error={installError}
        onDismiss={() => {
          setInstallingExtra(null)
          setInstallLive('')
          setInstallError(null)
          setInstallRunning(false)
          void refresh()
        }}
      />

    </div>
  )
}

export function apply(ctx: ClientContext) {
  installStyles()

  ctx.effect(() => ctx.locale.register(NS, {
    zh: { 'nav': '破甲管理' },
    en: { 'nav': 'Jailbreak' }
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

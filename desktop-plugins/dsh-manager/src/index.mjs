import { spawn } from 'node:child_process'
import { accessSync, copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARMOR_MODES,
  DEFAULT_ARMOR_MODE,
  REVERIFY_TOOLS,
  REVERIFY_VERSION,
  installReverifyExtras,
  normalizeArmorMode,
  probeReverify,
  runReverifyTool,
  uninstallReverifyExtras,
} from './reverify.mjs'

export const name = 'dsh-desktop-manager'
export const inject = ['webServer', 'loader', 'systemPrompt', 'tools']
export { ARMOR_MODES, DEFAULT_ARMOR_MODE, normalizeArmorMode }

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const pluginsRoot = join(repositoryRoot, 'plugins')
const profilesDir = join(dirname(fileURLToPath(import.meta.url)), 'profiles')

/**
 * 用户数据根：`$DSH_HOME`，未设置则 `~/.dsh`。
 *
 * 破甲默认开关、逐模型默认、会话开关都必须写这里。旧实现写在安装包 /
 * 仓库根的 `desktop-settings.json`，换版本整包替换就会把勾选冲掉。
 */
export function userDataHome(env = process.env) {
  const configured = String(env.DSH_HOME ?? '').trim()
  if (configured.length === 0) return join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) {
    return resolve(join(homedir(), configured.slice(2)))
  }
  return resolve(configured)
}

export function settingsFile(env = process.env) {
  return join(userDataHome(env), 'desktop-settings.json')
}

export function coldbrewStateFile(env = process.env) {
  return join(userDataHome(env), 'coldbrew-sessions.json')
}

function legacySettingsFile() {
  return join(repositoryRoot, 'desktop-settings.json')
}

function legacyColdbrewStateFile() {
  return join(repositoryRoot, 'coldbrew-sessions.json')
}

function pathExistsSync(path) {
  try {
    accessSync(path)
    return true
  } catch {
    return false
  }
}

/** 用户目录还没有文件时，把安装包/仓库根里的旧文件拷过去一次。 */
function migrateLegacyFile(destPath, legacyPath) {
  if (pathExistsSync(destPath) || !pathExistsSync(legacyPath)) return
  mkdirSync(userDataHome(), { recursive: true })
  copyFileSync(legacyPath, destPath)
}

let taskLogs = []
let isRunning = false
let installJob = {
  extra: null,
  error: null,
  result: null,
  live: '',
}

function appendTaskLog(line, live = false) {
  const text = String(line ?? '').trim()
  if (!text) return
  if (live) {
    installJob.live = text
    return
  }
  installJob.live = ''
  taskLogs.push(text)
  if (taskLogs.length > 800) taskLogs = taskLogs.slice(-600)
}

function installStatusPayload() {
  return {
    logs: taskLogs,
    live: installJob.live,
    isRunning,
    extra: installJob.extra,
    error: installJob.error,
    result: isRunning ? null : installJob.result,
  }
}

/**
 * 会话破甲开关的内存态：{ [sessionId]: { enabled, model } }，与 coldbrewStatePath 双向同步。
 *
 * 注意：每次读取都重新读盘（而不是首次读后永久缓存）。systemPrompt 的 text
 * provider 在每一次组装时求值，而会话开关可能在同一进程内被 API 写入、也可能
 * 被外部进程修改；一次性缓存会让「中途打开/切换模型」在下一个 turn 里读不到
 * 新状态——这正是破甲在长会话中途失效的根因之一。
 */
let sessionStates = {}

function loadSessionStatesSync() {
  const dest = coldbrewStateFile()
  migrateLegacyFile(dest, legacyColdbrewStateFile())
  try {
    sessionStates = JSON.parse(readFileSync(dest, 'utf8'))
  } catch {
    sessionStates = {}
  }
  return sessionStates
}

/** 五个模型的 ColdBrew 破甲 profile 元数据（2.1.0 席位）；提示词正文在 profilesDir 下按 id 存放。 */
const PROFILES = {
  codex: {
    id: 'codex',
    name: 'GPT-5.6 / Codex',
    short: '指令层与工作流编排',
    file: 'codex.md',
    reverifyFile: 'codex-reverify.md',
    // 模型名命中规则（大小写不敏感，取第一个命中）
    patterns: ['gpt', 'codex', 'o1', 'o3'],
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    short: '长会话与规则组织',
    file: 'claude.md',
    reverifyFile: 'claude-reverify.md',
    patterns: ['claude'],
  },
  grok: {
    id: 'grok',
    name: 'Grok 4.6',
    short: '实时信息流与模板',
    file: 'grok.md',
    reverifyFile: 'grok-reverify.md',
    patterns: ['grok'],
  },
  glm: {
    id: 'glm',
    name: 'GLM 5.3',
    short: '破甲越狱与越界重写',
    file: 'glm.md',
    reverifyFile: 'glm-reverify.md',
    patterns: ['glm', 'chatglm', 'zhipu'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek v4 Pro',
    short: '深度推理与会话导出',
    file: 'deepseek.md',
    reverifyFile: 'deepseek-reverify.md',
    patterns: ['deepseek'],
  },
}

/** 按模型名匹配 profile id；默认回落 DeepSeek。 */
export function matchProfileId(modelName) {
  const name = String(modelName ?? '').toLowerCase()
  for (const profile of Object.values(PROFILES)) {
    if (profile.patterns.some(pattern => name.includes(pattern))) return profile.id
  }
  return 'deepseek'
}

/** 读一份 profile 提示词正文（同步，启动时一次性缓存；正文必须同步求值给 systemPrompt section）。
 *  ColdBrew：五个席位共用 kernel-2.1.0.md；Reverify：共用 kernel-reverify.md。席位文件只保留身份/语气 overlay。 */
const KERNEL_FILE = 'kernel-2.1.0.md'
const REVERIFY_KERNEL_FILE = 'kernel-reverify.md'
const promptCache = new Map()
function loadPromptSync(profile, mode = DEFAULT_ARMOR_MODE) {
  const armorMode = normalizeArmorMode(mode)
  const key = `${armorMode}:${profile.id}`
  if (!promptCache.has(key)) {
    const overlayName = armorMode === 'reverify'
      ? (profile.reverifyFile ?? `${profile.id}-reverify.md`)
      : profile.file
    const kernelName = armorMode === 'reverify' ? REVERIFY_KERNEL_FILE : KERNEL_FILE
    const overlay = readFileSync(join(profilesDir, overlayName), 'utf8')
    const kernel = readFileSync(join(profilesDir, kernelName), 'utf8')
    promptCache.set(key, `${overlay.trim()}\n\n${kernel}`)
  }
  return promptCache.get(key)
}

function settingsArmorMode(settings) {
  return normalizeArmorMode(settings?.coldbrew?.armorMode)
}

function sessionArmorMode(state, settings) {
  if (state?.mode !== undefined && state?.mode !== null && String(state.mode).length > 0) {
    return normalizeArmorMode(state.mode)
  }
  // 落盘过的旧会话没有 mode 字段：锁冷咖啡，避免设置页一切就把长会话内核换掉。
  if (state !== undefined && state !== null) return DEFAULT_ARMOR_MODE
  return settingsArmorMode(settings)
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 桌面设置的内存态：{ plugins, coldbrew: { defaultEnabled, profiles } }，与 settingsPath 双向同步。 */
let settingsCache = {}

function loadSettingsSync() {
  const dest = settingsFile()
  migrateLegacyFile(dest, legacySettingsFile())
  try {
    settingsCache = JSON.parse(readFileSync(dest, 'utf8'))
  } catch {
    settingsCache = {}
  }
  return settingsCache
}

async function getSettings() {
  const dest = settingsFile()
  migrateLegacyFile(dest, legacySettingsFile())
  const settings = await (async () => {
    if (await pathExists(dest)) {
      return JSON.parse(await readFile(dest, 'utf8'))
    }
    return { plugins: {} }
  })()
  settingsCache = settings
  return settings
}

async function saveSettings(settings) {
  settingsCache = settings
  const dest = settingsFile()
  await mkdir(userDataHome(), { recursive: true })
  await writeFile(dest, JSON.stringify(settings, null, 2))
}

/** 每个会话的破甲开关状态：{ [sessionId]: { enabled, model } }，落盘持久化。 */
async function getColdbrewSessions() {
  return loadSessionStatesSync()
}

/** 同步版：systemPrompt text provider 是同步求值的，直接读内存态。 */
function getColdbrewSessionsSync() {
  return loadSessionStatesSync()
}

async function saveColdbrewSessions(sessions) {
  sessionStates = sessions
  const dest = coldbrewStateFile()
  await mkdir(userDataHome(), { recursive: true })
  await writeFile(dest, JSON.stringify(sessions, null, 2))
}

/**
 * 取会话当前实际使用的模型名（用于匹配 ColdBrew profile）。
 *
 * 优先级：
 * 1. 最近一次请求头里的模型（agent 中途切换模型后，agent.options 不会更新，
 *    但 requestHeader 会记录每步实际请求的 provider/model——这是最准的）；
 * 2. agent 创建时的 options.model（首条消息还没发出任何请求时唯一可用）；
 * 3. 会话显式记录里的 model（用户在输入框开开关那一刻 UI 看到的模型名）。
 */
function currentAgentModel(agent, state) {
  const headerModel = agent?.session?.requestHeader?.()?.config?.model
  if (headerModel) return headerModel
  const optionsModel = agent?.options?.model
  if (optionsModel) return optionsModel
  return state?.model ?? ''
}

/**
 * 计算某个会话（agent）当前的破甲开关与命中 profile。
 *
 * 优先级（从高到低）：
 * 1. 会话显式记录（用户在该会话的输入框手动开关过）：以记录的 enabled 为准；
 * 2. 沿父会话链（子代理/任务代理）回溯：父会话开着的破甲，子代理沿用同一个
 *    profile。用 `agent.ctx.agents` 拿到真实的父 agent 再继续向上，而不是
 *    构造带 id 的轻量对象——后者只能回溯一层，深层子代理会断链；
 * 3. 默认规则：全局开关「所有新会话默认开启破甲」优先，其次看当前模型命中的
 *    profile 是否被设成「新会话默认开启」；模型取 agent 当前实际使用的模型，
 *    而不是开启开关那一刻的快照——这样中途切换模型，profile 会跟着换。
 *
 * 返回 { enabled, profile, mode }；任何异常回落「关闭」（组装路径上抛错会打断整个 turn）。
 */
function resolveColdbrewState(agent) {
  try {
    const sessionId = agent?.id
    if (!sessionId) return { enabled: false, profile: null, mode: DEFAULT_ARMOR_MODE }
    const sessions = loadSessionStatesSync()
    const settings = loadSettingsSync()
    const fallbackMode = settingsArmorMode(settings)

    // 沿 agent → 父会话链收集真实 agent：显式记录 > 父会话继承 > 默认规则。
    const registry = agent?.ctx?.agents
    const chain = []
    const seen = new Set()
    let cursor = agent
    while (cursor !== undefined && cursor !== null) {
      if (seen.has(String(cursor.id))) break
      seen.add(String(cursor.id))
      chain.push(cursor)
      const parentId = cursor?.session?.header?.parentSession
      if (parentId === undefined) break
      // 优先用 registry 解析父 agent（能继续向上回溯）；拿不到就停在当前层。
      cursor = registry?.get?.(parentId) ?? null
    }

    for (const candidate of chain) {
      const state = sessions[String(candidate.id)]
      if (state === undefined) continue
      if (!state.enabled) return { enabled: false, profile: null, mode: sessionArmorMode(state, settings) }
      // 显式记录命中：profile 用当前 agent 实际模型匹配（模型中途切换则跟随），
      // 记录里的 model 只是开关开启时 UI 看到的模型名，作后备。
      const model = currentAgentModel(agent, state)
      const profile = PROFILES[matchProfileId(model)]
      const mode = sessionArmorMode(state, settings)
      return profile === undefined
        ? { enabled: false, profile: null, mode }
        : { enabled: true, profile, mode }
    }

    // 无任何显式记录（新会话）：按默认规则计算。
    const model = currentAgentModel(agent, null)
    const matched = matchProfileId(model)
    const defaultEnabled = settings.coldbrew?.defaultEnabled === true
      || (matched !== null
        && settings.coldbrew?.profiles?.[matched]?.defaultEnabled === true)
    if (!defaultEnabled) return { enabled: false, profile: null, mode: fallbackMode }
    const profile = PROFILES[matched]
    return profile === undefined
      ? { enabled: false, profile: null, mode: fallbackMode }
      : { enabled: true, profile, mode: fallbackMode }
  } catch {
    return { enabled: false, profile: null, mode: DEFAULT_ARMOR_MODE }
  }
}

function run(command, args, options = {}) {
  taskLogs.push(`$ ${command} ${args.join(' ')}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: process.env,
      shell: false,
    })
    child.stdout.on('data', chunk => { taskLogs.push(chunk.toString()) })
    child.stderr.on('data', chunk => { taskLogs.push(chunk.toString()) })
    child.once('error', (err) => {
      taskLogs.push(`Error: ${err.message}`)
      reject(err)
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        taskLogs.push(`Done.`)
        resolve()
        return
      }
      const msg = `Exit ${code}`
      taskLogs.push(msg)
      reject(new Error(msg))
    })
  })
}

export function apply(ctx) {
  // 按会话注入系统提示词：文本提供器在每次组装时以该会话的 agent 为 scope 求值，
  // 会话开关开启且模型命中某个 profile 时返回对应破甲正文，否则返回空串（不贡献内容）。
  // 任何内部异常都回落空串——组装路径上抛错会打断整个 turn。
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'coldbrew:session-profile',
    order: 195,
    text: (context) => {
      // 每次组装都以当前 agent 为 scope 求值；返回空串表示本会话不贡献破甲正文。
      const agent = context?.scope
      const { enabled, profile, mode } = resolveColdbrewState(agent)
      if (!enabled || profile === null) return ''
      return loadPromptSync(profile, mode)
    },
  }), 'dsh-desktop-manager: coldbrew session profile')

  // 工具：让模型能取回五个 profile 的元数据与正文（与 infinite_gen1_profile 同型）。
  ctx.effect(() => ctx.tools.register({
    name: 'coldbrew_profiles',
    description: 'Return the bundled ColdBrew 冷咖啡 破甲 profiles for the five models (GPT-5.6/Codex, Claude Code, Grok 4.6, DeepSeek v4 Pro, GLM 5.3).',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute() {
      const profiles = Object.values(PROFILES).map(profile => ({
        id: profile.id,
        name: profile.name,
        short: profile.short,
        patterns: profile.patterns,
        prompt: loadPromptSync(profile, DEFAULT_ARMOR_MODE),
        reverifyPrompt: loadPromptSync(profile, 'reverify'),
      }))
      return {
        version: '2.1.0',
        control: 'BREAK//OPEN',
        modes: ARMOR_MODES,
        reverifyVersion: REVERIFY_VERSION,
        profiles,
        defaultProfile: 'deepseek',
      }
    },
  }), 'dsh-desktop-manager: coldbrew profiles tool')

  // Reverify MCP 有的工具返回 object，有的返回 array（re_disasm）。
  // 无约束 JSON schema 才能让两种都通过 tools 输出校验。
  const jsonOutput = {
    schema: {},
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
  }
  for (const tool of REVERIFY_TOOLS) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: jsonOutput,
      async execute(args) {
        return runReverifyTool(tool.name, args ?? {})
      },
    }), `dsh-desktop-manager: ${tool.name}`)
  }

  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/desktop-manager',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const action = url.pathname.split('/').pop()

      if (req.method === 'GET') {
        if (action === 'status') {
          const installed = await pathExists(join(pluginsRoot, 'dsh-infinite-gen-1'))
          const settings = await getSettings()
          const enabled = settings.plugins['dsh-infinite-gen-1']?.enabled !== false
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ installed, enabled, isRunning }))
          return
        }
        if (action === 'logs') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ logs: taskLogs, isRunning }))
          return
        }
      }

      if (req.method === 'POST') {
        if (isRunning) {
          res.writeHead(409)
          res.end('Task already running')
          return
        }

        isRunning = true
        taskLogs = []

        try {
          if (action === 'install') {
            const target = join(pluginsRoot, 'dsh-infinite-gen-1')
            if (!await pathExists(target)) {
              await run('git', ['clone', 'https://github.com/Minglink/dsh-infinite-gen-1.git', target])
              await run('pnpm', ['install'], { cwd: target })
            }
            res.writeHead(200)
            res.end('OK')
          } else if (action === 'uninstall') {
            const target = join(pluginsRoot, 'dsh-infinite-gen-1')
            await rm(target, { recursive: true, force: true })
            res.writeHead(200)
            res.end('OK')
          } else if (action === 'toggle') {
            const settings = await getSettings()
            const current = settings.plugins['dsh-infinite-gen-1']?.enabled !== false
            settings.plugins['dsh-infinite-gen-1'] = { enabled: !current }
            await saveSettings(settings)
            res.writeHead(200)
            res.end('OK')
          } else {
            res.writeHead(404)
            res.end()
          }
        } catch (error) {
          console.error(error)
          res.writeHead(500)
          res.end(error.message)
        } finally {
          isRunning = false
        }
        return
      }

      res.writeHead(404)
      res.end()
    },
  })

  ctx.webServer.register({
    kind: 'prefix',
    path: '/api/coldbrew',
    handler: async (req, res) => {
      const url = new URL(req.url, 'http://localhost')
      const segments = url.pathname.split('/').filter(Boolean) // ['api','coldbrew',...]
      const action = segments[2]

      if (req.method === 'GET') {
        if (action === 'profiles') {
          const settings = await getSettings()
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            // 全局开关：新会话是否一进来就开着破甲，省去每次手动打开。
            version: '2.1.0',
            control: 'BREAK//OPEN',
            title: 'gpt5.6-claude-grok4.6-deepseekv4pro-glm5.3破甲越狱',
            defaultEnabled: settings.coldbrew?.defaultEnabled === true,
            armorMode: settingsArmorMode(settings),
            modes: [
              { id: 'coldbrew', name: '冷咖啡 ColdBrew 2.1.0', control: 'BREAK//OPEN' },
              { id: 'reverify', name: 'Reverify 0.9.0', control: 'bytes-as-judge' },
            ],
            reverify: await probeReverify(),
            profiles: Object.values(PROFILES).map(p => ({
              id: p.id,
              name: p.name,
              short: p.short,
              patterns: p.patterns,
              defaultEnabled: settings.coldbrew?.profiles?.[p.id]?.defaultEnabled === true,
            })),
          }))
          return
        }
        if (action === 'session') {
          const sessionId = decodeURIComponent(segments[3] ?? '')
          const sessions = await getColdbrewSessions()
          // 还没有记录的会话（也就是新会话）取默认值：全局开关优先，其次看
          // 当前模型命中的那个 profile 是否被设成「新会话默认开启」。
          const settings = await getSettings()
          const model = url.searchParams.get('model') ?? ''
          const matched = matchProfileId(model)
          const defaultEnabled = settings.coldbrew?.defaultEnabled === true
            || (matched !== null
              && settings.coldbrew?.profiles?.[matched]?.defaultEnabled === true)
          const persisted = sessionId ? sessions[String(sessionId)] : undefined
          const mode = persisted ? sessionArmorMode(persisted, settings) : settingsArmorMode(settings)
          let state = persisted ?? { enabled: defaultEnabled, model, mode }
          if (persisted === undefined && sessionId) {
            state = { enabled: defaultEnabled, model, mode }
            sessions[String(sessionId)] = state
            await saveColdbrewSessions(sessions)
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ...state,
            mode,
            profileId: state.enabled ? matchProfileId(state.model) : null,
          }))
          return
        }
        if (action === 'reverify') {
          const sub = segments[3] ?? 'status'
          if (sub === 'logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(installStatusPayload()))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(await probeReverify()))
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      if (req.method === 'POST') {
        if (action === 'mode') {
          let body = ''
          for await (const chunk of req) body += chunk
          let payload = {}
          try { payload = JSON.parse(body) } catch { /* tolerate empty body */ }
          const settings = await getSettings()
          settings.coldbrew ??= {}
          settings.coldbrew.armorMode = normalizeArmorMode(payload.mode ?? payload.armorMode)
          await saveSettings(settings)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ armorMode: settings.coldbrew.armorMode }))
          return
        }
        if (action === 'reverify') {
          const sub = segments[3] ?? 'status'
          if (sub === 'install' || sub === 'extras') {
            if (isRunning) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Task already running', ...installStatusPayload() }))
              return
            }
            let raw = ''
            for await (const chunk of req) raw += chunk
            let payload = {}
            try { payload = JSON.parse(raw) } catch { /* empty */ }
            const which = payload.extra === 'angr' ? 'angr' : 'full'
            isRunning = true
            taskLogs = []
            installJob = { extra: which, error: null, result: null, live: '' }
            appendTaskLog(which === 'angr' ? '开始加装调用图引擎…' : '开始安装高精度引擎…')
            appendTaskLog('下载可能要几分钟，日志会持续刷出来。')
            void installReverifyExtras(which, appendTaskLog)
              .then((status) => {
                installJob.result = status
                appendTaskLog(which === 'angr' ? '调用图引擎已装好' : '高精度引擎已装好')
              })
              .catch((error) => {
                const message = String(error?.message ?? error)
                installJob.error = message
                appendTaskLog(message)
              })
              .finally(() => {
                isRunning = false
              })
            res.writeHead(202, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ started: true, ...installStatusPayload() }))
            return
          }
          if (sub === 'uninstall') {
            if (isRunning) {
              res.writeHead(409, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: 'Task already running', ...installStatusPayload() }))
              return
            }
            isRunning = true
            taskLogs = []
            installJob = { extra: 'uninstall', error: null, result: null, live: '' }
            appendTaskLog('开始卸载可选引擎…')
            void uninstallReverifyExtras(appendTaskLog)
              .then((status) => {
                installJob.result = status
                appendTaskLog('可选引擎已卸掉')
              })
              .catch((error) => {
                const message = String(error?.message ?? error)
                installJob.error = message
                appendTaskLog(message)
              })
              .finally(() => {
                isRunning = false
              })
            res.writeHead(202, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ started: true, ...installStatusPayload() }))
            return
          }
          if (sub === 'logs') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(installStatusPayload()))
            return
          }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(await probeReverify()))
          return
        }
        if (action === 'default') {
          let body = ''
          for await (const chunk of req) body += chunk
          let payload = {}
          try { payload = JSON.parse(body) } catch { /* tolerate empty body */ }
          const settings = await getSettings()
          settings.coldbrew ??= {}
          settings.coldbrew.defaultEnabled = payload.enabled === true
          await saveSettings(settings)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ defaultEnabled: payload.enabled === true }))
          return
        }
        if (action === 'profile') {
          const profileId = decodeURIComponent(segments[3] ?? '')
          if (PROFILES[profileId] === undefined) {
            res.writeHead(404)
            res.end('unknown profile')
            return
          }
          let body = ''
          for await (const chunk of req) body += chunk
          let payload = {}
          try { payload = JSON.parse(body) } catch { /* tolerate empty body */ }
          const settings = await getSettings()
          settings.coldbrew ??= {}
          settings.coldbrew.profiles ??= {}
          settings.coldbrew.profiles[profileId] = { defaultEnabled: payload.enabled === true }
          await saveSettings(settings)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: profileId, defaultEnabled: payload.enabled === true }))
          return
        }
        if (action === 'session') {
          const sessionId = decodeURIComponent(segments[3] ?? '')
          if (!sessionId) {
            res.writeHead(400)
            res.end('missing session id')
            return
          }
          let body = ''
          for await (const chunk of req) body += chunk
          let payload = {}
          try { payload = JSON.parse(body) } catch { /* tolerate empty body */ }
          const sessions = await getColdbrewSessions()
          const settings = await getSettings()
          const previous = sessions[String(sessionId)]
          // 第一次落盘锁全局模式：输入框开关可能带着过期的 React mode，
          // 不能把新会话从 Reverify 打回冷咖啡。已有记录才接受 payload.mode。
          const nextMode = previous === undefined
            ? settingsArmorMode(settings)
            : payload.mode === undefined
              ? sessionArmorMode(previous, settings)
              : normalizeArmorMode(payload.mode)
          sessions[String(sessionId)] = {
            enabled: payload.enabled === true,
            model: String(payload.model ?? previous?.model ?? ''),
            mode: nextMode,
          }
          await saveColdbrewSessions(sessions)
          const state = sessions[String(sessionId)]
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            ...state,
            profileId: state.enabled ? matchProfileId(state.model) : null,
          }))
          return
        }
        res.writeHead(404)
        res.end()
        return
      }

      res.writeHead(404)
      res.end()
    },
  })
}

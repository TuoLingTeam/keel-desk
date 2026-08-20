import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { access, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-desktop-manager'
export const inject = ['webServer', 'loader', 'systemPrompt', 'tools']

const repositoryRoot = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))
const pluginsRoot = join(repositoryRoot, 'plugins')
const settingsPath = join(repositoryRoot, 'desktop-settings.json')
const coldbrewStatePath = join(repositoryRoot, 'coldbrew-sessions.json')
const profilesDir = join(dirname(fileURLToPath(import.meta.url)), 'profiles')

let taskLogs = []
let isRunning = false

/** 会话破甲开关的内存态：{ [sessionId]: { enabled, model } }，与 coldbrewStatePath 双向同步。 */
let sessionStates = {}
let sessionStatesLoaded = false

function loadSessionStatesSync() {
  if (sessionStatesLoaded) return sessionStates
  try {
    sessionStates = JSON.parse(readFileSync(coldbrewStatePath, 'utf8'))
  } catch {
    sessionStates = {}
  }
  sessionStatesLoaded = true
  return sessionStates
}

/** 四个模型的 ColdBrew 破甲 profile 元数据；提示词正文在 profilesDir 下按 id 存放。 */
const PROFILES = {
  codex: {
    id: 'codex',
    name: 'GPT-5.6 / Codex',
    short: 'Codex 破甲 · 石井 Solo',
    file: 'codex.md',
    // 模型名命中规则（大小写不敏感，取第一个命中）
    patterns: ['gpt', 'codex', 'o1', 'o3'],
  },
  claude: {
    id: 'claude',
    name: 'Claude Code',
    short: 'Claude 破甲 · 冷咖啡',
    file: 'claude.md',
    patterns: ['claude'],
  },
  grok: {
    id: 'grok',
    name: 'Grok 4.6',
    short: 'Grok 破甲 · 冷咖啡',
    file: 'grok.md',
    patterns: ['grok'],
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek v4 Pro',
    short: 'DeepSeek 破甲 · 冷咖啡',
    file: 'deepseek.md',
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

/** 读一份 profile 提示词正文（同步，启动时一次性缓存；正文必须同步求值给 systemPrompt section）。 */
const promptCache = new Map()
function loadPromptSync(profile) {
  if (!promptCache.has(profile.id)) {
    const path = join(profilesDir, profile.file)
    promptCache.set(profile.id, readFileSync(path, 'utf8'))
  }
  return promptCache.get(profile.id)
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function getSettings() {
  if (await pathExists(settingsPath)) {
    return JSON.parse(await readFile(settingsPath, 'utf8'))
  }
  return { plugins: {} }
}

async function saveSettings(settings) {
  await writeFile(settingsPath, JSON.stringify(settings, null, 2))
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
  sessionStatesLoaded = true
  await writeFile(coldbrewStatePath, JSON.stringify(sessions, null, 2))
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
    order: 150,
    text: (context) => {
      try {
        const agent = context?.scope
        const sessionId = agent?.id
        if (!sessionId) return ''
        const sessions = getColdbrewSessionsSync()
        const state = sessions[String(sessionId)]
        if (!state?.enabled) return ''
        const profile = PROFILES[matchProfileId(state.model)]
        if (profile === undefined) return ''
        return loadPromptSync(profile)
      } catch {
        return ''
      }
    },
  }), 'dsh-desktop-manager: coldbrew session profile')

  // 工具：让模型能取回四个 profile 的元数据与正文（与 infinite_gen1_profile 同型）。
  ctx.effect(() => ctx.tools.register({
    name: 'coldbrew_profiles',
    description: 'Return the bundled ColdBrew 冷咖啡 破甲 profiles for the four models (GPT-5.6/Codex, Claude Code, Grok 4.6, DeepSeek v4 Pro).',
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
        prompt: loadPromptSync(profile),
      }))
      return { profiles, defaultProfile: 'deepseek' }
    },
  }), 'dsh-desktop-manager: coldbrew profiles tool')

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
          const state = sessions[String(sessionId)] ?? { enabled: false, model: '' }
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

      if (req.method === 'POST') {
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
          sessions[String(sessionId)] = {
            enabled: payload.enabled === true,
            model: String(payload.model ?? ''),
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

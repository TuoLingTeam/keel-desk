// dsh-quick-commands — HOST half. Persists the shared quick-commands table and
// exposes it to the browser half over HTTP (the only client↔host channel).
//
// The store is the SAME file the sibling "Pchat 助手" (codex-desktop) app uses
// (see shared-path.mjs), so an edit in either app shows up in the other on its
// next read. Every mutation runs load→transform→persist on a serial queue and
// re-reads fresh from disk first, so the two apps never clobber each other's
// table wholesale; the write itself is atomic (tmp + rename). Domain rules live
// in quick-commands-core.mjs; this layer is orchestration + I/O + routing only.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import {
  applyImport,
  createCommand,
  exportFileName,
  isValidCommandText,
  parseImportPayload,
  parseStoredQuickCommands,
  removeCommand,
  reorderCommands,
  seedDefaultQuickCommands,
  setCommandPinned,
  toExportPayload,
  toStoredFile,
  updateCommand,
} from './quick-commands-core.mjs'
import { quickCommandsFilePath } from './shared-path.mjs'

export const name = 'dsh-quick-commands'
export const inject = ['webServer']
export const ROUTE_PREFIX = '/dsh-quick-commands'

// ---- storage (serial queue + atomic write against the shared file) ----------

let chain = Promise.resolve()
function enqueue(op) {
  const next = chain.then(op, op)
  chain = next.then(() => undefined, () => undefined)
  return next
}

async function load() {
  let raw
  try {
    raw = await readFile(quickCommandsFilePath(), 'utf8')
  } catch {
    raw = undefined
  }
  let data
  if (raw !== undefined) {
    try { data = JSON.parse(raw) } catch { data = undefined }
  }
  const { commands, needsRewrite } = parseStoredQuickCommands(data)
  if (needsRewrite) await persist(commands)
  return commands
}

async function persist(commands) {
  const target = quickCommandsFilePath()
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(toStoredFile(commands), null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

const listCommands = () => enqueue(() => load())

const mutate = (transform) => enqueue(async () => {
  const next = transform(await load())
  await persist(next)
  return next
})

// ---- HTTP plumbing ----------------------------------------------------------

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** A structured, client-facing failure with an HTTP status. */
function fail(status, error) {
  const err = new Error(error)
  err.httpStatus = status
  return err
}

async function handle(method, tail, req) {
  if (method === 'GET' && tail === '/list') {
    return { commands: await listCommands() }
  }
  if (method === 'GET' && tail === '/path') {
    return { path: quickCommandsFilePath() }
  }
  if (method === 'GET' && tail === '/export') {
    const commands = await listCommands()
    const now = new Date()
    return {
      fileName: exportFileName(now.getFullYear(), now.getMonth() + 1, now.getDate()),
      payload: toExportPayload(commands, now.toISOString()),
    }
  }
  if (method !== 'POST') throw fail(404, 'not found')

  const body = await readBody(req)

  if (tail === '/create') {
    if (!isValidCommandText(body.text)) throw fail(400, '指令内容不能为空白（且不超过 20000 字符）')
    return { commands: await mutate((existing) => createCommand(existing, body.text)) }
  }
  if (tail === '/update') {
    if (typeof body.id !== 'string' || !body.id) throw fail(400, '缺少 id')
    if (!isValidCommandText(body.text)) throw fail(400, '指令内容不能为空白（且不超过 20000 字符）')
    let missing = false
    const commands = await mutate((existing) => {
      const next = updateCommand(existing, body.id, body.text)
      if (next === null) { missing = true; return existing }
      return next
    })
    if (missing) throw fail(404, '该指令不存在或已被删除')
    return { commands }
  }
  if (tail === '/remove') {
    if (typeof body.id !== 'string' || !body.id) throw fail(400, '缺少 id')
    return { commands: await mutate((existing) => removeCommand(existing, body.id)) }
  }
  if (tail === '/pin') {
    if (typeof body.id !== 'string' || !body.id) throw fail(400, '缺少 id')
    if (typeof body.pinned !== 'boolean') throw fail(400, 'pinned 必须是布尔值')
    let missing = false
    const commands = await mutate((existing) => {
      const next = setCommandPinned(existing, body.id, body.pinned)
      if (next === null) { missing = true; return existing }
      return next
    })
    if (missing) throw fail(404, '该指令不存在或已被删除')
    return { commands }
  }
  if (tail === '/reorder') {
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== 'string')) throw fail(400, 'ids 非法')
    let stale = false
    const commands = await mutate((existing) => {
      const next = reorderCommands(existing, body.ids)
      if (next === null) { stale = true; return existing }
      return next
    })
    if (stale) throw fail(409, '指令列表已变化，排序未生效，请刷新后重试')
    return { commands }
  }
  if (tail === '/import') {
    if (!Array.isArray(body.texts) || body.texts.some((text) => !isValidCommandText(text))) throw fail(400, '没有可导入的指令')
    const mode = body.mode === 'replace' ? 'replace' : 'merge'
    let result = { imported: 0, skipped: 0 }
    const commands = await mutate((existing) => {
      result = applyImport(existing, body.texts, mode)
      return result.commands
    })
    return { commands, imported: result.imported, skipped: result.skipped }
  }
  if (tail === '/reset') {
    return { commands: await mutate(() => seedDefaultQuickCommands()) }
  }
  throw fail(404, 'not found')
}

export function apply(ctx) {
  const route = async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.local')
      const tail = url.pathname.slice(ROUTE_PREFIX.length) || '/'
      const value = await handle(req.method ?? 'GET', tail, req)
      sendJson(res, 200, { ok: true, ...value })
    } catch (error) {
      const status = typeof error?.httpStatus === 'number' ? error.httpStatus : 500
      sendJson(res, status, { ok: false, error: String(error?.message ?? error) })
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: route }),
    'dsh-quick-commands: route',
  )
}

export const internals = { load, persist }

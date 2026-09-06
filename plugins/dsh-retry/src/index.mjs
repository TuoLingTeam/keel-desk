// dsh-retry — HOST half. Persists one global model-request retry count to
// <DSH_HOME>/dsh-retry.json ({ maxRetries }) and serves it over HTTP. The
// llm-retry executor reads the SAME file live and applies the value to every
// provider's normal-mode policy, so one settings field controls retries app-wide.
// Default 99999 → retries are effectively unlimited until the user narrows it.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

export const name = 'dsh-retry'
export const inject = ['webServer']
export const ROUTE_PREFIX = '/dsh-retry'

/** Default retry count — matches the llm-retry executor's fallback. */
export const DEFAULT_MAX_RETRIES = 99_999

function storeFile() {
  return join(resolve(process.env.DSH_HOME || join(homedir(), '.dsh')), 'dsh-retry.json')
}

async function load() {
  try {
    const parsed = JSON.parse(await readFile(storeFile(), 'utf8'))
    const value = parsed?.maxRetries
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
  } catch { /* absent / unreadable → default */ }
  return DEFAULT_MAX_RETRIES
}

async function save(value) {
  const target = storeFile()
  await mkdir(dirname(target), { recursive: true })
  const tmp = `${target}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify({ maxRetries: value }, null, 2)}\n`, 'utf8')
  await rename(tmp, target)
}

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

export function apply(ctx) {
  const route = async (req, res) => {
    try {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, maxRetries: await load() })
        return
      }
      if (req.method === 'POST') {
        const body = await readBody(req)
        const value = body.maxRetries
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          sendJson(res, 400, { ok: false, error: '重试次数必须是 0 或正整数' })
          return
        }
        await save(value)
        sendJson(res, 200, { ok: true, maxRetries: value })
        return
      }
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: route }),
    'dsh-retry: route',
  )
}

export const internals = { load, save, storeFile }

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

test('RPC handle on desktop always passes loopback authority', async () => {
  const src = await readFile(join(root, 'src', 'stats.ts'), 'utf8')
  assert.match(src, /rpc\.handle\(\s*'\s*\/rpc'/)
  assert.match(src, /authority:\s*'loopback'/)
})

test('composer inject reads sessionId from InputZone snapshot', async () => {
  const src = await readFile(join(root, 'client', 'src', 'entry.tsx'), 'utf8')
  assert.match(src, /sessionIdOf/)
  assert.match(src, /zone\?\.session\?\.sessionId/)
})

test('settings cards do not draw content borders', async () => {
  const theme = await readFile(join(root, 'client', 'src', 'theme.ts'), 'utf8')
  assert.match(theme, /\.dsh-mem-card \{[\s\S]*border: none/)
  assert.match(theme, /\.dsh-mem-stack \{/)
  assert.match(theme, /\.dsh-mem-stats \{/)
  assert.match(theme, /\.dsh-mem-empty \{/)
  assert.match(theme, /\.dsh-mem-ws-tabs \{[\s\S]*border-bottom: 1px solid/)
})

test('built client handoff uses package name', async () => {
  const client = await readFile(join(root, 'lib', 'client.js'), 'utf8')
  assert.equal(client.startsWith('window.__ModuleLoader__.load({'), true)
  assert.match(client, /id: "dsh-layered-memory"/)
  assert.match(client, /require\("react"\)/)
})

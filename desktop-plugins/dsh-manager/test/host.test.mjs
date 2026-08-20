import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, matchProfileId, name } from '../src/index.mjs'

test('host plugin exposes the desktop manager name', () => {
  assert.equal(name, 'dsh-desktop-manager')
})

test('matchProfileId routes model names to ColdBrew profiles', () => {
  assert.equal(matchProfileId('deepseek-v4-flash'), 'deepseek')
  assert.equal(matchProfileId('deepseek-v4-pro'), 'deepseek')
  assert.equal(matchProfileId('grok-4.6'), 'grok')
  assert.equal(matchProfileId('claude-sonnet-4'), 'claude')
  assert.equal(matchProfileId('gpt-5.6'), 'codex')
  assert.equal(matchProfileId('codex-1'), 'codex')
  assert.equal(matchProfileId('o3-mini'), 'codex')
  // 未知/空模型回落 DeepSeek
  assert.equal(matchProfileId('unknown-model'), 'deepseek')
  assert.equal(matchProfileId(''), 'deepseek')
  assert.equal(matchProfileId(null), 'deepseek')
})

test('apply registers coldbrew section, tool, and webServer routes', () => {
  const sections = []
  const tools = []
  const servers = []
  const ctx = {
    effect(fn) { fn() },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    webServer: { register(route) { servers.push(route) } },
  }
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'coldbrew:session-profile')
  assert.equal(tools.length, 1)
  assert.equal(tools[0].name, 'coldbrew_profiles')
  assert.equal(servers.length, 2)
  assert.deepEqual(servers.map(s => s.path).sort(), ['/api/coldbrew', '/api/desktop-manager'])
})

test('coldbrew session profile section returns empty text when disabled or unknown', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-manager-test-'))
  const statePath = join(home, 'coldbrew-sessions.json')
  writeFileSync(statePath, JSON.stringify({ 'sess-1': { enabled: true, model: 'grok-4.6' } }))
  // 状态路径指向仓库根目录；为隔离测试，仅验证文本提供器对「未命中」输入的行为
  const sections = []
  const ctx = {
    effect(fn) { fn() },
    systemPrompt: { section(section) { sections.push(section); return () => {} } },
    tools: { register() { return () => {} } },
    webServer: { register() {} },
  }
  apply(ctx)
  const provider = sections[0].text
  // 无 scope → 空
  assert.equal(provider({}), '')
  // 无 id 的 scope → 空
  assert.equal(provider({ scope: {} }), '')
  rmSync(home, { recursive: true, force: true })
})

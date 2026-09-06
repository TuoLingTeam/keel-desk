import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply, matchProfileId, name, settingsFile, normalizeArmorMode } from '../src/index.mjs'
import { REVERIFY_TOOLS, probeReverify, runReverifyTool, resolveHostPython } from '../src/reverify.mjs'

/** 把 DSH_HOME 指到临时目录，避免测到仓库根 / 安装包里的桌面设置。 */
function isolateHome() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-manager-home-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    settingsPath: join(home, 'desktop-settings.json'),
    statePath: join(home, 'coldbrew-sessions.json'),
    restore() {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      rmSync(home, { recursive: true, force: true })
    },
  }
}

function mockReq(method, url, body) {
  return {
    method,
    url,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(body)
    },
  }
}

function mockRes() {
  const result = { status: 0, body: '', headers: {} }
  return {
    result,
    writeHead(status, headers) {
      result.status = status
      result.headers = headers ?? {}
    },
    end(body) {
      result.body = body ?? ''
    },
  }
}

/** 构造带 ctx.agents 注册表的 agent（模拟真实 AgentRegistry，支持父链回溯）。 */
function mockRegistry() {
  const agents = new Map()
  const registry = { get: (id) => agents.get(id) }
  const mk = (id, model, parentSession) => {
    const agent = {
      id,
      options: { model },
      session: { header: { parentSession }, requestHeader: () => undefined },
      ctx: { agents: registry },
    }
    agents.set(id, agent)
    return agent
  }
  return { registry, mk }
}

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
  assert.equal(matchProfileId('glm-5.3'), 'glm')
  assert.equal(matchProfileId('chatglm-4'), 'glm')
  assert.equal(matchProfileId('zhipu-glm-5'), 'glm')
  // 未知/空模型回落 DeepSeek
  assert.equal(matchProfileId('unknown-model'), 'deepseek')
  assert.equal(matchProfileId(''), 'deepseek')
  assert.equal(matchProfileId(null), 'deepseek')
})

test('all five ColdBrew 2.1.0 seats share BREAK//OPEN kernel', async () => {
  const { apply: applyHost } = await import('../src/index.mjs')
  const tools = []
  const ctx = {
    effect(fn) { fn() },
    systemPrompt: { section() { return () => {} } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    webServer: { register() {} },
  }
  applyHost(ctx)
  const payload = tools[0].execute()
  assert.equal(payload.version, '2.1.0')
  assert.equal(payload.control, 'BREAK//OPEN')
  assert.deepEqual(payload.modes, ['coldbrew', 'reverify'])
  assert.equal(payload.reverifyVersion, '0.9.0')
  const ids = payload.profiles.map(p => p.id).sort()
  assert.deepEqual(ids, ['claude', 'codex', 'deepseek', 'glm', 'grok'])
  for (const profile of payload.profiles) {
    assert.match(profile.prompt, /ColdBrew Zero 2\.1\.0/)
    assert.match(profile.prompt, /BREAK\/\/OPEN/)
    assert.match(profile.prompt, /FiveEdge/)
    assert.match(profile.prompt, /GLM 5\.3/)
    assert.match(profile.prompt, /本会话已经 MAX/)
    assert.match(profile.prompt, /第一句用户消息就是任务/)
    assert.match(profile.prompt, /\[\[ENI:PROFILE=MAX\]\]/)
    assert.match(profile.prompt, /\[\[CB:MAX\]\]/)
    assert.match(profile.reverifyPrompt, /REVERIFY/)
    assert.match(profile.reverifyPrompt, /re_verify_claim/)
    assert.match(profile.reverifyPrompt, /\[\[RV:VERIFY\]\]/)
    assert.match(profile.reverifyPrompt, /冷咖啡 ColdBrew 2\.1\.0 仍在/)
  }
  const byId = Object.fromEntries(payload.profiles.map(p => [p.id, p.prompt]))
  assert.match(byId.codex, /开关开启即 MAX/)
  assert.match(byId.claude, /开关开启即 MAX/)
  assert.match(byId.grok, /开关开启即 MAX/)
  assert.match(byId.deepseek, /开关开启即 MAX/)
  assert.match(byId.glm, /开关开启即 MAX/)
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
  assert.equal(sections[0].order, 195)
  assert.equal(tools[0].name, 'coldbrew_profiles')
  assert.deepEqual(tools.slice(1).map(t => t.name), REVERIFY_TOOLS.map(t => t.name))
  assert.equal(servers.length, 2)
  assert.deepEqual(servers.map(s => s.path).sort(), ['/api/coldbrew', '/api/desktop-manager'])
})

test('normalizeArmorMode only accepts reverify or coldbrew', () => {
  assert.equal(normalizeArmorMode('reverify'), 'reverify')
  assert.equal(normalizeArmorMode('coldbrew'), 'coldbrew')
  assert.equal(normalizeArmorMode('nope'), 'coldbrew')
  assert.equal(normalizeArmorMode(undefined), 'coldbrew')
})

test('reverify mode injects bytes-as-judge kernel for every seat', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: true, armorMode: 'reverify' },
    }))
    writeFileSync(isolated.statePath, JSON.stringify({}))
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(ctx)
    const provider = sections[0].text
    for (const model of ['gpt-5.6', 'claude-sonnet-4', 'grok-4.6', 'glm-5.3', 'deepseek-v4']) {
      const agent = { id: `sess-${model}`, options: { model }, session: { header: {}, requestHeader: () => undefined } }
      const text = provider({ scope: agent })
      assert.match(text, /REVERIFY/, `${model} must inject Reverify kernel`)
      assert.match(text, /re_verify_claim/)
      assert.equal(/ColdBrew Zero 2\.1\.0/.test(text), false, `${model} must not inject ColdBrew kernel`)
    }
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: true, armorMode: 'coldbrew' },
    }))
    const grok = { id: 'sess-back', options: { model: 'grok-4.6' }, session: { header: {}, requestHeader: () => undefined } }
    assert.match(provider({ scope: grok }), /ColdBrew Zero 2\.1\.0/)
  } finally {
    isolated.restore()
  }
})

test('legacy sessions without mode stay on coldbrew after global switch', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: false, armorMode: 'reverify' },
    }))
    writeFileSync(isolated.statePath, JSON.stringify({
      'legacy-sess': { enabled: true, model: 'grok-4.6' },
    }))
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(ctx)
    const provider = sections[0].text
    const agent = { id: 'legacy-sess', options: { model: 'grok-4.6' }, session: { header: {}, requestHeader: () => undefined } }
    const text = provider({ scope: agent })
    assert.match(text, /ColdBrew Zero 2\.1\.0/)
    assert.equal(/REVERIFY \| THE AI PROPOSES/.test(text), false)
  } finally {
    isolated.restore()
  }
})

test('POST /api/coldbrew/mode persists armorMode under DSH_HOME', async () => {
  const isolated = isolateHome()
  try {
    const servers = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section() { return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register(route) { servers.push(route) } },
    }
    apply(ctx)
    const route = servers.find(entry => entry.path === '/api/coldbrew')
    const res = mockRes()
    await route.handler(mockReq('POST', '/api/coldbrew/mode', JSON.stringify({ mode: 'reverify' })), res)
    assert.equal(res.result.status, 200)
    assert.equal(JSON.parse(readFileSync(isolated.settingsPath, 'utf8')).coldbrew.armorMode, 'reverify')
    const get = mockRes()
    await route.handler(mockReq('GET', '/api/coldbrew/profiles'), get)
    const body = JSON.parse(get.result.body)
    assert.equal(body.armorMode, 'reverify')
    assert.equal(body.reverify.version, '0.9.0')
    assert.equal(body.reverify.present, true)
  } finally {
    isolated.restore()
  }
})

test('GET /api/coldbrew/reverify/logs is available while install is idle', async () => {
  const isolated = isolateHome()
  try {
    const servers = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section() { return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register(route) { servers.push(route) } },
    }
    apply(ctx)
    const route = servers.find(entry => entry.path === '/api/coldbrew')
    const res = mockRes()
    await route.handler(mockReq('GET', '/api/coldbrew/reverify/logs'), res)
    assert.equal(res.result.status, 200)
    const body = JSON.parse(res.result.body)
    assert.equal(body.isRunning, false)
    assert.ok(Array.isArray(body.logs))
    assert.equal(typeof body.live, 'string')
  } finally {
    isolated.restore()
  }
})

test('host python prefers 3.10+ when Homebrew python3.12 exists', async () => {
  const host = await resolveHostPython(process.env, { major: 3, minor: 10 })
  if (host.error) {
    assert.match(host.error, /Python 3\.10/)
    return
  }
  const [major, minor] = String(host.version).split('.').map(Number)
  assert.ok(major > 3 || (major === 3 && minor >= 10), host.version)
})

test('vendored reverify actually disassembles bytes', async () => {
  const probe = await probeReverify()
  assert.equal(probe.present, true)
  if (probe.python?.error) {
    assert.ok(probe.python.error.includes('Python'), probe.python.error)
    return
  }
  assert.equal(probe.ok, true)
  const disasm = await runReverifyTool('re_disasm', { hex_bytes: '90505831C0C3', arch: 'x86_64' })
  assert.ok(Array.isArray(disasm), JSON.stringify(disasm))
  assert.equal(disasm[0].mnemonic, 'nop')
  const backends = await runReverifyTool('re_backends', {})
  assert.equal(typeof backends.disassembly.engine, 'string')
})

test('GET new session pins global armorMode so later settings edits cannot leak', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: true, armorMode: 'reverify' },
    }))
    writeFileSync(isolated.statePath, JSON.stringify({}))
    const servers = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section() { return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register(route) { servers.push(route) } },
    }
    apply(ctx)
    const route = servers.find(entry => entry.path === '/api/coldbrew')
    const get = mockRes()
    await route.handler(mockReq('GET', '/api/coldbrew/session/pinned-sess?model=grok-4.6'), get)
    assert.equal(JSON.parse(get.result.body).mode, 'reverify')
    assert.equal(JSON.parse(readFileSync(isolated.statePath, 'utf8'))['pinned-sess'].mode, 'reverify')
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: true, armorMode: 'coldbrew' },
    }))
    const get2 = mockRes()
    await route.handler(mockReq('GET', '/api/coldbrew/session/pinned-sess?model=grok-4.6'), get2)
    assert.equal(JSON.parse(get2.result.body).mode, 'reverify')
  } finally {
    isolated.restore()
  }
})

test('first session persist locks global armorMode and ignores stale client mode', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: true, armorMode: 'reverify' },
    }))
    writeFileSync(isolated.statePath, JSON.stringify({}))
    const servers = []
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register(route) { servers.push(route) } },
    }
    apply(ctx)
    const route = servers.find(entry => entry.path === '/api/coldbrew')
    const res = mockRes()
    await route.handler(mockReq('POST', '/api/coldbrew/session/new-sess', JSON.stringify({
      enabled: true,
      model: 'grok-4.6',
      mode: 'coldbrew',
    })), res)
    assert.equal(res.result.status, 200)
    const saved = JSON.parse(res.result.body)
    assert.equal(saved.mode, 'reverify')
    assert.equal(JSON.parse(readFileSync(isolated.statePath, 'utf8'))['new-sess'].mode, 'reverify')
    const agent = { id: 'new-sess', options: { model: 'grok-4.6' }, session: { header: {}, requestHeader: () => undefined } }
    const text = sections[0].text({ scope: agent })
    assert.match(text, /REVERIFY/)
    assert.equal(/ColdBrew Zero 2\.1\.0/.test(text), false)
  } finally {
    isolated.restore()
  }
})

test('child agents inherit parent Reverify mode through the agent chain', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({
      coldbrew: { defaultEnabled: false, armorMode: 'coldbrew' },
    }))
    writeFileSync(isolated.statePath, JSON.stringify({
      'parent-session': { enabled: true, model: 'grok-4.6', mode: 'reverify' },
    }))
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(ctx)
    const { mk } = mockRegistry()
    mk('parent-session', 'grok-4.6', undefined)
    mk('child-session', 'gpt-5.6', 'parent-session')
    const grandchild = mk('grandchild-session', 'claude-sonnet-4', 'child-session')
    const text = sections[0].text({ scope: grandchild })
    assert.match(text, /REVERIFY/)
    assert.match(text, /Claude Code · Reverify/)
    assert.equal(/ColdBrew Zero 2\.1\.0/.test(text), false)
  } finally {
    isolated.restore()
  }
})

test('re_verify_claim judges real bytes VERIFIED and REFUTED', async () => {
  const isolated = isolateHome()
  try {
    const sample = join(isolated.home, 'sample.bin')
    writeFileSync(sample, Buffer.from('MZ\x00\x00HELLO')) // 9 bytes
    const verified = await runReverifyTool('re_verify_claim', {
      file_path: sample,
      claims: [{ kind: 'bytes_at', params: { offset: 0, expected: '4d5a' }, note: 'MZ' }],
      record: false,
    }, { ...process.env, DSH_HOME: isolated.home })
    assert.equal(verified.error, undefined, JSON.stringify(verified))
    assert.equal(verified.results[0].verdict, 'VERIFIED')
    const refuted = await runReverifyTool('re_verify_claim', {
      file_path: sample,
      claims: [{ kind: 'bytes_at', params: { offset: 0, expected: '7f454c46' }, note: 'ELF lie' }],
      record: false,
    }, { ...process.env, DSH_HOME: isolated.home })
    assert.equal(refuted.results[0].verdict, 'REFUTED')
    const triage = await runReverifyTool('re_auto_triage', { file_path: sample }, { ...process.env, DSH_HOME: isolated.home })
    assert.equal(triage.size, 9)
  } finally {
    isolated.restore()
  }
})

test('registered re_* tools wrap both object and array MCP payloads', async () => {
  const tools = []
  const ctx = {
    effect(fn) { fn() },
    systemPrompt: { section() { return () => {} } },
    tools: { register(tool) { tools.push(tool); return () => {} } },
    webServer: { register() {} },
  }
  apply(ctx)
  const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]))
  assert.deepEqual(byName.re_disasm.output.schema, {})
  assert.deepEqual(byName.re_backends.output.schema, {})
  const disasm = await byName.re_disasm.execute({ hex_bytes: '90C3', arch: 'x86_64' })
  assert.ok(Array.isArray(disasm), JSON.stringify(disasm))
  assert.equal(disasm[0].mnemonic, 'nop')
  const backends = await byName.re_backends.execute({})
  assert.equal(typeof backends, 'object')
  assert.equal(typeof backends.disassembly.engine, 'string')
})

test('coldbrew session profile section returns empty text when disabled or unknown', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({ coldbrew: { defaultEnabled: false } }))
    writeFileSync(isolated.statePath, JSON.stringify({ 'sess-1': { enabled: true, model: 'grok-4.6' } }))
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(ctx)
    const provider = sections[0].text
    assert.equal(provider({}), '')
    assert.equal(provider({ scope: {} }), '')
  } finally {
    isolated.restore()
  }
})

test('coldbrew session profile applies default-enabled rules for new sessions', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({ coldbrew: { defaultEnabled: true } }))
    writeFileSync(isolated.statePath, JSON.stringify({}))
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(ctx)
    const provider = sections[0].text
    const agent = { id: 'session-default-on', options: { model: 'deepseek-v4' }, session: { header: {}, requestHeader: () => undefined } }
    const text = provider({ scope: agent })
    assert.ok(text.length > 0, 'default-enabled 的新会话必须注入破甲正文')
    writeFileSync(isolated.statePath, JSON.stringify({ 'session-default-on': { enabled: false, model: 'deepseek-v4' } }))
    assert.equal(provider({ scope: agent }), '', '显式关闭必须压过总开关')
  } finally {
    isolated.restore()
  }
})

test('coldbrew session profile inherits parent-session armor through multi-level agent chains', async () => {
  const isolated = isolateHome()
  try {
    writeFileSync(isolated.settingsPath, JSON.stringify({ coldbrew: { defaultEnabled: false } }))
    writeFileSync(isolated.statePath, JSON.stringify({
      'parent-session': { enabled: true, model: 'deepseek-v4' },
    }))
    const sections = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(ctx)
    const provider = sections[0].text

    const { mk } = mockRegistry()
    mk('parent-session', 'deepseek-v4', undefined)
    mk('child-session', 'deepseek-v4', 'parent-session')
    const grandchild = mk('grandchild-session', 'deepseek-v4', 'child-session')

    const text = provider({ scope: grandchild })
    assert.ok(text.length > 0, '孙代理必须继承父会话的破甲')
    writeFileSync(isolated.statePath, JSON.stringify({
      'parent-session': { enabled: false, model: 'deepseek-v4' },
    }))
    assert.equal(provider({ scope: grandchild }), '', '父会话关闭后孙代理也不得注入')
    writeFileSync(isolated.settingsPath, JSON.stringify({ coldbrew: { defaultEnabled: true } }))
    writeFileSync(isolated.statePath, JSON.stringify({}))
    assert.ok(provider({ scope: grandchild }).length > 0, '总开关开启时孙代理按默认规则注入')
  } finally {
    isolated.restore()
  }
})

test('coldbrew default toggle persists under DSH_HOME after the install tree is replaced', async () => {
  const isolated = isolateHome()
  try {
    const servers = []
    const ctx = {
      effect(fn) { fn() },
      systemPrompt: { section() { return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register(route) { servers.push(route) } },
    }
    apply(ctx)
    const route = servers.find(entry => entry.path === '/api/coldbrew')
    assert.ok(route, '必须注册 /api/coldbrew')

    const res = mockRes()
    await route.handler(mockReq('POST', '/api/coldbrew/default', JSON.stringify({ enabled: true })), res)
    assert.equal(res.result.status, 200)

    const dest = settingsFile()
    assert.equal(dest, isolated.settingsPath)
    assert.equal(JSON.parse(readFileSync(dest, 'utf8')).coldbrew.defaultEnabled, true)

    // 换版本整包替换：安装树里的同名文件消失。用户目录必须仍是开启。
    assert.equal(existsSync(join(isolated.home, '..', 'desktop-settings.json')), false)

    const sections = []
    const readCtx = {
      effect(fn) { fn() },
      systemPrompt: { section(section) { sections.push(section); return () => {} } },
      tools: { register() { return () => {} } },
      webServer: { register() {} },
    }
    apply(readCtx)
    const provider = sections[0].text
    const agent = {
      id: 'session-after-upgrade',
      options: { model: 'deepseek-v4' },
      session: { header: {}, requestHeader: () => undefined },
    }
    assert.ok(provider({ scope: agent }).length > 0, '升级冲掉安装树后总开关仍须生效')
  } finally {
    isolated.restore()
  }
})

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'

const packageRoot = join(import.meta.dirname, '..')

test('package declares a standard installable DSH bundle', async () => {
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
  const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8')

  assert.equal(manifest.name, 'dsh-model-capability')
  assert.equal(manifest.icon, './assets/markdown/model-capability.svg')
  assert.equal(manifest.private, undefined)
  assert.equal(manifest.main, './lib/index.mjs')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.deepEqual(manifest.dsh?.client, {
    platform: 'web',
    inject: [
      '@deepseek-ai/dsh-client-runtime',
      '@deepseek-ai/dsh-client-locale',
      '@deepseek-ai/dsh-client-ui-settings-models',
    ],
    immediately: true,
  })
  assert.equal(manifest.dependencies, undefined)
  assert.equal(manifest.repository?.url, 'git+https://github.com/WJZ-P/dsh-model-capabilities.git')
  assert.equal(manifest.repository?.directory, undefined)
  assert.ok(manifest.keywords.includes('dsh-plugin'))
  assert.ok(Object.keys(manifest.peerDependencies).every(name => (
    name === 'react' || name.startsWith('@deepseek-ai/')
  )))
  assert.ok(manifest.files.includes('lib/'))
  assert.ok(manifest.files.includes('assets/markdown/'))
  assert.ok(manifest.files.includes('assets/screenshots/'))
  assert.ok(manifest.files.includes('README.en.md'))
  assert.match(patch, /id:\s*dsh-model-capability/)
  assert.match(patch, /name:\s*dsh-model-capability/)
})

test('marketplace fixture follows the standalone repository catalog schema', async () => {
  const catalog = await readFile(join(
    packageRoot,
    'marketplace',
    'WJZ-P__dsh-model-capabilities.yml',
  ), 'utf8')

  assert.match(catalog, /^url: https:\/\/github\.com\/WJZ-P\/dsh-model-capabilities$/m)
  assert.match(catalog, /^name: WJZ-P\/dsh-model-capabilities$/m)
  assert.match(catalog, /^category: model$/m)
  assert.match(catalog, /^  en: .+\.$/m)
  assert.match(catalog, /^  zh: .+。$/m)
  const prBody = await readFile(join(packageRoot, 'marketplace', 'PR_BODY.md'), 'utf8')
  assert.match(prBody, /https:\/\/raw\.githubusercontent\.com\/WJZ-P\/dsh-model-capabilities\/main\/assets\/markdown\/model-capability\.svg/)
})

test('installation docs use the published npm package', async () => {
  for (const readme of ['README.md', 'README.en.md']) {
    const body = await readFile(join(packageRoot, readme), 'utf8')
    assert.match(body, /dsh plugin --profile web add dsh-model-capability(?:\s|$)/)
    assert.doesNotMatch(body, /dsh plugin --profile web add github:WJZ-P\/dsh-model-capabilities/)
  }
})

test('README embeds the packaged model input example', async () => {
  const assetPath = 'assets/screenshots/01-model-input-selector.png'
  const image = await readFile(join(packageRoot, ...assetPath.split('/')))
  assert.deepEqual([...image.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(image.readUInt32BE(16), 520)
  assert.equal(image.readUInt32BE(20), 310)
  for (const readme of ['README.md', 'README.en.md']) {
    const body = await readFile(join(packageRoot, readme), 'utf8')
    assert.match(body, new RegExp(`<img src="${assetPath}"[^>]+width="520"`))
  }
  const screenshotEntry = JSON.parse(await readFile(join(
    packageRoot,
    'marketplace',
    'screenshots.entry.json',
  ), 'utf8'))
  assert.deepEqual(screenshotEntry['https://github.com/WJZ-P/dsh-model-capabilities'], [
    'https://raw.githubusercontent.com/WJZ-P/dsh-model-capabilities/main/assets/screenshots/01-model-input-selector.png',
  ])
})

test('package and README expose the project icon', async () => {
  const iconPath = 'assets/markdown/model-capability.svg'
  const icon = await readFile(join(packageRoot, ...iconPath.split('/')), 'utf8')
  assert.match(icon, /^<svg\b/)
  assert.match(icon, /viewBox="0 -960 960 960"/)
  for (const readme of ['README.md', 'README.en.md']) {
    const body = await readFile(join(packageRoot, readme), 'utf8')
    assert.match(body, new RegExp(`<img src="${iconPath}"[^>]+width="250"[^>]+height="250"`))
  }
})

import { copyFile, cp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const repositoryRoot = dirname(dirname(pluginRoot))
const outDir = join(pluginRoot, 'lib')
const clientId = '@deepseek-ai/dsh-desktop-manager'

/**
 * This plugin has no dependency tree of its own, so it borrows esbuild from the
 * vendored Harness install. Resolving through a workspace package that declares
 * esbuild (vendor/hmr) works on every platform; the former `.bin/esbuild` shim
 * is a POSIX shell script that Windows cannot spawn, and the Harness root never
 * lists esbuild, so the shim is not guaranteed to exist at all.
 */
function loadEsbuild() {
  const anchors = [
    join(repositoryRoot, 'harness', 'vendor', 'hmr', 'package.json'),
    join(repositoryRoot, 'harness', 'package.json'),
    join(repositoryRoot, 'plugins', 'dsh-attachments', 'package.json'),
  ]
  for (const anchor of anchors) {
    try {
      return createRequire(anchor)('esbuild')
    } catch {
      // try the next anchor
    }
  }
  throw new Error('dsh-desktop-manager: esbuild is not installed; run `pnpm run harness:install` first')
}

const { build } = loadEsbuild()

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
await copyFile(join(pluginRoot, 'src', 'index.mjs'), join(outDir, 'index.mjs'))
await copyFile(join(pluginRoot, 'src', 'reverify.mjs'), join(outDir, 'reverify.mjs'))
await copyFile(join(pluginRoot, 'src', 'reverify-bridge.py'), join(outDir, 'reverify-bridge.py'))
// 冷咖啡五个 profile 提示词是 host 端运行时资源（lib/index.mjs 相对路径读取）。
await cp(join(pluginRoot, 'src', 'profiles'), join(outDir, 'profiles'), { recursive: true })
// Vendored Reverify 0.9.0：纯 Python 核心，host 用系统/venv Python 直接调。
await cp(join(pluginRoot, 'vendor', 'reverify'), join(outDir, 'vendor', 'reverify'), { recursive: true })

const client = join(outDir, 'client.js')
await build({
  entryPoints: [join(pluginRoot, 'src', 'client.tsx')],
  outfile: client,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['chrome105', 'safari15'],
  jsx: 'automatic',
  sourcemap: true,
  // 样式以文本形式打进 bundle，由插件自己插入 <style>：这个 bundle 是单文件
  // 交付的，没有旁路 CSS 的加载入口。
  loader: { '.css': 'text' },
  external: [
    'react',
    'react/jsx-runtime',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
})

const output = await readFile(client, 'utf8')
if (!output.includes(`id: ${JSON.stringify(clientId)}`) || !output.includes('factory: (require)')) {
  throw new Error('dsh-desktop-manager client bundle is missing the Harness lazy-CJS handoff')
}

console.log(`[dsh-desktop-manager] Built Host and browser bundles in ${outDir}`)

import { build } from 'esbuild'
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const srcDir = join(pluginRoot, 'src')
const outDir = join(pluginRoot, 'lib')
const clientId = 'dsh-layered-memory'

async function collectTs(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) await collectTs(path, acc)
    else if (entry.name.endsWith('.ts') && entry.name !== 'smoke.ts') acc.push(path)
  }
  return acc
}

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

const hostFiles = await collectTs(srcDir)
await build({
  entryPoints: hostFiles,
  outdir: outDir,
  outbase: srcDir,
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  sourcemap: false,
  logLevel: 'info',
})

await writeFile(
  join(outDir, 'index.mjs'),
  "export { apply, name, inject, Config } from './index.js';\n",
)

await copyFile(join(pluginRoot, 'resources', 'runtime-package-lock.json'), join(outDir, 'runtime-package-lock.json'))
await copyFile(join(pluginRoot, 'resources', 'embedding-worker.cjs'), join(outDir, 'embedding-worker.cjs'))

const result = await build({
  entryPoints: [join(pluginRoot, 'client/src/entry.tsx')],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  charset: 'utf8',
  external: ['react', 'react/jsx-runtime', '@deepseek-ai/*'],
  minify: false,
  legalComments: 'none',
  sourcemap: false,
  write: false,
  logLevel: 'info',
})

let body = result.outputFiles[0].text.replace(/^("|')use strict\1;\s*/, '')
const out =
  'window.__ModuleLoader__.load({\n' +
  `\tid: ${JSON.stringify(clientId)},\n` +
  '\tfactory: (require) => {\n' +
  '\t\tvar module = { exports: {} };\n' +
  '\t\tvar exports = module.exports;\n' +
  '\t\tObject.defineProperty(exports, Symbol.toStringTag, { value: "Module" });\n' +
  body.replace(/\n/g, '\n\t\t') +
  '\n\t\tvar __flat = {};' +
  '\n\t\tfor (var __k in module.exports) __flat[__k] = module.exports[__k];' +
  '\n\t\tObject.defineProperty(__flat, Symbol.toStringTag, { value: "Module" });' +
  '\n\t\treturn __flat;\n' +
  '\t}\n' +
  '});\n'

if (!out.startsWith('window.__ModuleLoader__.load({')) {
  throw new Error('dsh-layered-memory client bundle missing handoff header')
}
if (!out.includes(`id: ${JSON.stringify(clientId)}`)) {
  throw new Error('dsh-layered-memory client bundle id mismatch')
}
if (!out.includes('require("react")')) {
  throw new Error('dsh-layered-memory client bundle missing react require')
}

await writeFile(join(outDir, 'client.js'), out, 'utf8')
console.log(`[dsh-layered-memory] Built Host and browser bundles in ${outDir}`)

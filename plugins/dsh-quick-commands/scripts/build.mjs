// Build the dsh-quick-commands plugin: copy the Host ESM (index + its two
// sibling modules) verbatim, and bundle the browser half into the Harness
// lazy-CJS handoff. Mirrors plugins/dsh-attachments/scripts/build.mjs.
import { build } from 'esbuild'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(pluginRoot, 'lib')
const clientId = 'dsh-quick-commands'

// Host ESM files copied as-is (index.mjs imports these two at runtime).
const HOST_FILES = ['index.mjs', 'quick-commands-core.mjs', 'shared-path.mjs']

await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })
for (const file of HOST_FILES) {
  await copyFile(join(pluginRoot, 'src', file), join(outDir, file))
}

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
  // quick-commands-core.mjs is intentionally NOT external: the browser half
  // bundles it in (the Host half consumes the copied sibling instead).
  external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'],
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(clientId)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  logLevel: 'info',
})

const output = await readFile(client, 'utf8')
if (!output.includes(`id: "${clientId}"`) || !output.includes('factory: (require)')) {
  throw new Error('dsh-quick-commands does not implement the Harness lazy-CJS handoff')
}

console.log(`[dsh-quick-commands] Built Host and browser bundles in ${outDir}`)

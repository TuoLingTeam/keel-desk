import { spawn } from 'node:child_process'
import { lstat, symlink } from 'node:fs/promises'
import { access, copyFile, cp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const desktopBridgeRoot = join(repositoryRoot, 'desktop-plugins', 'desktop-bridge')
const desktopManagerRoot = join(repositoryRoot, 'desktop-plugins', 'dsh-manager')
const publicPluginsRoot = join(repositoryRoot, 'plugins')
const harnessRoot = join(repositoryRoot, 'harness')

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function pnpmInvocation(args) {
  if (process.env.npm_execpath?.toLowerCase().includes('pnpm')) {
    return { command: process.execPath, args: [process.env.npm_execpath, ...args] }
  }
  if (process.platform === 'win32') {
    return {
      command: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', ...args],
    }
  }
  return { command: 'pnpm', args }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ? `signal ${signal}` : `code ${code}`}`))
    })
  })
}

/** Each plugin's scripts/build.mjs imports esbuild from the plugin's own
 *  node_modules. A fresh checkout — CI in particular — has none installed, and
 *  plugin:sync only installs the lock-pinned entries, so install here from the
 *  vendored lockfile before the build script is imported. */
async function ensurePluginDependencies(root, directory) {
  if (await pathExists(join(root, 'node_modules'))) return
  if (!(await pathExists(join(root, 'pnpm-lock.yaml')))) {
    throw new Error(`${directory}: pnpm-lock.yaml is required to install its build dependencies`)
  }
  const invocation = pnpmInvocation(['--dir', root, 'install', '--frozen-lockfile'])
  await run(invocation.command, invocation.args)
  console.log(`[plugins] Installed dependencies for ${directory}`)
}

async function buildDesktopBridge() {
  const outDir = join(desktopBridgeRoot, 'lib')
  await mkdir(outDir, { recursive: true })
  await copyFile(join(desktopBridgeRoot, 'src', 'index.mjs'), join(outDir, 'index.mjs'))
  console.log('[plugins] Built Desktop-only Host plugin desktop-bridge')
}

async function buildDesktopManager() {
  const outDir = join(desktopManagerRoot, 'lib')
  await mkdir(outDir, { recursive: true })
  const buildScript = join(desktopManagerRoot, 'scripts', 'build.mjs')
  if (await pathExists(buildScript)) {
    await import(`${pathToFileURL(buildScript).href}?build=${Date.now()}`)
  } else {
    await copyFile(join(desktopManagerRoot, 'src', 'index.mjs'), join(outDir, 'index.mjs'))
  }
  console.log('[plugins] Built Desktop-only Host plugin dsh-manager')
}

async function assertStandardBundle(root, directory) {
  const manifestPath = join(root, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
  const requiredFiles = [
    'README.md',
    'LICENSE',
    'cordis.patch.yml',
    join('scripts', 'build.mjs'),
  ]

  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)) {
    throw new Error(`${directory}: package name is not a valid npm package specifier`)
  }
  const escapedPackageName = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (!new RegExp(`^\\s+name:\\s*['"]?${escapedPackageName}['"]?\\s*$`, 'm').test(patch)) {
    throw new Error(`${directory}: cordis.patch.yml must mount package ${manifest.name}`)
  }
  if (manifest.private === true) {
    throw new Error(`${directory}: reusable DSH bundles must be publishable, not private`)
  }
  if (manifest.main !== './lib/index.mjs') {
    throw new Error(`${directory}: main must point to ./lib/index.mjs`)
  }
  if (manifest.exports?.['.'] !== './lib/index.mjs'
    || manifest.exports?.['./cordis.patch.yml'] !== './cordis.patch.yml') {
    throw new Error(`${directory}: exports must expose the Host entry and bundle patch`)
  }
  if (manifest.dsh?.bundle?.patch !== './cordis.patch.yml') {
    throw new Error(`${directory}: dsh.bundle.patch must point to ./cordis.patch.yml`)
  }
  if (manifest.exports?.['./client'] !== undefined
    && manifest.dsh?.client?.platform !== 'web') {
    throw new Error(`${directory}: browser bundles must declare dsh.client.platform as web`)
  }
  if (manifest.dsh?.client?.platform === 'web'
    && manifest.exports?.['./client'] === undefined) {
    throw new Error(`${directory}: dsh.client web bundles must export ./client`)
  }
  const officialClientPeers = (manifest.dsh?.client?.inject ?? [])
    .filter(name => name.startsWith('@deepseek-ai/'))
    .filter(name => manifest.peerDependencies?.[name] === undefined)
  if (officialClientPeers.length > 0) {
    throw new Error(`${directory}: dsh.client official packages must be peerDependencies: ${officialClientPeers.join(', ')}`)
  }
  const officialRuntimeDependencies = Object.keys(manifest.dependencies ?? {})
    .filter(name => name.startsWith('@deepseek-ai/'))
  if (officialRuntimeDependencies.length > 0) {
    throw new Error(`${directory}: official packages belong in peerDependencies: ${officialRuntimeDependencies.join(', ')}`)
  }
  const publishedFiles = ['lib/', 'cordis.patch.yml', 'README.md', 'LICENSE']
  if (!Array.isArray(manifest.files)
    || publishedFiles.some(filename => !manifest.files.includes(filename))) {
    throw new Error(`${directory}: package files must include ${publishedFiles.join(', ')}`)
  }
  if (!manifest.scripts?.build || !manifest.scripts?.prepare || !manifest.scripts?.test) {
    throw new Error(`${directory}: package scripts must provide build, prepare, and test`)
  }
  if (!manifest.engines?.node || !manifest.license) {
    throw new Error(`${directory}: package must declare Node compatibility and a license`)
  }
  if (!manifest.keywords?.includes('dsh-plugin')) {
    throw new Error(`${directory}: package keywords must include dsh-plugin`)
  }
  for (const filename of requiredFiles) {
    await access(join(root, filename))
  }
}

async function buildPublicPlugins() {
  const entries = await readdir(publicPluginsRoot, { withFileTypes: true })
  const roots = []
  for (const entry of entries.filter(row => row.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const root = join(publicPluginsRoot, entry.name)
    const buildScript = join(root, 'scripts', 'build.mjs')
    if (await pathExists(buildScript)) {
      await assertStandardBundle(root, entry.name)
      await ensurePluginDependencies(root, entry.name)
      await import(`${pathToFileURL(buildScript).href}?build=${Date.now()}`)
    } else {
      console.log(`[plugins] Skipping build for non-standard plugin ${entry.name}`)
    }
    roots.push(root)
  }
  return roots
}

async function stageResolverPackage(root) {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const destination = join(harnessRoot, 'node_modules', ...manifest.name.split('/'))
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await copyFile(join(root, 'package.json'), join(destination, 'package.json'))
  if (manifest.dsh?.bundle?.patch === './cordis.patch.yml') {
    await copyFile(join(root, 'cordis.patch.yml'), join(destination, 'cordis.patch.yml'))
  }
  const libDir = join(root, 'lib')
  if (await pathExists(libDir)) {
    await cp(libDir, join(destination, 'lib'), {
      recursive: true,
      dereference: true,
    })
  } else {
    // Stage root files if lib/ is missing (legacy plugins)
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await cp(join(root, entry.name), join(destination, entry.name), {
        recursive: true,
        dereference: true,
      })
    }
  }
  await linkOfficialPeers(destination, manifest)
  console.log(`[plugins] Staged resolvable package ${manifest.name}`)
}

const officialPeerRoots = new Map()

async function officialPeerRoot(name) {
  if (officialPeerRoots.has(name)) return officialPeerRoots.get(name)
  const direct = join(harnessRoot, 'node_modules', ...name.split('/'))
  if (await pathExists(direct)) {
    officialPeerRoots.set(name, direct)
    return direct
  }
  const groups = [join(harnessRoot, 'vendor'), join(harnessRoot, 'packages')]
  for (const group of groups) {
    if (!(await pathExists(group))) continue
    const entries = await readdir(group, { withFileTypes: true })
    for (const entry of entries.filter(row => row.isDirectory())) {
      const nested = join(group, entry.name)
      const manifests = []
      if (await pathExists(join(nested, 'package.json'))) manifests.push(nested)
      else {
        try {
          for (const child of await readdir(nested, { withFileTypes: true })) {
            if (child.isDirectory()) manifests.push(join(nested, child.name))
          }
        } catch {
          continue
        }
      }
      for (const root of manifests) {
        const pkgPath = join(root, 'package.json')
        if (!(await pathExists(pkgPath))) continue
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
        if (pkg.name === name) {
          officialPeerRoots.set(name, root)
          return root
        }
      }
    }
  }
  officialPeerRoots.set(name, undefined)
  return undefined
}

/** Desktop stages plugins as copies under harness/node_modules. Node then
 *  resolves `@deepseek-ai/*` from that copy, which cannot see pnpm's isolated
 *  workspace packages. Link declared official peers back to the vendored tree. */
async function linkOfficialPeers(destination, manifest) {
  const names = new Set([
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.dependencies ?? {}),
  ].filter(name => name.startsWith('@deepseek-ai/')))
  if (names.size === 0) return
  await mkdir(join(destination, 'node_modules', '@deepseek-ai'), { recursive: true })
  for (const name of names) {
    const target = await officialPeerRoot(name)
    if (!target) continue
    const link = join(destination, 'node_modules', ...name.split('/'))
    await mkdir(dirname(link), { recursive: true })
    try {
      await rm(link, { recursive: true, force: true })
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
}

await buildDesktopBridge()
await buildDesktopManager()
const publicPluginRoots = await buildPublicPlugins()
for (const root of [desktopBridgeRoot, desktopManagerRoot, ...publicPluginRoots]) {
  await stageResolverPackage(root)
}

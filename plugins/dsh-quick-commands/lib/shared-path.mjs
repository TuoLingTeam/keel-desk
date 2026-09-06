// shared-path.mjs — resolves the SHARED quick-commands file that the sibling
// "Pchat 助手" (codex-desktop) app reads and writes, so both apps stay in sync.
//
// codex-desktop's data dir is machine-level and relocatable: a pointer file
//   <appData>/codex-desktop/data-location.json  →  { dataDir: "/abs/path" }
// decides where data lives; quick commands sit at <dataDir>/codex/quick_commands.json.
// We resolve through the SAME pointer, so if the user moves their data dir the
// sharing follows. Absent/malformed pointer → the anchor dir itself (codex's
// own fallback), so we never diverge from what codex-desktop resolves.
//
// Env override DSH_QUICK_COMMANDS_FILE forces an absolute path (tests / unusual
// installs). Plain node — no electron.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

/** codex-desktop's anchor directory name — the geolocation of the pointer. */
const ANCHOR_NAME = 'codex-desktop'
/** codex-desktop stores business data under this subdir of the data dir. */
const STORAGE_SUBDIR = 'codex'
const QUICK_COMMANDS_BASENAME = 'quick_commands.json'
const POINTER_BASENAME = 'data-location.json'

/** Per-OS application-data root (matches Electron's app.getPath('appData')). */
export function appDataDir() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config')
}

/** codex-desktop's fixed anchor dir: <appData>/codex-desktop. */
export function anchorDir() {
  return join(appDataDir(), ANCHOR_NAME)
}

/**
 * Read the data-location pointer's dataDir, applying codex-desktop's own
 * tolerance: missing / unreadable / non-JSON / non-string / relative → null
 * (treated as "not chosen", falls back to the anchor).
 */
export function readDataLocationPointer() {
  let raw
  try {
    raw = readFileSync(join(anchorDir(), POINTER_BASENAME), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const dir = parsed.dataDir
  if (typeof dir !== 'string') return null
  const trimmed = dir.trim()
  if (!trimmed || !isAbsolute(trimmed)) return null
  return trimmed
}

/** The resolved data directory (pointer target, else the anchor). */
export function dataDir() {
  return readDataLocationPointer() ?? anchorDir()
}

/**
 * Absolute path of the shared quick_commands.json.
 * `DSH_QUICK_COMMANDS_FILE` (absolute) overrides everything.
 */
export function quickCommandsFilePath() {
  const override = process.env.DSH_QUICK_COMMANDS_FILE
  if (typeof override === 'string' && override.trim() && isAbsolute(override.trim())) return override.trim()
  return join(dataDir(), STORAGE_SUBDIR, QUICK_COMMANDS_BASENAME)
}

/** Whether the shared file currently exists on disk (diagnostics only). */
export function quickCommandsFileExists() {
  return existsSync(quickCommandsFilePath())
}

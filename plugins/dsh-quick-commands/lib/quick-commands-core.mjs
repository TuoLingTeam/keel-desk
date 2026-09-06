// quick-commands-core.mjs — framework-agnostic domain logic for the shared
// quick-commands store. Mirrors the codex-desktop reference so BOTH apps
// interoperate on the SAME file: { version: 1, commands: [{ id, text, pinned? }] }.
// Plain ESM (no deps) so the host copies it verbatim and the client bundles it.
// Pin invariant, create/pin landing points, reorder validation, and import
// semantics match the reference exactly; only the id alphabet differs (opaque,
// random → never collides across apps).

/** The file-format version both apps write. */
export const QUICK_COMMANDS_FILE_VERSION = 1

/** Max stored length of one command (matches the reference's 20k cap). */
export const QUICK_COMMAND_MAX_LENGTH = 20_000

/** Show the panel's filter box only past this count (reference parity: 12). */
export const QUICK_COMMANDS_FILTER_THRESHOLD = 12

/** The five default seeds — identical text to the reference. */
export const DEFAULT_QUICK_COMMAND_TEXTS = [
  '请优化下面这段文字的语法与表达：保持原意不变，修正病句与冗余，直接给出优化后的版本。',
  '请审查以下代码：指出潜在缺陷、安全风险与可改进点，按严重程度排序，并给出具体修改建议。',
  '请逐段解释以下代码的作用与实现思路：标注关键逻辑与易错点，最后用一句话总结整体功能。',
  '请为以下代码编写单元测试：覆盖正常路径、边界条件与异常场景，直接给出可运行的测试代码。',
  '请根据以下改动生成一条符合 Conventional Commits 规范的 git 提交信息：标题不超过 50 字符，正文说明动机与影响面。',
]

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** Random opaque id, `qc_` + 10 chars. Uses crypto when present, else Math. */
export function newQuickCommandId() {
  const bytes = new Uint8Array(10)
  const cryptoObj = globalThis.crypto
  if (cryptoObj && typeof cryptoObj.getRandomValues === 'function') cryptoObj.getRandomValues(bytes)
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  let out = 'qc_'
  for (const byte of bytes) out += ID_ALPHABET[byte % ID_ALPHABET.length]
  return out
}

/** Fresh default set with fresh ids. */
export function seedDefaultQuickCommands() {
  return DEFAULT_QUICK_COMMAND_TEXTS.map((text) => ({ id: newQuickCommandId(), text }))
}

/** Pin predicate — the single source of truth (absent/false → plain). */
export function isPinned(command) {
  return command.pinned === true
}

/** Invariant: every pinned command precedes every plain one. */
export function isPinnedPartitioned(commands) {
  let sawPlain = false
  for (const command of commands) {
    if (isPinned(command)) { if (sawPlain) return false }
    else sawPlain = true
  }
  return true
}

/** Stable normalization to `[...pinned, ...plain]`, order preserved per region. */
export function partitionByPinned(commands) {
  return [...commands.filter(isPinned), ...commands.filter((command) => !isPinned(command))]
}

/** Drop `pinned:false` so the stored shape never carries a constant-false key. */
function normalizeStored(id, text, pinned) {
  return pinned ? { id, text, pinned: true } : { id, text }
}

function isStoredShape(data) {
  if (typeof data !== 'object' || data === null) return false
  if (typeof data.version !== 'number' || !Number.isInteger(data.version) || data.version < 1) return false
  if (!Array.isArray(data.commands)) return false
  return data.commands.every((entry) => (
    typeof entry === 'object' && entry !== null
    && typeof entry.id === 'string' && typeof entry.text === 'string'
    && (entry.pinned === undefined || typeof entry.pinned === 'boolean')
  ))
}

/**
 * Parse jsonStore output: bad/missing → seed + rewrite; repair empty/dup ids;
 * self-heal the pin partition. Never discards the whole file for one bad row.
 * @returns {{ commands: Array, needsRewrite: boolean }}
 */
export function parseStoredQuickCommands(data) {
  if (!isStoredShape(data)) return { commands: seedDefaultQuickCommands(), needsRewrite: true }
  let needsRewrite = data.version !== QUICK_COMMANDS_FILE_VERSION
  const seen = new Set()
  const commands = data.commands.map((entry) => {
    let id = entry.id
    if (id === '' || seen.has(id)) { id = newQuickCommandId(); needsRewrite = true }
    seen.add(id)
    return normalizeStored(id, entry.text, entry.pinned === true)
  })
  if (!isPinnedPartitioned(commands)) needsRewrite = true
  return { commands: partitionByPinned(commands), needsRewrite }
}

/** Serialize to the on-disk shape (always the current version). */
export function toStoredFile(commands) {
  return { version: QUICK_COMMANDS_FILE_VERSION, commands }
}

/** Insert at the top of the plain region (below any pins). */
export function createCommand(existing, text) {
  const at = existing.filter(isPinned).length
  const next = [...existing]
  next.splice(at, 0, { id: newQuickCommandId(), text })
  return next
}

/** Replace text by id; null when the id is gone. */
export function updateCommand(existing, id, text) {
  if (!existing.some((command) => command.id === id)) return null
  return existing.map((command) => (command.id === id ? { ...command, text } : command))
}

/** Remove by id (idempotent). */
export function removeCommand(existing, id) {
  return existing.filter((command) => command.id !== id)
}

/** Pin → end of pinned region; unpin → start of plain region. Idempotent; null when absent. */
export function setCommandPinned(existing, id, pinned) {
  const from = existing.findIndex((command) => command.id === id)
  if (from < 0) return null
  const target = existing[from]
  if (target === undefined) return null
  if (isPinned(target) === pinned) return existing
  const rest = existing.filter((command) => command.id !== id)
  const moved = normalizeStored(target.id, target.text, pinned)
  const at = rest.filter(isPinned).length
  const next = [...rest]
  next.splice(at, 0, moved)
  return next
}

/** Reorder to an exact id permutation that keeps the partition; null otherwise. */
export function reorderCommands(existing, ids) {
  if (ids.length !== existing.length) return null
  if (new Set(ids).size !== ids.length) return null
  const byId = new Map(existing.map((command) => [command.id, command]))
  const next = []
  for (const id of ids) {
    const found = byId.get(id)
    if (found === undefined) return null
    next.push(found)
  }
  return isPinnedPartitioned(next) ? next : null
}

/** Parse an import file: bare `[{text}]` or `{commands:[{text}]}`; all-or-nothing; drop blanks. */
export function parseImportPayload(raw) {
  let data
  try { data = JSON.parse(raw) } catch { return { ok: false, error: '文件不是合法 JSON' } }
  const list = Array.isArray(data)
    ? data
    : (typeof data === 'object' && data !== null && Array.isArray(data.commands) ? data.commands : null)
  if (list === null) return { ok: false, error: '文件形状不符：应为指令数组或含 commands 字段的对象' }
  const texts = []
  let dropped = 0
  for (const item of list) {
    const text = typeof item === 'object' && item !== null ? item.text : undefined
    if (typeof text !== 'string') return { ok: false, error: '存在缺失 text 字段的条目，已整体拒绝导入' }
    const trimmed = text.trim()
    if (trimmed === '') dropped += 1
    else texts.push(trimmed)
  }
  return { ok: true, texts, dropped }
}

/** replace = regenerate the whole table; merge = dedup by text, append. */
export function applyImport(existing, texts, mode) {
  if (mode === 'replace') {
    const commands = texts.map((text) => ({ id: newQuickCommandId(), text }))
    return { commands, imported: commands.length, skipped: 0 }
  }
  const known = new Set(existing.map((command) => command.text))
  const appended = []
  let skipped = 0
  for (const text of texts) {
    if (known.has(text)) { skipped += 1; continue }
    known.add(text)
    appended.push({ id: newQuickCommandId(), text })
  }
  return { commands: [...existing, ...appended], imported: appended.length, skipped }
}

/** Export payload: `{version, exportedAt, commands:[{text}]}` (text only, no ids/pins). */
export function toExportPayload(commands, nowIso) {
  return {
    version: QUICK_COMMANDS_FILE_VERSION,
    exportedAt: nowIso,
    commands: commands.map((command) => ({ text: command.text })),
  }
}

/** Default export filename with a YYYYMMDD stamp. */
export function exportFileName(y, m, d) {
  return `quick_commands_${y}${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}.json`
}

/** Trim-based validity: non-blank and within the length cap. */
export function isValidCommandText(text) {
  return typeof text === 'string' && text.trim() !== '' && text.length <= QUICK_COMMAND_MAX_LENGTH
}

/** Panel filter: trim + case-insensitive substring on text; blank → full copy. */
export function filterQuickCommands(commands, query) {
  const q = query.trim().toLowerCase()
  if (q === '') return [...commands]
  return commands.filter((command) => command.text.toLowerCase().includes(q))
}

/** Append a snippet to the current draft: blank draft → snippet; else one newline join. */
export function appendQuickCommandText(current, snippet) {
  return current.trim() === '' ? snippet : `${current}\n${snippet}`
}

/** Gap between the trigger and the floating panel. */
export const QUICK_COMMAND_OVERLAY_GAP = 8
/** Viewport inset the panel must stay inside. */
export const QUICK_COMMAND_OVERLAY_MARGIN = 8
/** Below this height, a vertical popover is treated as unusable and a side may win. */
export const QUICK_COMMAND_OVERLAY_MIN_VERTICAL = 200

function clamp(value, lo, hi) {
  return Math.min(Math.max(value, lo), Math.max(lo, hi))
}

/**
 * Place a floating panel against an anchor using the application window.
 * Prefers down when it fits (empty-hero composer in the middle), flips up
 * when the trigger sits near the bottom, flush-right when the right edge
 * would clip, and only uses left/right when both vertical sides are too
 * short for a usable list.
 *
 * `inset` carves reserved chrome out of the viewport: conversation header
 * on top, composer / stats on the bottom. The panel never occupies that
 * band, even when the chosen side would otherwise stretch to the window edge.
 *
 * @param {object} input
 * @param {{top:number,bottom:number,left:number,right:number,width:number,height:number}} input.anchor
 * @param {number} input.panelWidth
 * @param {number} input.panelHeight
 * @param {{width:number,height:number}} input.viewport
 * @param {number} [input.margin]
 * @param {number} [input.gap]
 * @param {{top?:number,right?:number,bottom?:number,left?:number}} [input.inset]
 * @returns {{top:number,left:number,maxHeight:number,maxWidth:number,side:'up'|'down'|'left'|'right'}}
 */
export function resolveQuickCommandPlacement({
  anchor,
  panelWidth,
  panelHeight,
  viewport,
  margin = QUICK_COMMAND_OVERLAY_MARGIN,
  gap = QUICK_COMMAND_OVERLAY_GAP,
  inset = {},
}) {
  const safe = {
    top: Math.max(margin, inset.top ?? margin),
    right: viewport.width - Math.max(margin, inset.right ?? margin),
    bottom: viewport.height - Math.max(margin, inset.bottom ?? margin),
    left: Math.max(margin, inset.left ?? margin),
  }
  const space = {
    above: Math.max(0, anchor.top - gap - safe.top),
    below: Math.max(0, safe.bottom - anchor.bottom - gap),
    left: Math.max(0, anchor.left - gap - safe.left),
    right: Math.max(0, safe.right - anchor.right - gap),
  }

  const verticalBest = Math.max(space.above, space.below)
  const horizontalBest = Math.max(space.left, space.right)
  const minVertical = Math.min(panelHeight, QUICK_COMMAND_OVERLAY_MIN_VERTICAL)

  let side
  if (verticalBest < minVertical && horizontalBest > verticalBest) {
    side = space.right >= space.left ? 'right' : 'left'
  } else if (panelHeight <= space.below) {
    side = 'down'
  } else if (space.above > space.below) {
    side = 'up'
  } else {
    side = 'down'
  }

  if (side === 'up' || side === 'down') {
    let maxHeight = side === 'up' ? space.above : space.below
    let height = Math.min(panelHeight, maxHeight)
    let top = side === 'up' ? anchor.top - gap - height : anchor.bottom + gap
    top = clamp(top, safe.top, Math.max(safe.top, safe.bottom - height))
    maxHeight = Math.max(0, side === 'up' ? (anchor.top - gap - top) : (safe.bottom - top))
    height = Math.min(height, maxHeight)
    const maxWidth = Math.max(0, safe.right - safe.left)
    const width = Math.min(panelWidth, maxWidth)
    const overflowRight = anchor.left + width > safe.right
    const left = clamp(
      overflowRight ? anchor.right - width : anchor.left,
      safe.left,
      Math.max(safe.left, safe.right - width),
    )
    return { top, left, maxHeight, maxWidth, side }
  }

  const maxWidth = side === 'left' ? space.left : space.right
  const width = Math.min(panelWidth, maxWidth)
  const left = clamp(
    side === 'left' ? anchor.left - gap - width : anchor.right + gap,
    safe.left,
    Math.max(safe.left, safe.right - width),
  )
  const maxHeight = Math.max(0, safe.bottom - safe.top)
  const height = Math.min(panelHeight, maxHeight)
  const top = clamp(anchor.top, safe.top, Math.max(safe.top, safe.bottom - height))
  return { top, left, maxHeight, maxWidth, side }
}

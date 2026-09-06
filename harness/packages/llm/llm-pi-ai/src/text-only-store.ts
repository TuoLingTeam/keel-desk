/**
 * Persisted memory of `provider/model` routes proven image-blind at runtime.
 *
 * pi-ai deliberately over-declares image input for undescribed gateway models
 * (see `withImageInput`), so a text-only relay — a DeepSeek/GPT mirror that
 * speaks `openai-completions` but has no vision — reports image-capable, and
 * `read_image`/uploads write image blocks into durable session history. The
 * relay then answers honestly on the wire with a 400 ("This model does not
 * support image"), which is NOT a retryable code, so the turn dies terminally
 * and 重试 loops forever on the same poisoned history.
 *
 * This store is the learned cure: the first time a route refuses an image, the
 * adapter records it here and re-runs the same turn with every image folded to
 * text. Every later turn reads the store first and folds up front, so the 400
 * cannot recur — the session self-heals without any rewrite of the durable log
 * and without the user marking the model text-only by hand (though the
 * `dsh-model-capability` 「文本」toggle remains the explicit, catalog-level
 * lever for the same outcome).
 *
 * The file is a tiny JSON array of `"provider/model"` keys under DSH_HOME. A
 * process reads it once and caches it; writes are append-only and best-effort,
 * so a store that cannot be written never breaks a request — it only forgoes
 * the up-front fold on the next process, which the in-turn self-heal then
 * re-learns.
 * @module dsh-llm-pi-ai/text-only-store
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Compose the stable store key for one route. */
function keyOf(provider: string, model: string): string {
  return `${provider}/${model}`
}

/** Absolute path of the JSON store under DSH_HOME (or the home fallback). */
function storeFile(): string {
  return join(resolve(process.env['DSH_HOME'] ?? join(homedir(), '.dsh')), 'dsh-pi-ai-text-only.json')
}

/**
 * A process-lifetime cache over the on-disk set. Construction does no I/O; the
 * first {@link has} or {@link remember} loads the file once, and later calls
 * hit memory. Instances are cheap — the adapter holds exactly one.
 */
export class TextOnlyRouteStore {
  private loaded = false
  private readonly routes = new Set<string>()

  /** Load the file once; a missing or unreadable file is an empty set. */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed: unknown = JSON.parse(await readFile(storeFile(), 'utf8'))
      if (Array.isArray(parsed)) {
        for (const entry of parsed) if (typeof entry === 'string' && entry.length > 0) this.routes.add(entry)
      }
    } catch {
      // Absent / unreadable / malformed → start empty; the in-turn self-heal
      // re-learns any route that still refuses an image this process.
    }
  }

  /**
   * Whether this route was previously proven image-blind.
   * @param provider - the route's provider key.
   * @param model - the route's model id.
   * @returns true when a fold-to-text should be applied up front.
   */
  async has(provider: string, model: string): Promise<boolean> {
    await this.ensureLoaded()
    return this.routes.has(keyOf(provider, model))
  }

  /**
   * Record one route as image-blind and persist the whole set atomically.
   * Best-effort: a write failure is swallowed so a refusal recovery never
   * fails on top of the write; the in-flight fold still proceeds either way.
   * @param provider - the route's provider key.
   * @param model - the route's model id.
   * @returns true when the route was newly added (and a write was attempted).
   */
  async remember(provider: string, model: string): Promise<boolean> {
    await this.ensureLoaded()
    const key = keyOf(provider, model)
    if (this.routes.has(key)) return false
    this.routes.add(key)
    try {
      const target = storeFile()
      await mkdir(dirname(target), { recursive: true })
      const tmp = `${target}.${randomUUID()}.tmp`
      await writeFile(tmp, `${JSON.stringify([...this.routes], null, 2)}\n`, 'utf8')
      await rename(tmp, target)
    } catch {
      // Kept in memory for this process even if the durable write failed.
    }
    return true
  }
}

/**
 * Recognize a provider failure as an image-input refusal (any wire dialect).
 * Text-based by necessity: pi-ai flattens the upstream error to a message
 * string, so we match the phrasings gateways actually return for a text-only
 * model handed a picture, plus the localized DeepSeek-mirror wording.
 * @param message - the provider failure message.
 * @param code - the classified failure code (INVALID_REQUEST for a 400).
 * @returns true when the turn failed specifically because the route rejected an image.
 */
export function isImageRefusal(message: string, code: string): boolean {
  const text = message.toLowerCase()
  const mentionsImage = /\bimage\b|图片|图像|多模态|multimodal|vision/.test(text)
  if (!mentionsImage) return false
  const refuses = /not support|does ?n'?t support|unsupported|no support|cannot|can'?t|不支持|无法|invalid_request_error/.test(text)
  // A 400/INVALID_REQUEST that names images is the canonical case; keep the
  // phrase gate too, so a differently-coded refusal that still says as much is
  // caught, while an ordinary image-mentioning success text never is (this is
  // only ever consulted on an already-errored finish).
  return refuses || code === 'INVALID_REQUEST'
}

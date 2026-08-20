/**
 * Recogniser behavior: engine preference and fallback, the digest cache, and
 * the refusal branches that keep an unreadable image from being dropped
 * silently.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  createImageOcr, DEFAULT_MAX_BYTES, describeImageForModel, type OcrOutcome,
} from '../src/index.ts'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const OTHER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9])

type Call = { command: string; args: readonly string[] }

/** A runner that answers per executable name and records what it was asked. */
function runner(answers: Record<string, string | Error>) {
  const calls: Call[] = []
  const run = vi.fn(async (command: string, args: readonly string[]) => {
    calls.push({ command, args })
    // 引擎现在按绝对路径候选逐个尝试，所以按可执行文件名匹配。
    const answer = answers[command.slice(command.lastIndexOf('/') + 1)]
    if (answer === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
    if (answer instanceof Error) throw answer
    return { stdout: answer, stderr: '' }
  })
  return { calls, run }
}

describe('createImageOcr', () => {
  it('prefers the Vision helper and never reaches tesseract when it answers', async () => {
    const r = runner({ 'dsh-ocr': '  订单编号 DSH-1174\nTotal 12.50  ' })
    const ocr = createImageOcr({ run: r.run })
    const outcome = await ocr.recognize({ data: PNG, mediaType: 'image/png' })

    expect(outcome).toMatchObject({ kind: 'text', engine: 'vision', cached: false })
    expect(outcome.kind === 'text' && outcome.text).toBe('订单编号 DSH-1174\nTotal 12.50')
    expect(r.calls[0]!.command).toMatch(/dsh-ocr$/)
    expect(r.calls[0]!.args[0]).toMatch(/\.png$/)
  })

  it('falls back to tesseract with the configured languages when Vision is absent', async () => {
    const r = runner({ tesseract: 'hello' })
    const ocr = createImageOcr({ run: r.run })
    const outcome = await ocr.recognize({ data: PNG, mediaType: 'image/jpeg' })

    expect(outcome).toMatchObject({ kind: 'text', engine: 'tesseract', text: 'hello' })
    // Vision 的每个候选路径都试过一遍才退到 tesseract。
    const names = r.calls.map(c => c.command.slice(c.command.lastIndexOf('/') + 1))
    expect(names.filter(n => n === 'dsh-ocr').length).toBeGreaterThan(1)
    expect(names.at(-1)).toBe('tesseract')
    const last = r.calls.at(-1)!
    expect(last.args).toEqual([expect.stringMatching(/\.jpg$/), 'stdout', '-l', 'chi_sim+eng'])
  })

  it('memoises on content digest, so the same image is recognised once', async () => {
    const r = runner({ 'dsh-ocr': 'once' })
    const ocr = createImageOcr({ run: r.run })

    const first = await ocr.recognize({ data: PNG, mediaType: 'image/png' })
    const second = await ocr.recognize({ data: new Uint8Array(PNG), mediaType: 'image/png' })
    const other = await ocr.recognize({ data: OTHER, mediaType: 'image/png' })

    expect(first).toMatchObject({ cached: false })
    expect(second).toMatchObject({ kind: 'text', text: 'once', cached: true })
    expect(other).toMatchObject({ cached: false })
    // Two distinct images, two runs — the repeat cost nothing.
    expect(r.run).toHaveBeenCalledTimes(2)
  })

  it('collapses concurrent requests for one image into a single run', async () => {
    const r = runner({ 'dsh-ocr': 'shared' })
    const ocr = createImageOcr({ run: r.run })
    const [a, b] = await Promise.all([
      ocr.recognize({ data: PNG, mediaType: 'image/png' }),
      ocr.recognize({ data: PNG, mediaType: 'image/png' }),
    ])
    expect(a).toMatchObject({ kind: 'text', text: 'shared' })
    expect(b).toMatchObject({ kind: 'text', text: 'shared' })
    expect(r.run).toHaveBeenCalledTimes(1)
  })

  it('evicts the oldest digest past the cache bound', async () => {
    const r = runner({ 'dsh-ocr': 'x' })
    const ocr = createImageOcr({ run: r.run, cacheSize: 1 })
    await ocr.recognize({ data: PNG, mediaType: 'image/png' })
    await ocr.recognize({ data: OTHER, mediaType: 'image/png' })
    await ocr.recognize({ data: PNG, mediaType: 'image/png' })
    expect(r.run).toHaveBeenCalledTimes(3)
  })

  it('reports an image with no text rather than pretending it failed', async () => {
    const r = runner({ 'dsh-ocr': '   \n  ' })
    const ocr = createImageOcr({ run: r.run })
    const outcome = await ocr.recognize({ data: PNG, mediaType: 'image/png' })
    expect(outcome.kind).toBe('empty')
    expect(describeImageForModel(outcome)).toContain('no text')
  })

  it('skips an oversized image without running an engine', async () => {
    const r = runner({ 'dsh-ocr': 'never' })
    const ocr = createImageOcr({ run: r.run, maxBytes: 4 })
    const outcome = await ocr.recognize({ data: PNG, mediaType: 'image/png' })
    expect(outcome.kind).toBe('too-large')
    expect(r.run).not.toHaveBeenCalled()
  })

  it('says which engines failed when none succeeds', async () => {
    const r = runner({ tesseract: new Error('tessdata missing') })
    const ocr = createImageOcr({ run: r.run })
    const outcome = await ocr.recognize({ data: PNG, mediaType: 'image/png' })
    expect(outcome.kind).toBe('unavailable')
    expect(outcome.kind === 'unavailable' && outcome.detail)
      .toContain('vision: not installed')
    expect(outcome.kind === 'unavailable' && outcome.detail).toContain('tessdata missing')
  })

  it('propagates an abort instead of downgrading it to a failed engine', async () => {
    const controller = new AbortController()
    const run = vi.fn(async () => {
      controller.abort()
      throw Object.assign(new Error('aborted'), { code: 'ABORT_ERR' })
    })
    const ocr = createImageOcr({ run })
    await expect(ocr.recognize({
      data: PNG, mediaType: 'image/png', signal: controller.signal,
    })).rejects.toThrow('aborted')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('keeps a sane default ceiling', () => {
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(1024 * 1024)
  })
})

describe('describeImageForModel', () => {
  it('labels recognised text with its engine and the image name', () => {
    const outcome: OcrOutcome = { kind: 'text', engine: 'vision', text: 'hi', cached: false }
    expect(describeImageForModel(outcome, 'shot.png'))
      .toBe('[image "shot.png", text recognised by OCR (vision)]\nhi')
  })

  it('still names the image when no label is available', () => {
    const outcome: OcrOutcome = { kind: 'unavailable', detail: 'no engine' }
    expect(describeImageForModel(outcome)).toBe('[image: no engine]')
  })
})

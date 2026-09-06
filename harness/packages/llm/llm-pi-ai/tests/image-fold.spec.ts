/**
 * Image-blind route handling: a text-only model folds images to text instead
 * of sending them, and an over-declared route that the relay refuses is
 * learned and self-healed within the same turn. Covers the cure for the
 * "This model does not support image" 400 that no retry could clear.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer, textEvents } from './mock-server.ts'

const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 3,
  width: 2,
  height: 2,
  name: '/tmp/audience.png',
}

/** A minimal attachment store returning fixed bytes for any image ref. */
class FakeAttachmentStore extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 16,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 16,
    maxImagePixels: 16,
    mediaTypes: ['image/png'],
  }

  validateImage(_input: SaveImageAttachment): Promise<void> {
    return Promise.reject(new Error('not used'))
  }

  saveImage(_input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    return Promise.reject(new Error('not used'))
  }

  readImage(ref: ImageAttachmentRef): Promise<StoredImageAttachment> {
    return Promise.resolve({ ref, data: Uint8Array.of(1, 2, 3) })
  }
}

/**
 * A 400 that names an unsupported image, matching the relay's real body shape:
 * the OpenAI SDK reads `errorResponse.error`, and pi-ai then surfaces it as
 * `400: {…}` — exactly the message the failing session showed.
 */
const IMAGE_REFUSAL_400 = {
  status: 400,
  body: JSON.stringify({
    error: {
      message: 'This model does not support image',
      type: 'invalid_request_error',
      param: '',
      code: 'invalid_request_error',
    },
  }),
}

async function bootDshHome(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-pi-fold-'))
  vi.stubEnv('DSH_HOME', dir)
  return dir
}

async function bootAdapter(dshHome: string, baseURL: string, models: unknown[]): Promise<Context> {
  vi.stubEnv('PI_TEST_KEY', 'test-key')
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, {
    providers: { relay: { apiKeyEnv: 'PI_TEST_KEY', api: 'openai-completions', baseURL, models } },
  } as never)
  await ctx.plugin(FakeAttachmentStore)
  void dshHome
  return ctx
}

const userImage = () => createUserMessage({
  content: [{ type: 'image', attachment: IMAGE_REF }],
  source: { kind: 'plugin', plugin: 'test' },
})

describe('pi-ai image-blind routes', () => {
  beforeEach(() => {
    vi.stubEnv('PI_TEST_KEY', 'test-key')
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await closeMockServers()
  })

  it('folds an image to text for an explicitly text-only model, sending no image on the wire', async () => {
    const dshHome = await bootDshHome()
    // One request only: the fold happens up front, so no refusal, no re-run.
    const server = await mockServer([{ events: textEvents }])
    const ctx = await bootAdapter(dshHome, `${server.url}/v1`, [{ id: 'text-relay', input: ['text'] }])

    const result = await assemble(ctx, {
      provider: 'relay',
      model: 'text-relay',
      messages: [userImage()],
    })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    // The picture never reaches the wire — its text stands in for it.
    expect(JSON.stringify(server.requests[0])).not.toContain('image_url')
    expect(JSON.stringify(server.requests[0])).toContain('audience.png')
    await rm(dshHome, { recursive: true, force: true })
  })

  it('learns an over-declared route from a 400 image refusal and self-heals the same turn', async () => {
    const dshHome = await bootDshHome()
    // First request carries the image and is refused; second is folded to text.
    const server = await mockServer([IMAGE_REFUSAL_400, { events: textEvents }])
    // No `input` declared → over-declared image-capable by withImageInput.
    const ctx = await bootAdapter(dshHome, `${server.url}/v1`, [{ id: 'vision-claim' }])

    const result = await assemble(ctx, {
      provider: 'relay',
      model: 'vision-claim',
      messages: [userImage()],
    })

    // The consumer sees a clean success — the refusal was absorbed and re-run.
    expect(result.finish).toEqual({ kind: 'stop' })
    expect(result.message.content).toEqual([{ type: 'text', text: 'hello' }])
    expect(server.paths).toEqual(['/v1/chat/completions', '/v1/chat/completions'])
    // Attempt 1 sent the image; attempt 2 folded it away.
    expect(JSON.stringify(server.requests[0])).toContain('image_url')
    expect(JSON.stringify(server.requests[1])).not.toContain('image_url')

    // The route was persisted so a later turn folds up front.
    const store: unknown = JSON.parse(await readFile(join(dshHome, 'dsh-pi-ai-text-only.json'), 'utf8'))
    expect(store).toEqual(['relay/vision-claim'])
    await rm(dshHome, { recursive: true, force: true })
  })

  it('folds up front on a later turn once a route is known image-blind', async () => {
    const dshHome = await bootDshHome()
    // Turn one: refuse then heal (two requests). Turn two: single folded request.
    const server = await mockServer([IMAGE_REFUSAL_400, { events: textEvents }, { events: textEvents }])
    const ctx = await bootAdapter(dshHome, `${server.url}/v1`, [{ id: 'vision-claim' }])

    await assemble(ctx, { provider: 'relay', model: 'vision-claim', messages: [userImage()] })
    const second = await assemble(ctx, { provider: 'relay', model: 'vision-claim', messages: [userImage()] })

    expect(second.finish).toEqual({ kind: 'stop' })
    // Three total requests: 2 for the first (healing) turn, 1 for the second.
    expect(server.paths).toHaveLength(3)
    // The second turn folded up front: its single request carries no image.
    expect(JSON.stringify(server.requests[2])).not.toContain('image_url')
    await rm(dshHome, { recursive: true, force: true })
  })

  it('does not fold or re-run when a genuinely image-capable route succeeds', async () => {
    const dshHome = await bootDshHome()
    const server = await mockServer([{ events: textEvents }])
    const ctx = await bootAdapter(dshHome, `${server.url}/v1`, [{ id: 'real-vision', input: ['text', 'image'] }])

    const result = await assemble(ctx, {
      provider: 'relay',
      model: 'real-vision',
      messages: [userImage()],
    })

    expect(result.finish).toEqual({ kind: 'stop' })
    expect(server.paths).toEqual(['/v1/chat/completions'])
    // A real vision route still receives the image.
    expect(JSON.stringify(server.requests[0])).toContain('image_url')
    await rm(dshHome, { recursive: true, force: true })
  })
})

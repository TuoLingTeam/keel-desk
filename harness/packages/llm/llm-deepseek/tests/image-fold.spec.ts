/**
 * Image handling on a text-only wire route: images fold into text before
 * serialization (including images nested in tool results), the fold leaves
 * frozen history untouched, and the adapter only claims image input while a
 * resolver is actually mounted.
 */
import { describe, expect, it, vi } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { CallId, createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { foldImagesToText, serializeMessages } from '../src/serialize.ts'
import type { ImageTextResolver } from '../src/serialize.ts'
import { DeepSeekAdapter } from '../src/adapter.ts'
import type { DeepSeekConnectionOptions } from '../src/adapter.ts'

function imageRef(name: string): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(`att-${name}`),
    mediaType: 'image/png',
    bytes: 8,
    width: 2,
    height: 2,
    name,
  }
}

const resolver: ImageTextResolver = block =>
  Promise.resolve(`[text of ${block.attachment.name ?? 'image'}]`)

describe('foldImagesToText', () => {
  it('replaces a user image with its text so serialization keeps the content', async () => {
    const history = [createUserMessage({
      content: [
        { type: 'text', text: 'what does this say? ' },
        { type: 'image', attachment: imageRef('shot.png') },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })]

    const folded = await foldImagesToText(history, resolver)
    expect(serializeMessages(folded)).toEqual([
      { role: 'user', content: 'what does this say? [text of shot.png]' },
    ])
  })

  it('reaches images nested inside a tool result, which is how read_image returns one', async () => {
    const history = [createUserMessage({
      content: [{
        type: 'tool-result',
        toolCallId: CallId('call-1'),
        content: [
          { type: 'text', text: 'read_image ok\n' },
          { type: 'image', attachment: imageRef('diagram.png') },
        ],
      }],
      source: { kind: 'plugin', plugin: 'test' },
    })]

    const folded = await foldImagesToText(history, resolver)
    expect(serializeMessages(folded)).toEqual([
      { role: 'tool', tool_call_id: 'call-1', content: 'read_image ok\n[text of diagram.png]' },
    ])
  })

  it('leaves image-free history as the very same objects', async () => {
    const history = [createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'no pictures here' }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    const folded = await foldImagesToText(history, resolver)
    expect(folded[0]).toBe(history[0])
  })

  it('does not mutate the frozen original', async () => {
    const history = [createUserMessage({
      content: [{ type: 'image', attachment: imageRef('a.png') }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    await foldImagesToText(history, resolver)
    expect(history[0]!.content[0]!.type).toBe('image')
  })
})

describe('serializeMessages without a fold', () => {
  it('still refuses an image outright, so nothing can silently erase one', () => {
    const history = [createUserMessage({
      content: [{ type: 'image', attachment: imageRef('a.png') }],
      source: { kind: 'plugin', plugin: 'test' },
    })]
    expect(() => serializeMessages(history)).toThrow(/does not support image content/)
  })
})

describe('DeepSeekAdapter input modalities', () => {
  const connection = (): DeepSeekConnectionOptions => ({
    baseURL: 'https://api.example.test',
    apiKey: undefined,
    defaults: {},
    maxTokens: 1024,
    defaultContextWindow: 1024,
    models: [{ id: 'deepseek-v4-flash', name: 'V4 Flash' }],
    streamIdleTimeoutMs: 1000,
    retryPolicy: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitter: 0 },
  } as unknown as DeepSeekConnectionOptions)

  const build = (resolveImageText?: () => ImageTextResolver | undefined) => new DeepSeekAdapter({
    options: connection,
    resolveApiKey: () => Promise.resolve('key'),
    resolveUserId: () => 'anon' as AnonymousUserId,
    ...resolveImageText === undefined ? {} : { resolveImageText },
  })

  it('stays text-only when no image-text resolver is mounted', async () => {
    const adapter = build()
    expect((await adapter.listModels('deepseek-official'))[0]!.inputModalities).toEqual(['text'])
    const resolved = await adapter.resolveModel('deepseek-official', 'deepseek-v4-flash')
    expect(resolved.inputModalities).toEqual(['text'])
  })

  it('declares image input once a resolver can turn a picture into text', async () => {
    const adapter = build(() => resolver)
    expect((await adapter.listModels('deepseek-official'))[0]!.inputModalities).toEqual(['text', 'image'])
    const resolved = await adapter.resolveModel('deepseek-official', 'deepseek-v4-flash')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('answers for an uncatalogued model the same way as a catalogued one', async () => {
    const adapter = build(() => resolver)
    const resolved = await adapter.resolveModel('deepseek-official', 'not-in-catalog')
    expect(resolved.inputModalities).toEqual(['text', 'image'])
  })

  it('re-checks the resolver per call, so the capability follows the composition', async () => {
    const resolveImageText = vi.fn<() => ImageTextResolver | undefined>(() => undefined)
    const adapter = build(resolveImageText)
    expect((await adapter.listModels('deepseek-official'))[0]!.inputModalities).toEqual(['text'])
    resolveImageText.mockReturnValue(resolver)
    expect((await adapter.listModels('deepseek-official'))[0]!.inputModalities).toEqual(['text', 'image'])
  })
})

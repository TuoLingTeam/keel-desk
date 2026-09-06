/**
 * Harness request-history conversion into pi-ai's Context vocabulary.
 *
 * @module dsh-llm-pi-ai/context
 */

import { CallId, contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, Message } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Context as PiContext, ImageContent, Message as PiMessage, TextContent, Tool as PiTool } from '@earendil-works/pi-ai'
import { toPiAssistant } from './replay.ts'

/**
 * Produce the text that stands in for one image block on a text-only route.
 * When {@link toPiContextTextFolded} runs, every image in the conversation —
 * a user upload or a `read_image` tool result — is replaced with this text
 * instead of the picture. This is the cure for a model/relay that reports (or
 * is over-declared as) image-capable but refuses images on the wire: the model
 * still receives what the picture says (its path and, when available, its OCR
 * text) rather than the whole turn dying with a 400 that no retry can clear.
 * Mirrors the `ImageTextResolver` seam `llm-deepseek` already uses.
 */
export type ImageTextFold = (block: ImageBlock) => Promise<string>

/** Join the text blocks of a harness message. */
function flattenText(message: Message): string {
  return message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}


/** Flatten text recursively inside one tool result. */
function toolResultText(blocks: readonly ContentBlock[]): string {
  return blocks.map(block => block.type === 'text'
    ? block.text
    : block.type === 'tool-result' ? toolResultText(block.content) : '').join('')
}

async function userContent(
  blocks: readonly ContentBlock[],
  attachments: AttachmentStore,
): Promise<string | (TextContent | ImageContent)[]> {
  const content: (TextContent | ImageContent)[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.length > 0) content.push({ type: 'text', text: block.text })
        break
      case 'image': {
        const stored = await attachments.readImage(block.attachment)
        content.push({
          type: 'image',
          data: Buffer.from(stored.data).toString('base64'),
          mimeType: stored.ref.mediaType,
        })
        break
      }
      case 'tool-result':
        {
          const nested = await userContent(block.content, attachments)
          if (typeof nested === 'string') {
            if (nested.length > 0) content.push({ type: 'text', text: nested })
          } else {
            content.push(...nested)
          }
        }
        break
      default:
        // Other merge-extensible blocks are not user-input vocabulary for pi-ai.
        break
    }
  }
  if (content.every(block => block.type === 'text')) return content.map(block => block.text).join('')
  return content
}

function toolsOf(options: GenerateOptions): PiTool[] | undefined {
  return options.tools?.map(tool => ({
    name: tool.name,
    description: tool.description,
    // ToolSchema.parameters is a JSON Schema object; pi-ai's TSchema
    // (TypeBox) is structurally JSON Schema, so it assigns directly.
    parameters: tool.parameters,
  }))
}

/** Assemble the request-level pi-ai context envelope shared by both conversion paths. */
function piContext(options: GenerateOptions, messages: PiMessage[]): PiContext {
  const tools = toolsOf(options)
  return {
    ...options.system !== undefined ? { systemPrompt: options.system } : {},
    messages,
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
  }
}

function textOnlyContext(options: GenerateOptions): PiContext {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (contentHasImage(message.content)) {
      throw new LlmError('pi-ai image conversion requires the durable attachment service', 'UNSUPPORTED_CONTENT')
    }
    if (message.role === 'system') {
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      messages.push(assistant)
      continue
    }
    const text = flattenText(message)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) messages.push({ role: 'user', content: text, timestamp: 0 })
    for (const result of results) {
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{
          type: 'text',
          text: toolResultText(result.content) || '(no output)',
        }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}

/**
 * Convert text-only harness history to a synchronous pi-ai Context. Tool
 * result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @returns the pi-ai context; `tools` is omitted when the request declares none.
 */
export function toPiContext(options: GenerateOptions): PiContext
/**
 * Convert harness history to a pi-ai Context while resolving durable images.
 * Tool result names are recovered from preceding assistant tool calls.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param attachments - durable byte resolver for image references.
 * @returns the asynchronously resolved pi-ai context.
 */
export function toPiContext(options: GenerateOptions, attachments: AttachmentStore): Promise<PiContext>
export function toPiContext(options: GenerateOptions, attachments?: AttachmentStore): PiContext | Promise<PiContext> {
  return attachments === undefined ? textOnlyContext(options) : toPiContextWithImages(options, attachments)
}

async function toPiContextWithImages(options: GenerateOptions, attachments: AttachmentStore): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []

  for (const message of options.messages) {
    if (message.role === 'system') {
      if (contentHasImage(message.content)) {
        throw new LlmError('pi-ai cannot represent an image in an in-history system message', 'UNSUPPORTED_CONTENT')
      }
      // pi-ai has a single systemPrompt slot; in-history system messages are
      // folded into user messages to preserve order (rare in practice — the
      // harness sends the system prompt via options.system).
      messages.push({ role: 'user', content: flattenText(message), timestamp: 0 })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    // user role: text + tool results (each result becomes its own message).
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const content = await userContent(regular, attachments)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (content.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content, timestamp: 0 })
    }
    for (const result of results) {
      const resultContent = await userContent(result.content, attachments)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: typeof resultContent === 'string'
          ? [{ type: 'text', text: resultContent || '(no output)' }]
          : resultContent,
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }

  return piContext(options, messages)
}

/** Fold one block list to text, resolving images and recursing into tool results. */
async function foldBlocksToText(
  blocks: readonly ContentBlock[],
  fold: ImageTextFold,
): Promise<string> {
  const parts: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') {
      if (block.text.length > 0) parts.push(block.text)
      continue
    }
    if (block.type === 'image') {
      parts.push(await fold(block))
      continue
    }
    // `read_image` returns its picture inside a tool result, so nested content
    // needs the same fold as a directly attached image.
    if (block.type === 'tool-result') {
      const nested = await foldBlocksToText(block.content, fold)
      if (nested.length > 0) parts.push(nested)
    }
  }
  return parts.join('\n')
}

/**
 * Convert harness history to a pi-ai Context with every image folded to text.
 *
 * Used when the routed model is image-blind (declared text-only, or learned so
 * after the relay refused an image). No `image` content ever reaches the wire,
 * so the exact 400 that poisoned the session — "This model does not support
 * image" — cannot recur, and an already-poisoned session self-heals on its
 * next send without rewriting the durable log. Tool result names are recovered
 * from preceding assistant tool calls, exactly as the other paths do.
 * @param options - the harness request; `options.system` maps to pi-ai's single `systemPrompt` slot.
 * @param fold - produces the stand-in text for one image block.
 * @returns the asynchronously resolved, wholly text pi-ai context.
 */
export async function toPiContextTextFolded(
  options: GenerateOptions,
  fold: ImageTextFold,
): Promise<PiContext> {
  const toolNames = new Map<CallId, string>()
  const messages: PiMessage[] = []
  for (const message of options.messages) {
    if (message.role === 'system') {
      // A system message with an image is degenerate here too, but folding is
      // strictly safer than the throw the base path uses: the text survives.
      messages.push({
        role: 'user',
        content: await foldBlocksToText(message.content, fold),
        timestamp: 0,
      })
      continue
    }
    if (message.role === 'assistant') {
      const assistant = toPiAssistant(message)
      for (const block of assistant.content) {
        if (block.type === 'toolCall') toolNames.set(CallId(block.id), block.name)
      }
      messages.push(assistant)
      continue
    }
    const regular = message.content.filter(block => block.type !== 'tool-result')
    const text = await foldBlocksToText(regular, fold)
    const results = message.content.filter(block => block.type === 'tool-result')
    if (text.length > 0 || results.length === 0) {
      messages.push({ role: 'user', content: text, timestamp: 0 })
    }
    for (const result of results) {
      const resultText = await foldBlocksToText(result.content, fold)
      messages.push({
        role: 'toolResult',
        toolCallId: result.toolCallId,
        toolName: toolNames.get(result.toolCallId) ?? 'unknown',
        content: [{ type: 'text', text: resultText || '(no output)' }],
        isError: result.isError ?? false,
        timestamp: 0,
      })
    }
  }
  return piContext(options, messages)
}

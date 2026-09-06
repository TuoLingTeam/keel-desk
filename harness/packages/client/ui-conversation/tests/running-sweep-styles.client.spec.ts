/**
 * Running-row glare must travel on the compositor. Animating inset geometry
 * (`left`) dirties layout every frame and WKWebView walks the unvirtualized
 * chat tree.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

function keyframes(css: string, name: string): string {
  const frames = new RegExp(`@keyframes ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)
  if (frames === null) throw new Error(`missing @keyframes ${name}`)
  return frames[1] ?? ''
}

describe('running sweep styles', () => {
  it('moves command and reasoning glare with transform, not left', () => {
    const command = readFileSync(
      fileURLToPath(new URL('../src/client/chat/GenericCommandCard.module.css', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, ' ')
    const reasoning = readFileSync(
      fileURLToPath(new URL('../src/client/chat/ReasoningRow.module.css', import.meta.url)),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, ' ')
    for (const [css, name] of [
      [command, 'dsh-command-row-sweep'],
      [reasoning, 'dsh-reasoning-row-sweep'],
    ] as const) {
      const body = keyframes(css, name)
      expect(body).toMatch(/transform:\s*translateX/)
      expect(body).not.toMatch(/\bleft\s*:/)
    }
  })
})

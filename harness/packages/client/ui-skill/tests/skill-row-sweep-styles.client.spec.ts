/**
 * Skill running glare must travel on the compositor. See ToolRow.module.css.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/SkillRow.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

describe('SkillRow.module.css running sweep', () => {
  it('animates with transform, not inset geometry', () => {
    const frames = /@keyframes dsh-skill-row-sweep\s*\{([\s\S]*?)\n\}/.exec(css)
    if (frames === null) throw new Error('SkillRow.module.css has no dsh-skill-row-sweep keyframes')
    expect(frames[1]).toMatch(/transform:\s*translateX/)
    expect(frames[1]).not.toMatch(/\bleft\s*:/)
  })
})

// Domain-core tests (node:test). The store's shape and pin/reorder/import
// semantics must stay interoperable with the sibling codex-desktop app.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  appendQuickCommandText, applyImport, createCommand, filterQuickCommands,
  isPinnedPartitioned, parseImportPayload, parseStoredQuickCommands, reorderCommands,
  resolveQuickCommandPlacement, seedDefaultQuickCommands, setCommandPinned,
} from '../src/quick-commands-core.mjs'

test('seeds five commands with qc_ ids', () => {
  const seed = seedDefaultQuickCommands()
  assert.equal(seed.length, 5)
  assert.ok(seed.every(c => c.id.startsWith('qc_')))
})

test('create inserts below the pinned region and keeps the invariant', () => {
  let list = [{ id: 'p1', text: 'P', pinned: true }, { id: 'a', text: 'A' }]
  list = createCommand(list, 'NEW')
  assert.deepEqual(list.map(c => c.text), ['P', 'NEW', 'A'])
  assert.ok(isPinnedPartitioned(list))
})

test('pin moves to the pinned tail, unpin to the plain head', () => {
  let list = [{ id: 'p', text: 'P', pinned: true }, { id: 'a', text: 'A' }, { id: 'b', text: 'B' }]
  list = setCommandPinned(list, 'a', true)
  assert.deepEqual(list.map(c => c.text), ['P', 'A', 'B'])
  list = setCommandPinned(list, 'p', false)
  assert.deepEqual(list.map(c => c.text), ['A', 'P', 'B'])
  assert.ok(isPinnedPartitioned(list))
})

test('reorder rejects non-permutations and partition-breaking orders', () => {
  const list = [{ id: 'p', text: 'P', pinned: true }, { id: 'a', text: 'A' }, { id: 'b', text: 'B' }]
  assert.deepEqual(reorderCommands(list, ['p', 'b', 'a']).map(c => c.text), ['P', 'B', 'A'])
  assert.equal(reorderCommands(list, ['a', 'p', 'b']), null) // plain before pinned
  assert.equal(reorderCommands(list, ['x', 'y', 'z']), null) // wrong ids
})

test('import parses both shapes, drops blanks, rejects bad rows', () => {
  assert.deepEqual(parseImportPayload('[{"text":"a"},{"text":" "},{"text":"b"}]'), { ok: true, texts: ['a', 'b'], dropped: 1 })
  assert.deepEqual(parseImportPayload('{"commands":[{"text":"x"}]}'), { ok: true, texts: ['x'], dropped: 0 })
  assert.equal(parseImportPayload('[{"nope":1}]').ok, false)
  assert.equal(parseImportPayload('nope').ok, false)
})

test('applyImport replace regenerates, merge dedups by text', () => {
  assert.deepEqual(applyImport([{ id: 'a', text: 'A' }], ['B'], 'replace').commands.map(c => c.text), ['B'])
  const merged = applyImport([{ id: 'a', text: 'A' }], ['A', 'C'], 'merge')
  assert.deepEqual(merged.commands.map(c => c.text), ['A', 'C'])
  assert.deepEqual([merged.imported, merged.skipped], [1, 1])
})

test('parse heals bad files, dup ids, and unpartitioned tables', () => {
  assert.equal(parseStoredQuickCommands({}).commands.length, 5)
  assert.equal(parseStoredQuickCommands({}).needsRewrite, true)
  const healed = parseStoredQuickCommands({ version: 1, commands: [{ id: 'x', text: 'X' }, { id: 'y', text: 'Y', pinned: true }] })
  assert.deepEqual(healed.commands.map(c => c.text), ['Y', 'X'])
  assert.equal(healed.needsRewrite, true)
  const dup = parseStoredQuickCommands({ version: 1, commands: [{ id: 'd', text: '1' }, { id: 'd', text: '2' }] })
  assert.equal(new Set(dup.commands.map(c => c.id)).size, 2)
})

test('append and filter helpers', () => {
  assert.equal(appendQuickCommandText('', 'S'), 'S')
  assert.equal(appendQuickCommandText('  ', 'S'), 'S')
  assert.equal(appendQuickCommandText('hi', 'S'), 'hi\nS')
  assert.deepEqual(filterQuickCommands([{ id: 'a', text: 'Hello' }, { id: 'b', text: 'World' }], 'wor').map(c => c.text), ['World'])
})

test('placement opens down when the composer sits in the middle of the window', () => {
  const place = resolveQuickCommandPlacement({
    anchor: { top: 360, bottom: 392, left: 80, right: 110, width: 30, height: 32 },
    panelWidth: 420,
    panelHeight: 360,
    viewport: { width: 1100, height: 780 },
  })
  assert.equal(place.side, 'down')
  assert.ok(place.top >= 392)
  assert.equal(place.left, 80)
})

test('placement flips up when the composer sits on the bottom edge', () => {
  const place = resolveQuickCommandPlacement({
    anchor: { top: 720, bottom: 752, left: 80, right: 110, width: 30, height: 32 },
    panelWidth: 420,
    panelHeight: 360,
    viewport: { width: 1100, height: 780 },
  })
  assert.equal(place.side, 'up')
  assert.ok(place.top + 360 <= 720)
})

test('placement flush-rights when the trigger is near the right edge', () => {
  const place = resolveQuickCommandPlacement({
    anchor: { top: 360, bottom: 392, left: 980, right: 1010, width: 30, height: 32 },
    panelWidth: 420,
    panelHeight: 200,
    viewport: { width: 1100, height: 780 },
  })
  assert.equal(place.side, 'down')
  assert.equal(place.left, 1010 - 420)
})

test('placement uses a side when both vertical gaps are too short', () => {
  const place = resolveQuickCommandPlacement({
    anchor: { top: 180, bottom: 420, left: 40, right: 70, width: 30, height: 240 },
    panelWidth: 360,
    panelHeight: 360,
    viewport: { width: 900, height: 500 },
  })
  assert.equal(place.side, 'right')
  assert.ok(place.left >= 70)
})

test('placement uses left when the trigger sits on the right of a short window', () => {
  const place = resolveQuickCommandPlacement({
    anchor: { top: 180, bottom: 420, left: 820, right: 850, width: 30, height: 240 },
    panelWidth: 360,
    panelHeight: 360,
    viewport: { width: 900, height: 500 },
  })
  assert.equal(place.side, 'left')
  assert.ok(place.left + 360 <= 820)
})

test('placement stays below the conversation header and above the bottom inset', () => {
  const place = resolveQuickCommandPlacement({
    anchor: { top: 640, bottom: 760, left: 80, right: 110, width: 30, height: 120 },
    panelWidth: 420,
    panelHeight: 520,
    viewport: { width: 1100, height: 780 },
    inset: { top: 96, bottom: 24 },
  })
  assert.equal(place.side, 'up')
  assert.ok(place.top >= 96)
  assert.ok(place.top + place.maxHeight <= 780 - 24)
})

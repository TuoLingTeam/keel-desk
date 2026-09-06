/**
 * 场景活卡片：同一 family + scene_name 只保留一条 L1。
 * 新进度叠进正文，不新开条。空场景名仍按「一条一事」走（主机/密钥各一条）。
 */
import type { MemoryFamily, MemoryRecord } from '../types.js';
import type { L1Store } from './l1.js';

const CARD_MAX = 24_000;
const NOTE_MAX = 1_800;

export function sceneCardKey(family: MemoryFamily, scene: string): string | null {
  const s = scene.trim();
  return s ? `${family}::${s}` : null;
}

export function compactSceneNote(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
}

const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function extractIps(text: string): string[] {
  return [...new Set(text.match(IPV4_RE) ?? [])];
}

/** 新笔记改了 IP / 主机当前值：整卡换成新正文，避免旧 IP 和新 IP 并排。 */
export function shouldReplaceSceneCard(existing: string, incoming: string): boolean {
  const oldIps = extractIps(existing);
  const newIps = extractIps(incoming);
  if (oldIps.length > 0 && newIps.length > 0) {
    const same = oldIps.length === newIps.length && oldIps.every((ip) => newIps.includes(ip));
    if (!same) return true;
  }
  return false;
}

/** 新笔记叠到活卡片顶部；旧正文去头去尾后接在后面，总长封顶。 */
export function mergeIntoSceneCard(existing: string, incoming: string, now = Date.now()): string {
  const note = compactSceneNote(incoming);
  if (!note) return existing.trim();
  const old = existing.trim();
  if (!old) return note.slice(0, CARD_MAX);
  if (shouldReplaceSceneCard(old, note)) return note.slice(0, CARD_MAX);
  if (old.includes(note) || note.includes(old.slice(0, Math.min(old.length, 80)))) {
    return old;
  }
  const stamp = new Date(now).toISOString().slice(0, 16).replace('T', ' ');
  const block = `【${stamp}】${note}`;
  const merged = `${block}\n\n${old}`;
  if (merged.length <= CARD_MAX) return merged;
  return `${merged.slice(0, CARD_MAX - 1)}…`;
}

export function listSceneCards(l1: L1Store, family: MemoryFamily, scene: string): MemoryRecord[] {
  const name = scene.trim();
  if (!name) return [];
  return l1.list({ family, scene: name, limit: 200, offset: 0 }).items;
}

export interface ConsolidateResult {
  scenes: number;
  kept: number;
  removed: number;
}

/**
 * 把库里同场景多条压成一张活卡片（保留最新那条的 id，正文按时间新→旧拼接）。
 * 空场景名不合并。
 */
export async function consolidateSceneCards(l1: L1Store): Promise<ConsolidateResult> {
  const all = l1.all();
  const groups = new Map<string, MemoryRecord[]>();
  for (const r of all) {
    const family = r.family ?? (r.type.startsWith('work') ? 'work' : 'chat');
    const key = sceneCardKey(family, r.scene_name ?? '');
    if (!key) continue;
    const arr = groups.get(key) ?? [];
    arr.push(r);
    groups.set(key, arr);
  }
  let kept = 0;
  let removed = 0;
  let scenes = 0;
  for (const [, items] of groups) {
    if (items.length < 2) continue;
    scenes += 1;
    items.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const head = items[items.length - 1]!;
    const extras = items.slice(0, -1);
    let content = compactSceneNote(items[0]!.content);
    for (const extra of extras.slice(1).concat(head)) {
      content = mergeIntoSceneCard(content, extra.content, extra.updatedAt || extra.createdAt);
    }
    const now = Date.now();
    await l1.rewrite({
      ...head,
      content,
      updatedAt: now,
      timestamps: Array.from(new Set(items.flatMap((r) => r.timestamps ?? []).concat([now]))).sort((a, b) => a - b),
      version: (head.version ?? 0) + 1,
    });
    await l1.deleteBatch(extras.map((r) => r.id));
    kept += 1;
    removed += extras.length;
  }
  return { scenes, kept, removed };
}

const CARD_MAX = 24e3;
const NOTE_MAX = 1800;
function sceneCardKey(family, scene) {
  const s = scene.trim();
  return s ? `${family}::${s}` : null;
}
function compactSceneNote(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);
}
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
function extractIps(text) {
  return [...new Set(text.match(IPV4_RE) ?? [])];
}
function shouldReplaceSceneCard(existing, incoming) {
  const oldIps = extractIps(existing);
  const newIps = extractIps(incoming);
  if (oldIps.length > 0 && newIps.length > 0) {
    const same = oldIps.length === newIps.length && oldIps.every((ip) => newIps.includes(ip));
    if (!same) return true;
  }
  return false;
}
function mergeIntoSceneCard(existing, incoming, now = Date.now()) {
  const note = compactSceneNote(incoming);
  if (!note) return existing.trim();
  const old = existing.trim();
  if (!old) return note.slice(0, CARD_MAX);
  if (shouldReplaceSceneCard(old, note)) return note.slice(0, CARD_MAX);
  if (old.includes(note) || note.includes(old.slice(0, Math.min(old.length, 80)))) {
    return old;
  }
  const stamp = new Date(now).toISOString().slice(0, 16).replace("T", " ");
  const block = `\u3010${stamp}\u3011${note}`;
  const merged = `${block}

${old}`;
  if (merged.length <= CARD_MAX) return merged;
  return `${merged.slice(0, CARD_MAX - 1)}\u2026`;
}
function listSceneCards(l1, family, scene) {
  const name = scene.trim();
  if (!name) return [];
  return l1.list({ family, scene: name, limit: 200, offset: 0 }).items;
}
async function consolidateSceneCards(l1) {
  const all = l1.all();
  const groups = /* @__PURE__ */ new Map();
  for (const r of all) {
    const family = r.family ?? (r.type.startsWith("work") ? "work" : "chat");
    const key = sceneCardKey(family, r.scene_name ?? "");
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
    const head = items[items.length - 1];
    const extras = items.slice(0, -1);
    let content = compactSceneNote(items[0].content);
    for (const extra of extras.slice(1).concat(head)) {
      content = mergeIntoSceneCard(content, extra.content, extra.updatedAt || extra.createdAt);
    }
    const now = Date.now();
    await l1.rewrite({
      ...head,
      content,
      updatedAt: now,
      timestamps: Array.from(new Set(items.flatMap((r) => r.timestamps ?? []).concat([now]))).sort((a, b) => a - b),
      version: (head.version ?? 0) + 1
    });
    await l1.deleteBatch(extras.map((r) => r.id));
    kept += 1;
    removed += extras.length;
  }
  return { scenes, kept, removed };
}
export {
  compactSceneNote,
  consolidateSceneCards,
  listSceneCards,
  mergeIntoSceneCard,
  sceneCardKey,
  shouldReplaceSceneCard
};

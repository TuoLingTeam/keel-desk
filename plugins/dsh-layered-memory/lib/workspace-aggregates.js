import { snapshotDistillUsage } from "./llm-usage.js";
import { META_END } from "./store/scenes.js";
const SEARCH_CAP = 200;
const WINDOW_CAP = 500;
const TITLE_MAX = 60;
const FAMILIES = ["chat", "work"];
function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const v = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return typeof v.o === "number" && Number.isInteger(v.o) && v.o >= 0 && v.o <= 1e6 ? v.o : 0;
  } catch {
    return 0;
  }
}
function l1Title(content) {
  const firstLine = content.split("\n", 1)[0] ?? "";
  const t = firstLine.trim().replace(/^【\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}】\s*/, "");
  const clean = t.trim() || firstLine.trim();
  return clean.length > TITLE_MAX ? clean.slice(0, TITLE_MAX - 1) + "\u2026" : clean;
}
function l1ToItem(r) {
  const family = r.family ?? "chat";
  return {
    id: `l1:${r.id}`,
    kind: "l1",
    verb: (r.version ?? 0) > 1 ? "upd" : "new",
    family,
    title: l1Title(r.content),
    content: r.content,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    version: r.version ?? 0,
    sourceSession: r.sessionId ?? null,
    scene: r.scene_name || null,
    l1Type: r.type || null
  };
}
function stripSceneMeta(raw) {
  const end = raw.indexOf(META_END);
  if (end === -1) return raw;
  return raw.slice(end + META_END.length).replace(/^\s*\n/, "");
}
const ts = (iso) => iso ? Date.parse(iso) || 0 : 0;
async function collectAssetActivity(stores, q) {
  const pool = [];
  const window = Math.min(q.offset + q.limit + 1, WINDOW_CAP);
  const sinceIso = q.sinceMs > 0 ? new Date(q.sinceMs).toISOString() : void 0;
  const familyOpt = q.family || void 0;
  let truncated = false;
  if (q.kind === "" || q.kind === "l1") {
    let items2;
    if (q.query) {
      const hits = await stores.l1.search(q.query, Math.min(window, SEARCH_CAP), { family: familyOpt });
      items2 = stores.l1.getByIds(hits.map((h) => h.id));
      truncated = window > SEARCH_CAP;
    } else {
      items2 = stores.l1.list({ family: familyOpt, since: sinceIso, limit: window, offset: 0 }).items;
    }
    for (const r of items2) {
      if (sinceIso && r.updatedAt && new Date(r.updatedAt).toISOString() < sinceIso) continue;
      pool.push(l1ToItem(r));
    }
  }
  if (q.kind === "" || q.kind === "l2") {
    for (const family of FAMILIES) {
      if (familyOpt && family !== familyOpt) continue;
      const scenes = await stores.scenes[family].list();
      for (const s of scenes) {
        const updatedMs = Date.parse(s.updated) || 0;
        const createdMs = Date.parse(s.created) || 0;
        if (q.sinceMs > 0 && (!updatedMs || updatedMs < q.sinceMs)) continue;
        if (q.query) {
          const needle = q.query.toLowerCase();
          if (!s.path.toLowerCase().includes(needle) && !s.summary.toLowerCase().includes(needle)) continue;
        }
        pool.push({
          id: `l2:${family}:${s.path}`,
          kind: "l2",
          verb: updatedMs > createdMs ? "upd" : "new",
          family,
          title: s.path.replace(/\.md$/i, ""),
          content: s.summary,
          // 页内切片后补读正文（见下）
          createdAt: s.created && createdMs ? new Date(createdMs).toISOString() : null,
          updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
          version: null,
          sourceSession: null,
          scene: null,
          l1Type: null
        });
      }
    }
  }
  if (q.kind === "" || q.kind === "l3") {
    for (const family of FAMILIES) {
      if (familyOpt && family !== familyOpt) continue;
      const store = stores.persona[family];
      const [content, mtimeMs] = await Promise.all([store.read(), store.mtime()]);
      if (!content || !mtimeMs) continue;
      if (q.sinceMs > 0 && mtimeMs < q.sinceMs) continue;
      if (q.query && !content.toLowerCase().includes(q.query.toLowerCase())) continue;
      pool.push({
        id: `l3:${family}`,
        kind: "l3",
        verb: "upd",
        // 画像只有演进没有首版语义（mtime 即最近一次蒸馏写入）
        family,
        title: `persona-${family}.md`,
        content,
        createdAt: null,
        updatedAt: new Date(mtimeMs).toISOString(),
        version: null,
        sourceSession: null,
        scene: null,
        l1Type: null
      });
    }
  }
  pool.sort((a, b) => ts(b.updatedAt) - ts(a.updatedAt) || (a.id < b.id ? -1 : 1));
  const items = pool.slice(q.offset, q.offset + q.limit);
  await Promise.all(
    items.map(async (it) => {
      if (it.kind !== "l2") return;
      const raw = await stores.scenes[it.family].read(it.id.slice(`l2:${it.family}:`.length));
      const body = raw ? stripSceneMeta(raw).trim() : "";
      if (body) it.content = body;
    })
  );
  return {
    items,
    nextCursor: pool.length > q.offset + q.limit ? encodeCursor(q.offset + q.limit) : null,
    truncated
  };
}
async function buildWorkspaceOverview(stores, base, week, retrieval) {
  const recent = await collectAssetActivity(stores, {
    query: "",
    kind: "",
    family: "",
    sinceMs: 0,
    limit: 5,
    offset: 0
  });
  return {
    ok: true,
    degraded: base.message !== "running",
    retrieval,
    pendingExtract: base.pendingExtract,
    l0Today: base.l0Today,
    l1Count: base.l1Count,
    sceneCount: base.sceneCount,
    personaChars: base.personaChars,
    empty: base.l1Count === 0 && base.sceneCount === 0 && base.personaChars === 0,
    lastExtractAt: base.lastExtractAt,
    lastL2At: base.lastL2At,
    lastL3At: base.lastL3At,
    week,
    recent: recent.items
  };
}
const DAY_MS = 24 * 36e5;
function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
async function buildRuntimeInsights(stores, sessionInfo, modes, live) {
  const today = utcDay(Date.now());
  const startMs = Date.parse(today + "T00:00:00Z") - 6 * DAY_MS;
  const buckets = /* @__PURE__ */ new Map();
  for (let i = 0; i < 7; i++) {
    buckets.set(utcDay(startMs + i * DAY_MS), { l1: 0, l2: 0, l3: 0 });
  }
  const bump = (ms, k) => {
    const b = buckets.get(utcDay(ms));
    if (b) b[k]++;
  };
  for (const row of stores.l1.countByDay(new Date(startMs).toISOString())) {
    const b = buckets.get(row.day);
    if (b) b.l1 += row.n;
  }
  for (const family of FAMILIES) {
    const scenes = await stores.scenes[family].list();
    for (const s of scenes) {
      const ms = Date.parse(s.updated) || 0;
      if (ms >= startMs) bump(ms, "l2");
    }
    const mtimeMs = await stores.persona[family].mtime();
    if (mtimeMs !== null && mtimeMs >= startMs) bump(mtimeMs, "l3");
  }
  const activityDays = Array.from(buckets.entries(), ([day, v]) => ({ day, ...v }));
  const usage = snapshotDistillUsage();
  const layerOrder = ["l1-extract", "l1-dedup", "l2", "l3"];
  const distill = layerOrder.map((layer) => ({
    layer,
    calls: usage.layers[layer]?.calls ?? 0,
    failures: usage.layers[layer]?.failures ?? 0
  }));
  const all = sessionInfo?.recallStatsAll?.() ?? [];
  const sums = { injectedTurns: 0, hitTurns: 0, totalHits: 0, timeouts: 0, suppressedRecalls: 0 };
  for (const s of all) {
    sums.injectedTurns += s.injectedTurns;
    sums.hitTurns += s.hitTurns;
    sums.totalHits += s.totalHits;
    sums.timeouts += s.timeouts;
    sums.suppressedRecalls += s.suppressedRecalls;
  }
  const counts = modes?.countStates() ?? { off: 0, wo: 0 };
  return {
    ok: true,
    activityDays,
    distill,
    recall: {
      sessions: all.length,
      ...sums,
      globalRecall: live?.get()?.recall ?? true,
      sessionsModeOff: counts.off,
      sessionsWriteOnly: counts.wo
    }
  };
}
export {
  buildRuntimeInsights,
  buildWorkspaceOverview,
  collectAssetActivity,
  decodeCursor
};

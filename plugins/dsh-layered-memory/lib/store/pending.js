import * as path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "./io.js";
const LEGACY_SESSION = "legacy";
function freshWarmup() {
  return { auto: 1, chat: 1, work: 1 };
}
function emptyPending() {
  return { auto: [], chat: [], work: [] };
}
function isMessage(m) {
  if (!m || typeof m !== "object") return false;
  const r = m;
  return typeof r.id === "string" && typeof r.content === "string" && (r.role === "user" || r.role === "assistant");
}
async function loadPending(file, logger) {
  const out = emptyPending();
  let raw;
  try {
    raw = await readJsonIfExists(file);
  } catch {
    raw = void 0;
  }
  if (!raw || typeof raw !== "object" || !raw.buckets || typeof raw.buckets !== "object") {
    return { buckets: out, warmup: freshWarmup() };
  }
  let dropped = 0;
  let legacy = 0;
  for (const key of ["auto", "chat", "work"]) {
    const arr = raw.buckets[key];
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      if (!isMessage(m)) {
        dropped++;
        continue;
      }
      const sid = m.sessionId;
      if (typeof sid === "string" && sid) {
        out[key].push({ ...m, sessionId: sid });
      } else {
        legacy++;
        out[key].push({ ...m, sessionId: LEGACY_SESSION });
      }
    }
  }
  if (dropped > 0) logger?.warn(`[memory] \u672A\u84B8\u998F\u7F13\u51B2\u6587\u4EF6\u542B ${dropped} \u6761\u574F\u8BB0\u5F55\uFF0C\u5DF2\u4E22\u5F03`);
  if (legacy > 0) logger?.info(`[memory] \u672A\u84B8\u998F\u7F13\u51B2\u542B ${legacy} \u6761\u65E7\u683C\u5F0F\u6761\u76EE\uFF0C\u5F52\u5165 legacy \u4F1A\u8BDD\u7EC4`);
  const warmup = freshWarmup();
  for (const key of ["auto", "chat", "work"]) {
    const w = raw.warmup?.[key];
    if (typeof w === "number" && Number.isFinite(w) && w >= 0) warmup[key] = Math.floor(w);
  }
  return { buckets: out, warmup };
}
function groupPendingBySession(messages) {
  const groups = /* @__PURE__ */ new Map();
  for (const m of messages) {
    const g = groups.get(m.sessionId);
    if (g) g.push(m);
    else groups.set(m.sessionId, [m]);
  }
  return [...groups.entries()].map(([sessionId, msgs]) => ({ sessionId, messages: [...msgs].sort((a, b) => a.timestamp - b.timestamp) })).sort((a, b) => a.messages[0].timestamp - b.messages[0].timestamp);
}
async function savePending(file, buckets, warmup) {
  const payload = { version: 1, buckets, ...warmup ? { warmup } : {} };
  await atomicWriteJson(file, payload);
}
function pendingPathFor(dataDir) {
  return path.join(dataDir, "pending.json");
}
const PENDING_MODES = ["auto", "chat", "work"];
export {
  LEGACY_SESSION,
  PENDING_MODES,
  emptyPending,
  freshWarmup,
  groupPendingBySession,
  loadPending,
  pendingPathFor,
  savePending
};

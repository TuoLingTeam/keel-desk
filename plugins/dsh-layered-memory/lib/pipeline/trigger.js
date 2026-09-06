function effectiveExtractThreshold(warmup, steady) {
  if (!Number.isFinite(warmup) || warmup <= 0) return steady;
  return Math.min(warmup, steady);
}
function advanceWarmupThreshold(current, steady) {
  if (!Number.isFinite(current) || current <= 0) return 0;
  const next = current * 2;
  return next >= steady ? 0 : next;
}
function modeSwitchAction(oldMode, newMode) {
  if (oldMode === newMode) return "none";
  if (newMode === "off") return "park";
  if (oldMode === "off") return "unpark";
  return "flush";
}
function pickSessionBackground(recent, sliceIds, n) {
  if (n <= 0) return [];
  return recent.filter((m) => !sliceIds.has(m.id)).slice(-n);
}
const EXTRACT_BACKOFF_BASE_MS = 6e4;
const EXTRACT_BACKOFF_CAP_MS = 30 * 6e4;
function extractionBackoffMs(failStreak) {
  if (!Number.isFinite(failStreak) || failStreak <= 0) return EXTRACT_BACKOFF_BASE_MS;
  return Math.min(EXTRACT_BACKOFF_BASE_MS * 2 ** (failStreak - 1), EXTRACT_BACKOFF_CAP_MS);
}
function idleSessionsToFlush(slices, lastActivity, now, idleMs, isOffSession) {
  if (!(idleMs > 0)) return [];
  const out = [];
  for (const s of slices) {
    if (s.count <= 0) continue;
    if (isOffSession(s.sessionId)) continue;
    const activity = lastActivity.get(s.sessionId) ?? s.lastMessageAt;
    if (now - activity >= idleMs) out.push(s.sessionId);
  }
  return out;
}
export {
  advanceWarmupThreshold,
  effectiveExtractThreshold,
  extractionBackoffMs,
  idleSessionsToFlush,
  modeSwitchAction,
  pickSessionBackground
};

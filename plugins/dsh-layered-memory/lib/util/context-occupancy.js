const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;
function estimateInjectedMessageTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN) + BLOCK_OVERHEAD + ROLE_OVERHEAD;
}
function estimateStableSectionTokens(chars) {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
function emptyOccupancyLedger(now = Date.now()) {
  return { stockTokens: 0, recallTokens: 0, profileTokens: 0, lastInjectTokens: 0, updatedAt: now };
}
function recordRecallInjection(l, chars, now = Date.now()) {
  const tokens = estimateInjectedMessageTokens(chars);
  l.recallTokens += tokens;
  l.stockTokens += tokens;
  l.lastInjectTokens = tokens;
  l.updatedAt = now;
}
function recordProfileShare(l, chars, now = Date.now()) {
  const tokens = estimateStableSectionTokens(chars);
  l.stockTokens += tokens - l.profileTokens;
  l.profileTokens = tokens;
  l.updatedAt = now;
}
function clearProfileShare(l, now = Date.now()) {
  l.stockTokens -= l.profileTokens;
  l.profileTokens = 0;
  l.updatedAt = now;
}
function resetForCompaction(l, now = Date.now()) {
  l.stockTokens = 0;
  l.recallTokens = 0;
  l.profileTokens = 0;
  l.lastInjectTokens = 0;
  l.updatedAt = now;
}
const CONTEXT_METER_CIRCUMFERENCE = 34.55751918948772;
function haloDashArray(occupancyRatio, circumference = CONTEXT_METER_CIRCUMFERENCE, minLen = 0) {
  const clamped = Number.isFinite(occupancyRatio) ? Math.min(1, Math.max(0, occupancyRatio)) : 0;
  const len = Math.max(clamped * circumference, clamped > 0 ? minLen : 0);
  return `${len} ${circumference}`;
}
const RADIUS_EPSILON = 1e-6;
function isContextMeterAnchor(sig) {
  if (sig.ariaHasPopup !== "dialog") return false;
  if (sig.viewBox !== "0 0 14 14") return false;
  const radii = sig.circleRadii;
  if (!Array.isArray(radii) || radii.length !== 2) return false;
  return radii.every((r) => Math.abs(r - 5.5) < RADIUS_EPSILON);
}
export {
  CHARS_PER_TOKEN,
  CONTEXT_METER_CIRCUMFERENCE,
  clearProfileShare,
  emptyOccupancyLedger,
  estimateInjectedMessageTokens,
  estimateStableSectionTokens,
  haloDashArray,
  isContextMeterAnchor,
  recordProfileShare,
  recordRecallInjection,
  resetForCompaction
};

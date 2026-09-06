const RECALL_TRUNCATION_SUFFIX = "\u2026\uFF08\u5DF2\u622A\u65AD\uFF1B\u53EF\u7528 memory_search \u6216 conversation_search \u67E5\u770B\u8BE6\u60C5\uFF09";
const MIN_TRUNCATED_RECALL_LINE_CHARS = 40;
function normalizeLimit(value) {
  if (value == null || !Number.isFinite(value) || value <= 0) return void 0;
  return Math.floor(value);
}
function truncateRecallLine(line, maxChars) {
  const cps = Array.from(line);
  if (cps.length <= maxChars) return line;
  if (maxChars <= RECALL_TRUNCATION_SUFFIX.length) {
    return cps.slice(0, maxChars).join("");
  }
  return `${cps.slice(0, maxChars - RECALL_TRUNCATION_SUFFIX.length).join("").trimEnd()}${RECALL_TRUNCATION_SUFFIX}`;
}
function applyRecallBudget(lines, limits) {
  const maxCharsPerMemory = normalizeLimit(limits.maxCharsPerMemory);
  const maxTotalRecallChars = normalizeLimit(limits.maxTotalRecallChars);
  if (!maxCharsPerMemory && !maxTotalRecallChars) return lines;
  const budgeted = [];
  let usedChars = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const perBounded = maxCharsPerMemory ? truncateRecallLine(line, maxCharsPerMemory) : line;
    if (!maxTotalRecallChars) {
      budgeted.push(perBounded);
      continue;
    }
    const separatorChars = budgeted.length > 0 ? 1 : 0;
    const remaining = maxTotalRecallChars - usedChars - separatorChars;
    if (remaining <= 0) break;
    if (perBounded.length > remaining) {
      const canFit = remaining >= MIN_TRUNCATED_RECALL_LINE_CHARS;
      if (canFit) budgeted.push(truncateRecallLine(perBounded, remaining));
      break;
    }
    budgeted.push(perBounded);
    usedChars += separatorChars + perBounded.length;
  }
  return budgeted;
}
async function raceRecallTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(void 0), timeoutMs);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const RECALL_EMBED_CAP_MS = 3e3;
export {
  RECALL_EMBED_CAP_MS,
  RECALL_TRUNCATION_SUFFIX,
  applyRecallBudget,
  raceRecallTimeout,
  truncateRecallLine
};

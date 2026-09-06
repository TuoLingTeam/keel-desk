import { tokenize } from "../util/text.js";
const RRF_K = 60;
const DECAY_FLOOR = 0.5;
function applyDecayWeight(hits, halfLifeDays, updatedAtOf, now = Date.now()) {
  if (!(halfLifeDays > 0) || hits.length === 0) return hits;
  const weight = (h) => {
    const t = updatedAtOf(h);
    if (t == null || !Number.isFinite(t)) return DECAY_FLOOR;
    const days = Math.max(0, (now - t) / 864e5);
    return Math.max(DECAY_FLOOR, 0.5 ** (days / halfLifeDays));
  };
  return hits.map((h) => ({ h, weighted: h.score * weight(h) })).sort((a, b) => b.weighted - a.weighted).map((x) => x.h);
}
function rrfMerge(lists, getId, k = RRF_K) {
  const map = /* @__PURE__ */ new Map();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      const id = getId(item);
      const score = 1 / (k + rank + 1);
      const existing = map.get(id);
      if (existing) {
        existing.rrfScore += score;
      } else {
        map.set(id, { item, rrfScore: score });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore).map(({ item, rrfScore }) => ({ ...item, rrfScore }));
}
function bm25RankToScore(rank) {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
const ZH_STOP_WORDS = /* @__PURE__ */ new Set([
  "\u7684",
  "\u4E86",
  "\u5728",
  "\u662F",
  "\u6211",
  "\u6709",
  "\u548C",
  "\u5C31",
  "\u4E0D",
  "\u4EBA",
  "\u90FD",
  "\u4E00",
  "\u4E00\u4E2A",
  "\u4E0A",
  "\u4E5F",
  "\u5F88",
  "\u5230",
  "\u8BF4",
  "\u8981",
  "\u53BB",
  "\u4F60",
  "\u4F1A",
  "\u7740",
  "\u6CA1\u6709",
  "\u770B",
  "\u597D",
  "\u81EA\u5DF1",
  "\u8FD9",
  "\u4ED6",
  "\u5979",
  "\u5B83",
  "\u4EEC",
  "\u90A3",
  "\u5417",
  "\u5427",
  "\u5462",
  "\u554A",
  "\u5440",
  "\u54E6",
  "\u55EF"
]);
function buildFtsQuery(raw) {
  const tokens = [...new Set(tokenize(raw).filter((t) => !ZH_STOP_WORDS.has(t)))];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" OR ");
}
function tokenizeForFts(raw) {
  return tokenize(raw).join(" ");
}
export {
  DECAY_FLOOR,
  RRF_K,
  applyDecayWeight,
  bm25RankToScore,
  buildFtsQuery,
  rrfMerge,
  tokenizeForFts
};

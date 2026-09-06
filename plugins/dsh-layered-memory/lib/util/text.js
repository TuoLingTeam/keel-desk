import { jiebaCut } from "./tokenizer.js";
function blocksToText(blocks) {
  if (!blocks) return "";
  const parts = [];
  for (const b of blocks) {
    if (b.type === "text") parts.push(b.text);
    else if (b.type === "reasoning") parts.push(b.text);
  }
  return parts.join("\n");
}
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/;
const WORD_RE = /[a-zA-Z0-9][a-zA-Z0-9_-]{1,}/g;
const TOKEN_KEEP_RE = /[a-z0-9\u3400-\u9fff\uf900-\ufaff]/;
function cjkBigrams(text) {
  const tokens = [];
  const cjk = text.replace(/[^\u3400-\u9fff\uf900-\ufaff]/g, " ");
  let i = 0;
  while (i < cjk.length) {
    const ch = cjk[i];
    if (CJK_RE.test(ch)) {
      const next = cjk[i + 1];
      if (next && CJK_RE.test(next)) tokens.push(ch + next);
      else tokens.push(ch);
    }
    i += 1;
  }
  return tokens;
}
function tokenize(text) {
  const lower = text.toLowerCase();
  const seen = /* @__PURE__ */ new Set();
  const tokens = [];
  const push = (t) => {
    if (t.length >= 2 && TOKEN_KEEP_RE.test(t) && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    } else if (t.length === 1 && CJK_RE.test(t) && !seen.has(t)) {
      seen.add(t);
      tokens.push(t);
    }
  };
  const words = jiebaCut(lower);
  if (words) for (const w of words) push(w.trim());
  for (const m of lower.matchAll(WORD_RE)) push(m[0]);
  for (const bg of cjkBigrams(lower)) push(bg);
  return tokens;
}
export {
  blocksToText,
  tokenize
};

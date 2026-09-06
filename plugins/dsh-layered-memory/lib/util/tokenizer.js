import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);
let mode;
let cutFn;
function ensure() {
  if (mode !== void 0) return mode;
  try {
    const { Jieba } = require2("@node-rs/jieba");
    const { dict } = require2("@node-rs/jieba/dict");
    const jieba = Jieba.withDict(dict);
    cutFn = (text) => jieba.cut(text, true);
    mode = "jieba";
  } catch {
    cutFn = void 0;
    mode = "bigram";
  }
  return mode;
}
function ensureTokenizer() {
  return ensure();
}
function tokenizerStamp() {
  return ensure() === "jieba" ? "jieba-v1" : "bigram-v1";
}
function describeTokenizer() {
  return ensure() === "jieba" ? "jieba \u8BCD\u7EA7\u5206\u8BCD\uFF08@node-rs/jieba\uFF09+ CJK \u4E8C\u5143\u7EC4\u5E76\u96C6" : "jieba \u52A0\u8F7D\u5931\u8D25\uFF0C\u56DE\u9000 CJK \u4E8C\u5143\u7EC4\u5206\u8BCD\uFF08\u5B50\u8BCD\u53EC\u56DE\u964D\u7EA7\uFF09";
}
function jiebaCut(text) {
  return ensure() === "jieba" ? cutFn(text) : void 0;
}
export {
  describeTokenizer,
  ensureTokenizer,
  jiebaCut,
  tokenizerStamp
};

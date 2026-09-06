const counters = /* @__PURE__ */ new Map();
function bucketOf(layer) {
  let b = counters.get(layer);
  if (!b) {
    b = { calls: 0, failures: 0, inputChars: 0, outputTokens: 0, reasoningTokens: 0 };
    counters.set(layer, b);
  }
  return b;
}
function recordDistillCall(layer, inputChars, outputTokens, reasoningTokens, failed) {
  const b = bucketOf(layer);
  b.calls++;
  if (failed) b.failures++;
  b.inputChars += Math.max(0, Math.round(inputChars));
  b.outputTokens += Math.max(0, Math.round(outputTokens));
  b.reasoningTokens += Math.max(0, Math.round(reasoningTokens));
}
function snapshotDistillUsage() {
  const layers = {};
  for (const [layer, b] of counters) {
    layers[layer] = { ...b };
  }
  return { layers };
}
export {
  recordDistillCall,
  snapshotDistillUsage
};

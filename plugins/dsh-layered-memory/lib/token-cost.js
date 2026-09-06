let db = null;
let retentionDays = 365;
function initTokenCost(d, retention) {
  db = d;
  retentionDays = Math.max(0, Math.round(retention));
}
function resetTokenCost() {
  db = null;
}
function recordCostCall(provider, model, layer, inputChars, outputTokens, reasoningTokens) {
  if (!db) return;
  db.insertCostCall(provider, model, layer, inputChars, outputTokens, reasoningTokens, retentionDays);
}
const WINDOW_DEFS = [
  { range: "day", ms: 24 * 36e5 },
  { range: "week", ms: 7 * 24 * 36e5 },
  { range: "month", ms: 30 * 24 * 36e5 },
  { range: "all", ms: 0 }
];
const TREND_MS = { day: 24 * 36e5, week: 7 * 24 * 36e5, month: 30 * 24 * 36e5 };
const TREND_COUNT = { day: 30, week: 12, month: 12 };
const LAYERS = ["l1", "l2", "l3"];
function localOffsetMs() {
  return -(/* @__PURE__ */ new Date()).getTimezoneOffset() * 6e4;
}
function medianOf(sorted) {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function modelKey(provider, model) {
  return provider + "/" + model;
}
function statOf(rows) {
  const active = rows.filter((r) => r.calls > 0);
  if (active.length === 0) return { avgCalls: 0, avgOutput: 0, medianOutput: 0 };
  const calls = active.reduce((s, r) => s + r.calls, 0);
  const output = active.reduce((s, r) => s + r.outputTokens, 0);
  return {
    avgCalls: calls / active.length,
    avgOutput: output / active.length,
    medianOutput: medianOf(active.map((r) => r.outputTokens).sort((a, b) => a - b))
  };
}
function buildModelMetrics(dayRows, weekRows, monthRows) {
  const keys = /* @__PURE__ */ new Set();
  for (const r of dayRows) keys.add(modelKey(r.provider, r.model));
  for (const r of weekRows) keys.add(modelKey(r.provider, r.model));
  for (const r of monthRows) keys.add(modelKey(r.provider, r.model));
  return Array.from(keys).sort().map((key) => {
    const d = statOf(dayRows.filter((r) => modelKey(r.provider, r.model) === key));
    const w = statOf(weekRows.filter((r) => modelKey(r.provider, r.model) === key));
    const m = statOf(monthRows.filter((r) => modelKey(r.provider, r.model) === key));
    return {
      model: key,
      dayCalls: d.avgCalls,
      weekCalls: w.avgCalls,
      monthCalls: m.avgCalls,
      dayOutput: d.avgOutput,
      dayMedian: d.medianOutput,
      weekOutput: w.avgOutput,
      weekMedian: w.medianOutput,
      monthOutput: m.avgOutput,
      monthMedian: m.medianOutput
    };
  });
}
function buildTrend(rows, granularity, now, count) {
  const bucketMs = TREND_MS[granularity];
  const offset = localOffsetMs();
  const cur = Math.floor((now + offset) / bucketMs);
  const buckets = [];
  for (let i = count - 1; i >= 0; i--) {
    const b = cur - i;
    buckets.push({ ts: b * bucketMs - offset, total: 0, byModel: {} });
  }
  for (const r of rows) {
    const idx = count - 1 - (cur - r.bucket);
    if (idx < 0 || idx >= count) continue;
    const tb = buckets[idx];
    tb.total += r.outputTokens;
    const key = modelKey(r.provider, r.model);
    tb.byModel[key] = (tb.byModel[key] ?? 0) + r.outputTokens;
  }
  return buckets;
}
function snapshotTokenCost(granularity, rangeDays) {
  const now = Date.now();
  const emptyWindow = (range, ms) => ({
    range,
    since: ms === 0 ? 0 : now - ms,
    calls: 0,
    inputChars: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    avgOutputTokens: 0,
    medianOutputTokens: 0
  });
  if (!db) {
    return {
      windows: WINDOW_DEFS.map((w) => emptyWindow(w.range, w.ms)),
      byModel: [],
      byLayer: [],
      byLayerStats: [],
      trend: { granularity, byLayer: { l1: [], l2: [], l3: [] } }
    };
  }
  const d = db;
  const windows = [];
  let byModel = [];
  for (const w of WINDOW_DEFS) {
    const since = w.ms === 0 ? 0 : now - w.ms;
    const agg = d.aggregateCost(since);
    windows.push({ range: w.range, since, ...agg.total });
    if (w.range === "all") byModel = agg.byModel;
  }
  const layerByWindow = WINDOW_DEFS.map((w) => {
    const since = w.ms === 0 ? 0 : now - w.ms;
    return { range: w.range, rows: d.aggregateCostByLayer(since) };
  });
  const byLayer = LAYERS.map((layer) => ({
    layer,
    windows: layerByWindow.map(({ range, rows }) => {
      const row = rows.find((r) => r.layer === layer);
      return {
        range,
        calls: row?.calls ?? 0,
        inputChars: row?.inputChars ?? 0,
        outputTokens: row?.outputTokens ?? 0,
        reasoningTokens: row?.reasoningTokens ?? 0,
        avgOutputTokens: row?.avgOutputTokens ?? 0,
        medianOutputTokens: row?.medianOutputTokens ?? 0
      };
    })
  }));
  const offset = localOffsetMs();
  const byLayerStats = [];
  const trendByLayer = { l1: [], l2: [], l3: [] };
  const trendGranularity = rangeDays > 0 ? "day" : granularity;
  const trendSince = rangeDays > 0 ? now - rangeDays * 24 * 36e5 : 0;
  const trendCount = rangeDays > 0 ? rangeDays : TREND_COUNT[granularity];
  for (const layer of LAYERS) {
    const dayRows = d.aggregateByBucket(TREND_MS.day, offset, 0, layer);
    const weekRows = d.aggregateByBucket(TREND_MS.week, offset, 0, layer);
    const monthRows = d.aggregateByBucket(TREND_MS.month, offset, 0, layer);
    byLayerStats.push({ layer, models: buildModelMetrics(dayRows, weekRows, monthRows) });
    trendByLayer[layer] = buildTrend(d.aggregateByBucket(TREND_MS[trendGranularity], offset, trendSince, layer), trendGranularity, now, trendCount);
  }
  return { windows, byModel, byLayer, byLayerStats, trend: { granularity: trendGranularity, byLayer: trendByLayer } };
}
export {
  initTokenCost,
  recordCostCall,
  resetTokenCost,
  snapshotTokenCost
};

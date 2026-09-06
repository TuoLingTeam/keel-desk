import { randomBytes } from "node:crypto";
import { callLLM, parseJsonLogged, resolveLayerTokens } from "../llm.js";
import { formatExtractionPrompt, getExtractMemoriesSystemPrompt } from "../prompts/l1-extraction.js";
import { formatBatchConflictPrompt, getConflictDetectionSystemPrompt } from "../prompts/l1-dedup.js";
import { familyForType, resolveRecordFamily } from "../types.js";
function newId(prefix) {
  return `${prefix}_${Date.now()}_${randomBytes(3).toString("hex")}`;
}
function chunkByCharBudget(messages, budgetChars) {
  if (messages.length === 0) return [];
  const chunks = [];
  let cur = [];
  let curChars = 0;
  for (const m of messages) {
    const len = m.content.length + 64;
    if (cur.length > 0 && curChars + len > budgetChars) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(m);
    curChars += len;
  }
  if (cur.length > 0) chunks.push(cur);
  return chunks;
}
async function runExtraction(ctx, cfg, store, states, pending, background, logger, mode) {
  if (!cfg.extract.enabled) return { stored: 0, skipped: true, sceneName: chainHead(states, mode), newRecords: [] };
  const forcedFamily = mode === "auto" ? void 0 : mode;
  const chainState = mode === "auto" ? activeState(states) : states[mode];
  const backgroundMsgs = background.slice(-cfg.extract.backgroundMessages);
  const perChunk = Math.max(2e4, cfg.llm.maxInputChars - 42e3);
  const chunks = chunkByCharBudget(pending, perChunk);
  if (chunks.length > 1) {
    logger.info(
      `[memory] L1 \u8F93\u5165\u8D85\u9884\u7B97\uFF08${pending.length} \u6761\u6D88\u606F\uFF09\uFF0C\u5206 ${chunks.length} \u5757\u62BD\u53D6\uFF08\u6BCF\u5757 \u2264${perChunk} \u5B57\u7B26\uFF09`
    );
  }
  const extracted = [];
  let lastScene = chainState.lastSceneName;
  let sceneCount = 0;
  for (const chunk of chunks) {
    const userPrompt = formatExtractionPrompt({
      newMessages: chunk,
      backgroundMessages: backgroundMsgs,
      previousSceneName: lastScene || "\u65E0"
    });
    const raw = await callLLM(ctx, cfg, {
      system: getExtractMemoriesSystemPrompt(mode),
      user: userPrompt,
      maxTokens: resolveLayerTokens(cfg, "extract"),
      layer: "l1-extract",
      logger
    });
    const scenes = parseJsonLogged(raw, "L1 \u62BD\u53D6", logger);
    if (!Array.isArray(scenes)) throw new Error("L1 \u62BD\u53D6\u8F93\u51FA\u4E0D\u662F JSON \u6570\u7EC4");
    for (const scene of scenes) {
      if (!scene || typeof scene.scene_name !== "string") continue;
      lastScene = scene.scene_name;
      sceneCount++;
      for (const m of scene.memories ?? []) {
        if (!m || typeof m.content !== "string" || !m.content.trim()) continue;
        extracted.push({
          ...m,
          record_id: newId("mem"),
          scene_name: scene.scene_name,
          family: resolveRecordFamily(forcedFamily, m.family, m.type ?? "")
        });
      }
    }
  }
  if (extracted.length === 0) {
    logger.info(`[memory] L1 \u62BD\u53D6\u5B8C\u6210\uFF1A\u65E0\u53EF\u63D0\u53D6\u8BB0\u5FC6\uFF08mode=${mode}\uFF0C${pending.length} \u6761\u6D88\u606F\uFF0C${sceneCount} \u4E2A\u60C5\u5883\uFF09`);
    markExtracted(states, mode, lastScene);
    return { stored: 0, skipped: false, sceneName: lastScene, newRecords: [] };
  }
  const matches = await Promise.all(
    extracted.map(async (m) => ({
      newMemory: m,
      candidates: await store.searchCandidates(m.content, cfg.extract.candidatePool, m.family)
    }))
  );
  const dedupPrompt = formatBatchConflictPrompt(matches);
  const dedupRaw = await callLLM(ctx, cfg, {
    system: getConflictDetectionSystemPrompt(mode),
    user: dedupPrompt,
    maxTokens: resolveLayerTokens(cfg, "dedup"),
    layer: "l1-dedup",
    logger
  });
  const decisions = parseJsonLogged(dedupRaw, "L1 \u53BB\u91CD\u5224\u5B9A", logger);
  const byRecord = /* @__PURE__ */ new Map();
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (d && typeof d.record_id === "string") byRecord.set(d.record_id, d);
  }
  const actionCount = {};
  for (const m of extracted) {
    const action = byRecord.get(m.record_id)?.action ?? "skip(\u672A\u8FD4\u56DE)";
    actionCount[action] = (actionCount[action] ?? 0) + 1;
  }
  const candidateTotal = matches.reduce((n, m) => n + m.candidates.length, 0);
  logger.info(
    `[memory] L1 \u53BB\u91CD\u5224\u5B9A\uFF1A${extracted.length} \u6761\u5019\u9009\u8BB0\u5FC6\u53EC\u56DE ${candidateTotal} \u6761\u5DF2\u6709\u8BB0\u5F55\uFF0C\u51B3\u7B56 ${Object.entries(actionCount).map(([k, v]) => `${k}=${v}`).join(" ")}`
  );
  const relatedIds = /* @__PURE__ */ new Set();
  for (const d of byRecord.values()) {
    for (const id of d.target_ids ?? []) relatedIds.add(id);
  }
  for (const m of matches) {
    for (const c of m.candidates) relatedIds.add(c.id);
  }
  const byId = new Map(store.getByIds([...relatedIds]).map((r) => [r.id, r]));
  const deletedIds = /* @__PURE__ */ new Set();
  const added = [];
  const now = Date.now();
  for (const m of extracted) {
    const decision = byRecord.get(m.record_id);
    if (!decision || decision.action === "skip") continue;
    const action = decision.action;
    const ts = m.metadata?.activity_start_time ? Date.parse(String(m.metadata.activity_start_time)) : now;
    if (action === "store") {
      added.push({
        id: m.record_id,
        content: m.content,
        type: m.type,
        priority: Number(m.priority) || 60,
        scene_name: m.scene_name,
        timestamps: [Number.isNaN(ts) ? now : ts],
        createdAt: now,
        updatedAt: now,
        version: 0,
        source_message_ids: m.source_message_ids ?? [],
        metadata: m.metadata ?? {},
        family: m.family
      });
      continue;
    }
    const targets = (decision.target_ids ?? []).filter((id) => byId.has(id));
    for (const id of targets) deletedIds.add(id);
    const targetVersion = targets.reduce((max, id) => Math.max(max, byId.get(id)?.version ?? 0), 0);
    const mergedTs = (decision.merged_timestamps ?? []).map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t)).concat([now]);
    added.push({
      id: m.record_id,
      content: decision.merged_content && decision.merged_content.trim() ? decision.merged_content : m.content,
      type: decision.merged_type || m.type,
      priority: Number(decision.merged_priority) || Number(m.priority) || 60,
      scene_name: m.scene_name,
      timestamps: Array.from(new Set(mergedTs)).sort((a, b) => a - b),
      createdAt: now,
      updatedAt: now,
      version: targetVersion + 1,
      source_message_ids: m.source_message_ids ?? [],
      metadata: m.metadata ?? {},
      family: m.family
    });
  }
  await store.appendNew(added);
  if (deletedIds.size > 0) await store.deleteBatch([...deletedIds]);
  const addedByFamily = { chat: 0, work: 0 };
  for (const r of added) addedByFamily[r.family ?? familyForType(r.type)]++;
  for (const f of ["chat", "work"]) {
    if (addedByFamily[f] === 0) continue;
    states[f].totalExtracted += addedByFamily[f];
    states[f].newMemoriesSinceL2 += addedByFamily[f];
    states[f].memoriesSinceL3 += addedByFamily[f];
  }
  markExtracted(states, mode, lastScene);
  logger.info(
    `[memory] L1 \u62BD\u53D6\u5B8C\u6210\uFF08mode=${mode}\uFF09\uFF1A\u6D88\u606F ${pending.length} \u6761\uFF0C\u62BD\u53D6 ${extracted.length} \u6761\uFF0C\u53BB\u91CD\u540E\u65B0\u589E ${added.length} \u6761\uFF08\u66FF\u6362 ${deletedIds.size} \u6761\uFF0Cchat=${addedByFamily.chat}/work=${addedByFamily.work}\uFF09\uFF0C\u7D2F\u8BA1 chat=${states.chat.totalExtracted}/work=${states.work.totalExtracted}`
  );
  return { stored: added.length, skipped: false, sceneName: lastScene, newRecords: added };
}
function activeState(states) {
  return states.chat.lastExtractAt >= states.work.lastExtractAt ? states.chat : states.work;
}
function chainHead(states, mode) {
  return (mode === "auto" ? activeState(states) : states[mode]).lastSceneName;
}
function markExtracted(states, mode, lastScene) {
  const now = Date.now();
  if (mode === "auto") {
    states.chat.lastExtractAt = now;
    states.work.lastExtractAt = now;
    activeState(states).lastSceneName = lastScene;
  } else {
    states[mode].lastExtractAt = now;
    states[mode].lastSceneName = lastScene;
  }
}
export {
  chunkByCharBudget,
  runExtraction
};

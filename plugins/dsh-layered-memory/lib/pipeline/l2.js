import { callLLM, parseJsonLogged, resolveLayerTokens } from "../llm.js";
import { buildScenePrompt, formatSceneSummaries } from "../prompts/scene.js";
import { Bm25Index } from "../store/bm25.js";
const REQUEST_RE = /\[PERSONA_UPDATE_REQUEST\]\s*reason:\s*([\s\S]*?)\[\/PERSONA_UPDATE_REQUEST\]/;
async function runSceneConsolidation(ctx, cfg, scenes, newMemories, logger, family) {
  if (!cfg.l2.enabled || newMemories.length === 0) {
    return { changed: 0 };
  }
  const summaries = await scenes.list();
  const memoriesJson = JSON.stringify(
    newMemories.map((m) => ({
      record_id: m.id,
      content: m.content,
      type: m.type,
      priority: m.priority,
      scene_name: m.scene_name,
      timestamps: m.timestamps.map((t) => new Date(t).toISOString())
    })),
    null,
    2
  );
  const sceneSummaries = formatSceneSummaries(summaries);
  const sceneContents = await pickSceneContents(scenes, summaries, newMemories, cfg.l2.sceneContextLimit);
  const { systemPrompt, userPrompt } = buildScenePrompt({
    memoriesJson,
    sceneSummaries,
    sceneContents,
    currentTimestamp: (/* @__PURE__ */ new Date()).toISOString(),
    existingSceneFiles: summaries.map((s) => s.path),
    maxScenes: cfg.l2.maxScenes,
    family
  });
  const raw = await callLLM(ctx, cfg, {
    system: systemPrompt,
    user: userPrompt,
    maxTokens: resolveLayerTokens(cfg, "l2"),
    layer: "l2",
    logger
  });
  const reqMatch = REQUEST_RE.exec(raw);
  const personaRequestedReason = reqMatch?.[1]?.trim() || void 0;
  const opsRaw = reqMatch ? raw.replace(REQUEST_RE, "") : raw;
  const ops = parseJsonLogged(opsRaw, "L2 \u573A\u666F\u64CD\u4F5C", logger);
  if (!Array.isArray(ops)) throw new Error("L2 \u8F93\u51FA\u4E0D\u662F\u64CD\u4F5C\u6570\u7EC4");
  let changed = 0;
  for (const op of ops) {
    if (!op || typeof op.path !== "string") continue;
    try {
      if (op.op === "write" && typeof op.content === "string") {
        await scenes.write(op.path, op.content);
        changed++;
        logger.debug?.(`[memory] L2 \u5199\u5165\u573A\u666F ${op.path} (${op.content.length} \u5B57\u7B26)`);
      } else if (op.op === "delete") {
        await scenes.write(op.path, "[DELETED]");
        changed++;
        logger.debug?.(`[memory] L2 \u5220\u9664\u573A\u666F ${op.path}`);
      }
    } catch (err) {
      logger.warn(`[memory] L2 \u64CD\u4F5C\u5931\u8D25 ${op.path}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  logger.info(
    `[memory] L2 \u573A\u666F\u6574\u5408\u5B8C\u6210\uFF08family=${family}\uFF09\uFF1A${newMemories.length} \u6761\u65B0\u8BB0\u5FC6 \u2192 ${changed} \u4E2A\u6587\u4EF6\u64CD\u4F5C\uFF08\u573A\u666F\u603B\u6570 ${summaries.length}\uFF09` + (personaRequestedReason ? `\uFF0C\u8BF7\u6C42 L3 \u66F4\u65B0\uFF1A${personaRequestedReason}` : "")
  );
  return { changed, personaRequestedReason };
}
async function pickSceneContents(scenes, summaries, newMemories, limit) {
  if (summaries.length === 0 || limit <= 0) return "";
  const index = new Bm25Index();
  index.rebuild(summaries.map((s) => ({ id: s.path, text: `${s.summary} ${s.path}` })));
  const query = newMemories.map((m) => m.content).join(" ");
  const hits = index.search(query, limit);
  const parts = [];
  for (const h of hits) {
    const content = await scenes.read(h.id);
    if (content) parts.push(`### \u6587\u4EF6: ${h.id}
\`\`\`markdown
${content}
\`\`\``);
  }
  return parts.join("\n\n");
}
export {
  runSceneConsolidation
};

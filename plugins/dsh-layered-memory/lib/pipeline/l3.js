import { callLLM, resolveLayerTokens } from "../llm.js";
import { buildPersonaPrompt } from "../prompts/persona.js";
async function runPersona(ctx, cfg, scenes, persona, state, logger, family) {
  if (!cfg.l3.enabled) return { generated: false, reason: "l3 disabled" };
  const existingPersona = await persona.read();
  let reason = "";
  if (state.personaRequestedReason) {
    reason = `\u4E3B\u52A8\u8BF7\u6C42: ${state.personaRequestedReason}`;
  } else if (!state.hasPersona || !existingPersona) {
    reason = "\u51B7\u542F\u52A8/\u6062\u590D\uFF1A\u9996\u6B21\u751F\u6210\u6216\u753B\u50CF\u7F3A\u5931";
  } else if (state.memoriesSinceL3 >= cfg.l3.interval) {
    reason = `\u8FBE\u5230\u9608\u503C: ${state.memoriesSinceL3} >= ${cfg.l3.interval}`;
  } else {
    logger.debug?.(`[memory] L3 \u672A\u89E6\u53D1\uFF08\u81EA\u4E0A\u6B21\u84B8\u998F\u4EE5\u6765 ${state.memoriesSinceL3}/${cfg.l3.interval} \u6761\u65B0\u8BB0\u5FC6\uFF09`);
    return { generated: false, reason: "no trigger" };
  }
  const all = await scenes.list();
  const changed = state.hasPersona ? all.filter((s) => {
    const t = Date.parse(s.updated);
    return !Number.isNaN(t) && t > state.lastL3At;
  }) : all;
  if (changed.length === 0 && state.hasPersona) {
    logger.debug?.("[memory] L3 \u89E6\u53D1\u4F46\u65E0\u53D8\u5316\u573A\u666F\uFF0C\u8DF3\u8FC7");
    return { generated: false, reason: "no changed scenes" };
  }
  const changedContents = [];
  for (const s of changed) {
    const content = await scenes.read(s.path);
    if (content) changedContents.push(`### \u573A\u666F: ${s.path}
\`\`\`markdown
${content}
\`\`\``);
  }
  const { systemPrompt, userPrompt } = buildPersonaPrompt({
    mode: existingPersona ? "incremental" : "first",
    family,
    currentTime: (/* @__PURE__ */ new Date()).toISOString(),
    totalProcessed: state.totalExtracted,
    sceneCount: all.length,
    changedSceneCount: changed.length,
    changedScenesContent: changedContents.join("\n\n"),
    existingPersona,
    triggerInfo: reason
  });
  const raw = await callLLM(ctx, cfg, {
    system: systemPrompt,
    user: userPrompt,
    maxTokens: resolveLayerTokens(cfg, "l3"),
    layer: "l3",
    logger
  });
  const body = unwrapFence(raw);
  if (!body) {
    logger.error(`[memory] L3 \u8F93\u51FA\u4E3A\u7A7A\uFF0C\u539F\u59CB\u8F93\u51FA\u524D 400 \u5B57\u7B26: ${raw.slice(0, 400)}`);
    throw new Error("L3 \u8F93\u51FA\u4E3A\u7A7A");
  }
  await persona.write(body);
  state.hasPersona = true;
  state.lastL3At = Date.now();
  state.memoriesSinceL3 = 0;
  state.personaRequestedReason = void 0;
  logger.info(
    `[memory] L3 \u753B\u50CF\u84B8\u998F\u5B8C\u6210\uFF08family=${family}\uFF0C${reason}\uFF09\uFF1A${body.length} \u5B57\u7B26\uFF0C\u573A\u666F ${changed.length}/${all.length} \u4E2A`
  );
  return { generated: true, reason };
}
function unwrapFence(text) {
  let s = text.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  return s;
}
export {
  runPersona
};

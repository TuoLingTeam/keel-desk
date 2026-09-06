import { createUserMessage, ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { errDetail } from "./util/filelog.js";
import { recordDistillCall } from "./llm-usage.js";
import { recordCostCall } from "./token-cost.js";
const LAYER_MAX_TOKENS_EXTRACT = 16e3;
const LAYER_MAX_TOKENS_DEDUP = 8e3;
const LAYER_MAX_TOKENS_L2 = 32e3;
const LAYER_MAX_TOKENS_L3 = 16e3;
const LAYER_DEFAULT_BUDGETS = {
  extract: LAYER_MAX_TOKENS_EXTRACT,
  dedup: LAYER_MAX_TOKENS_DEDUP,
  l2: LAYER_MAX_TOKENS_L2,
  l3: LAYER_MAX_TOKENS_L3
};
function resolveLayerTokens(cfg, layer) {
  const override = cfg.llm.budgets?.[layer];
  const key = layer === "l2" ? "l2" : layer === "l3" ? "l3" : "l1";
  return layerMaxTokens(override && override > 0 ? override : LAYER_DEFAULT_BUDGETS[layer], layerEffortTrigger(cfg, key));
}
const HIGH_EFFORT_TIERS = ["high", "xhigh", "max"];
function layerMaxTokens(base, reasoningEffort) {
  return HIGH_EFFORT_TIERS.includes(reasoningEffort) ? base * 4 : base;
}
async function resolveModelRoute(ctx, cfg) {
  if (cfg.llm.provider && cfg.llm.model) {
    return { provider: cfg.llm.provider, model: cfg.llm.model };
  }
  const defaults = ctx.get("agentDefaultModel");
  const sel = defaults?.currentSelection?.();
  if (sel?.provider && sel?.model) {
    return { provider: cfg.llm.provider || sel.provider, model: cfg.llm.model || sel.model };
  }
  throw new Error(
    "\u65E0\u6CD5\u89E3\u6790\u84B8\u998F\u6A21\u578B\u8DEF\u7531\uFF1A\u8BF7\u5728\u63D2\u4EF6 config \u4E2D\u914D\u7F6E llm.provider / llm.model\uFF0C\u6216\u786E\u4FDD\u5B58\u5728\u9ED8\u8BA4\u6A21\u578B\u9009\u62E9"
  );
}
function buildRouteChain(primary, fallbacks, globalEffort) {
  const routes = [{ ...primary, effort: primary.effort || globalEffort }];
  const seen = /* @__PURE__ */ new Set([`${primary.provider}::${primary.model}`]);
  for (const f of fallbacks ?? []) {
    if (!f.provider || !f.model) continue;
    const key = `${f.provider}::${f.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ provider: f.provider, model: f.model, effort: f.reasoningEffort || globalEffort });
  }
  return routes;
}
function layerKeyFor(layer) {
  return layer === "l2" ? "l2" : layer === "l3" ? "l3" : "l1";
}
function layerChainOf(cfg, key) {
  const rt = cfg.llm.layerChainsRuntime?.[key];
  if (rt?.length && rt[0].provider && rt[0].model) return rt;
  const st = cfg.llm.layerRoutes?.[key];
  if (st?.length && st[0].provider && st[0].model) return st;
  return void 0;
}
function layerEffortTrigger(cfg, key) {
  const chain = layerChainOf(cfg, key);
  return chain ? chain[0].reasoningEffort || cfg.llm.primaryEffort || cfg.llm.reasoningEffort : cfg.llm.primaryEffort || cfg.llm.reasoningEffort;
}
async function resolveLayerRoutes(ctx, cfg, layer) {
  const key = layer ? layerKeyFor(layer) : void 0;
  const lr = key ? layerChainOrNull(cfg, key) : null;
  if (lr) return lr;
  const primary = await resolveModelRoute(ctx, cfg);
  return buildRouteChain(
    // 主路由显式档位来自运行时统一链（primaryEffort，'' = 跟随全局静态）
    { provider: primary.provider, model: primary.model, effort: cfg.llm.primaryEffort || "" },
    cfg.llm.fallbacks,
    cfg.llm.reasoningEffort
  );
}
function layerChainOrNull(cfg, key) {
  const chain = layerChainOf(cfg, key);
  if (!chain) return null;
  return buildRouteChain(
    { provider: chain[0].provider, model: chain[0].model, effort: chain[0].reasoningEffort || "" },
    chain.slice(1),
    cfg.llm.reasoningEffort
  );
}
const routeDeadWarned = /* @__PURE__ */ new Set();
function warnRouteDeadOnce(route, logger) {
  if (!logger) return;
  const key = `${route.provider}::${route.model}`;
  if (routeDeadWarned.has(key)) return;
  routeDeadWarned.add(key);
  logger.warn(
    `[memory] \u84B8\u998F\u8DEF\u7531 ${route.provider}/${route.model} \u5931\u8D25\uFF08\u6BCF\u8DEF\u7531\u4EC5\u544A\u8B66\u4E00\u6B21\uFF1B\u9010\u6B21\u5931\u8D25\u539F\u56E0\u4E0E\u964D\u7EA7\u53BB\u5411\u89C1\u540E\u7EED\u65E5\u5FD7\uFF09`
  );
}
const effortCache = /* @__PURE__ */ new Map();
function invalidateEffortCache() {
  effortCache.clear();
  contextWindowCache.clear();
  effortWarned.clear();
  routeDeadWarned.clear();
}
async function resolveModelEfforts(ctx, provider, model) {
  const key = `${provider}::${model}`;
  const hit = effortCache.get(key);
  if (hit) return hit;
  try {
    if (typeof ctx.llm?.resolveModelInfo !== "function") return null;
    const info = await ctx.llm.resolveModelInfo(provider, model);
    const efforts = (info.reasoning?.efforts ?? []).map((e) => String(e.id)).filter((id) => id.length > 0);
    const cap = {
      efforts,
      ...info.reasoning?.defaultEffort ? { defaultEffort: String(info.reasoning.defaultEffort) } : {}
    };
    effortCache.set(key, cap);
    return cap;
  } catch {
    return null;
  }
}
const contextWindowCache = /* @__PURE__ */ new Map();
async function resolveModelContextWindow(ctx, provider, model) {
  const key = `${provider}::${model}`;
  if (contextWindowCache.has(key)) return contextWindowCache.get(key) ?? null;
  try {
    if (typeof ctx.llm?.resolveModelInfo !== "function") return null;
    const info = await ctx.llm.resolveModelInfo(provider, model);
    const win = info.context?.contextWindow;
    const val = typeof win === "number" && Number.isFinite(win) && win > 0 ? Math.floor(win) : null;
    contextWindowCache.set(key, val);
    return val;
  } catch {
    return null;
  }
}
function decideSendableEffort(cap, cfgEffort) {
  if (!cap) return { effort: cfgEffort, reason: "no-capability" };
  if (cfgEffort) {
    if (cap.efforts.includes(cfgEffort)) return { effort: cfgEffort, reason: "supported" };
    if (cfgEffort === "off" && cap.efforts.includes("none")) return { effort: "none", reason: "alias-none" };
    if (cap.efforts.length === 0) return { effort: "", reason: "no-efforts" };
    return { effort: "", reason: "unsupported" };
  }
  if (cap.defaultEffort && cap.efforts.includes(cap.defaultEffort)) {
    return { effort: cap.defaultEffort, reason: "auto-default" };
  }
  if (cap.efforts.includes("high")) return { effort: "high", reason: "auto-high" };
  return { effort: "", reason: "no-efforts" };
}
const effortWarned = /* @__PURE__ */ new Set();
async function planDistillEffort(ctx, provider, model, cfgEffort, logger) {
  const cap = await resolveModelEfforts(ctx, provider, model);
  const d = decideSendableEffort(cap, cfgEffort);
  if ((d.reason === "unsupported" || d.reason === "no-efforts") && logger) {
    const key = `${provider}::${model}::${cfgEffort}::${d.reason}`;
    if (!effortWarned.has(key)) {
      effortWarned.add(key);
      logger.warn(
        `[memory] \u84B8\u998F\u601D\u8003\u6863\u4F4D ${cfgEffort || "(auto)"} \u4E0D\u88AB ${provider}/${model} \u652F\u6301` + (d.reason === "no-efforts" ? "\uFF08\u6A21\u578B\u672A\u58F0\u660E\u601D\u8003\u6863\u4F4D\uFF09" : `\uFF08\u652F\u6301: ${cap?.efforts.join("/")}\uFF09`) + "\uFF0C\u672C\u6B21\u8C03\u7528\u4E0D\u4F20\u6863\u4F4D\uFF08\u8DDF\u968F\u6A21\u578B\u9ED8\u8BA4\uFF09"
      );
    }
  }
  return d;
}
async function callLLM(ctx, cfg, opts) {
  const routes = await resolveLayerRoutes(ctx, cfg, opts.layer);
  let lastErr;
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    try {
      return await callRoute(ctx, cfg, opts, route);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastErr = err;
      warnRouteDeadOnce(route, opts.logger);
      const next = routes[i + 1];
      if (next) {
        opts.logger?.info(
          `[memory] \u84B8\u998F\u8DEF\u7531\u964D\u7EA7 ${route.provider}/${route.model} \u2192 ${next.provider}/${next.model}\uFF08${errDetail(err)}\uFF09`
        );
      }
    }
  }
  throw lastErr;
}
async function callRoute(ctx, cfg, opts, route) {
  const { provider, model } = route;
  const signal = opts.signal ?? AbortSignal.timeout(cfg.llm.timeoutMs);
  const effort = await planDistillEffort(ctx, provider, model, route.effort, opts.logger);
  const user = opts.user.length > cfg.llm.maxInputChars ? `${opts.user.slice(0, cfg.llm.maxInputChars)}

[\u8F93\u5165\u8D85\u51FA ${cfg.llm.maxInputChars} \u5B57\u7B26\u9884\u7B97\uFF0C\u5DF2\u622A\u65AD]` : opts.user;
  const baseMaxTokens = opts.maxTokens ?? cfg.llm.maxTokens;
  const highTiers = HIGH_EFFORT_TIERS;
  const triggerEffort = opts.layer ? layerEffortTrigger(cfg, layerKeyFor(opts.layer)) : cfg.llm.primaryEffort || cfg.llm.reasoningEffort;
  const maxTokens = highTiers.includes(effort.effort) && !highTiers.includes(triggerEffort) ? layerMaxTokens(baseMaxTokens, "high") : baseMaxTokens;
  const stream = ctx.llm.stream({
    provider,
    model,
    system: opts.system,
    messages: [createUserMessage({ content: [{ type: "text", text: user }], source: { kind: "user" } })],
    temperature: opts.temperature ?? cfg.llm.temperature,
    maxTokens,
    // 档位只在能力决策给出非空值时传；空串不传（跟随模型默认）
    ...effort.effort ? { reasoningEffort: ReasoningEffortId(effort.effort) } : {},
    signal
  });
  const startedAt = Date.now();
  let deltaText = "";
  let blockText = "";
  let finishKind = "";
  let outputTokens = 0;
  let reasoningTokens = 0;
  let deltaBlocks = 0;
  let reasoningChars = 0;
  let reasoningHead = "";
  const blockEndTypes = /* @__PURE__ */ new Map();
  try {
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") {
        deltaBlocks++;
        deltaText += chunk.text;
      } else if (chunk.type === "reasoning-delta") {
        reasoningChars += chunk.text.length;
        if (reasoningHead.length < 300) reasoningHead += chunk.text.slice(0, 300 - reasoningHead.length);
      } else if (chunk.type === "block-end") {
        blockEndTypes.set(chunk.block.type, (blockEndTypes.get(chunk.block.type) ?? 0) + 1);
        if (chunk.block.type === "text") blockText += chunk.block.text;
      } else if (chunk.type === "usage") {
        outputTokens = chunk.usage.outputTokens;
        reasoningTokens = chunk.usage.reasoningTokens ?? 0;
      } else if (chunk.type === "finish") {
        finishKind = chunk.reason.kind;
        if (chunk.reason.kind === "error" || chunk.reason.kind === "aborted") {
          const failure = chunk.reason.failure;
          throw new Error(`llm ${chunk.reason.kind}: ${failure?.message ?? "unknown failure"}`);
        }
      }
    }
  } catch (err) {
    if (opts.layer) recordDistillCall(opts.layer, user.length, outputTokens, reasoningTokens, true);
    if (opts.layer) recordCostCall(provider, model, opts.layer, user.length, outputTokens, reasoningTokens);
    opts.logger?.warn(
      `[memory] LLM \u8C03\u7528\u5931\u8D25 ${provider}/${model}\uFF08${((Date.now() - startedAt) / 1e3).toFixed(1)}s\uFF09: ${errDetail(err)}`
    );
    throw err;
  }
  const out = (blockText || deltaText).trim();
  if (out.length === 0) {
    if (opts.layer) recordDistillCall(opts.layer, user.length, outputTokens, reasoningTokens, true);
    if (opts.layer) recordCostCall(provider, model, opts.layer, user.length, outputTokens, reasoningTokens);
    opts.logger?.warn(
      `[memory] LLM \u7A7A\u8F93\u51FA ${provider}/${model}\uFF08${((Date.now() - startedAt) / 1e3).toFixed(1)}s\uFF0Cfinish=${finishKind || "\u65E0 finish \u5757"}\uFF0C\u8F93\u51FA tokens=${outputTokens}${reasoningTokens > 0 ? `/reasoning ${reasoningTokens}` : ""}\uFF0Ctext-delta ${deltaBlocks} \u5757/${deltaText.length} \u5B57\u7B26\uFF0Creasoning ${reasoningChars} \u5B57\u7B26\uFF0Cblock-end: ${[...blockEndTypes.entries()].map(([t, n]) => `${t}\xD7${n}`).join(", ") || "\u65E0"}\uFF09` + (reasoningHead ? `\uFF0Creasoning \u6458\u5F55: ${reasoningHead}\u2026` : "")
    );
    throw new Error(`llm empty output: ${provider}/${model} \u6D41\u6B63\u5E38\u7ED3\u675F\u4F46\u8F93\u51FA 0 \u5B57\u7B26`);
  }
  if (opts.layer) recordDistillCall(opts.layer, user.length, outputTokens, reasoningTokens, false);
  if (opts.layer) recordCostCall(provider, model, opts.layer, user.length, outputTokens, reasoningTokens);
  opts.logger?.info(
    `[memory] LLM \u8C03\u7528 ${provider}/${model}\uFF1A\u8F93\u5165 ${user.length} \u5B57\u7B26 \u2192 \u8F93\u51FA ${out.length} \u5B57\u7B26\uFF08${((Date.now() - startedAt) / 1e3).toFixed(1)}s\uFF0Cfinish=${finishKind || "\u65E0"}\uFF09`
  );
  return out;
}
function parseJsonLogged(raw, what, logger) {
  try {
    return parseJson(raw);
  } catch (err) {
    logger?.error(
      `[memory] ${what} JSON \u89E3\u6790\u5931\u8D25\uFF08${errDetail(err)}\uFF09\uFF0C\u539F\u59CB\u8F93\u51FA\u524D 400 \u5B57\u7B26: ${raw.slice(0, 400)}`
    );
    throw new Error(`${what} \u8F93\u51FA\u65E0\u6CD5\u89E3\u6790\u4E3A JSON`);
  }
}
function parseJson(raw) {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  }
  const start = s.indexOf("[");
  const brace = s.indexOf("{");
  let begin = -1;
  if (start === -1) begin = brace;
  else if (brace === -1) begin = start;
  else begin = Math.min(start, brace);
  if (begin > 0) s = s.slice(begin);
  const end = s.lastIndexOf("]") > s.lastIndexOf("}") ? s.lastIndexOf("]") + 1 : s.lastIndexOf("}") + 1;
  if (end > 0) s = s.slice(0, end);
  return JSON.parse(s);
}
export {
  HIGH_EFFORT_TIERS,
  LAYER_DEFAULT_BUDGETS,
  LAYER_MAX_TOKENS_DEDUP,
  LAYER_MAX_TOKENS_EXTRACT,
  LAYER_MAX_TOKENS_L2,
  LAYER_MAX_TOKENS_L3,
  buildRouteChain,
  callLLM,
  decideSendableEffort,
  invalidateEffortCache,
  layerChainOrNull,
  layerEffortTrigger,
  layerKeyFor,
  layerMaxTokens,
  parseJson,
  parseJsonLogged,
  planDistillEffort,
  resolveLayerRoutes,
  resolveLayerTokens,
  resolveModelContextWindow,
  resolveModelEfforts,
  resolveModelRoute
};

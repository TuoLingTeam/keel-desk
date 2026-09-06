import Schema from "@deepseek-ai/schemastery";
import { EFFORT_CHOICES } from "./config.js";
const DISTILL_CHAIN_MAX = 8;
function projectDistillChain(s) {
  if (s?.distillChain?.length) return s.distillChain;
  if (s?.distillProvider && s?.distillModel) {
    return [{ provider: s.distillProvider, model: s.distillModel, reasoningEffort: s.reasoningEffort || "" }];
  }
  return [];
}
function validateDistillChain(chain, opts) {
  if (!Array.isArray(chain)) return "distillChain \u987B\u4E3A\u6570\u7EC4";
  if (chain.length > DISTILL_CHAIN_MAX) return `\u8DEF\u7531\u94FE\u6700\u591A ${DISTILL_CHAIN_MAX} \u6761`;
  const seen = /* @__PURE__ */ new Set();
  for (let i = 0; i < chain.length; i++) {
    if (!chain[i] || typeof chain[i] !== "object") return `\u7B2C ${i + 1} \u884C\u987B\u4E3A\u5BF9\u8C61`;
    const e = chain[i];
    const p = typeof e.provider === "string" ? e.provider : "";
    const m = typeof e.model === "string" ? e.model : "";
    const eff = typeof e.reasoningEffort === "string" ? e.reasoningEffort : "";
    if (p.length > 200 || m.length > 200) return `\u7B2C ${i + 1} \u884C provider/model \u8FC7\u957F\uFF08\u2264200 \u5B57\u7B26\uFF09`;
    if (!EFFORT_CHOICES.includes(eff)) return `\u7B2C ${i + 1} \u884C\u601D\u8003\u6863\u4F4D\u975E\u6CD5: ${eff || "(\u7A7A)"}`;
    if (i === 0) {
      if (opts?.requireExplicitHead && (!p || !m)) return "\u4E3B\u8DEF\u7531\u884C\u5FC5\u987B\u663E\u5F0F\u9009\u62E9\u4F9B\u5E94\u5546\u4E0E\u6A21\u578B\uFF08\u5C42\u94FE\u4E0D\u652F\u6301\u8DDF\u968F\u9ED8\u8BA4\u6A21\u578B\uFF09";
      if (p && !m || !p && m) return "\u4E3B\u8DEF\u7531\u884C provider \u4E0E model \u987B\u6210\u5BF9\uFF08\u53CC\u7A7A = \u8DDF\u968F\u9ED8\u8BA4\u6A21\u578B\uFF09";
    } else if (!p || !m) {
      return `\u7B2C ${i + 1} \u884C\u56DE\u9000\u8DEF\u7531\u5FC5\u987B\u663E\u5F0F\u9009\u62E9\u4F9B\u5E94\u5546\u4E0E\u6A21\u578B`;
    }
    if (p && m) {
      const key = `${p}::${m}`;
      if (seen.has(key)) return `\u7B2C ${i + 1} \u884C\u4E0E\u524D\u9762\u7684\u8DEF\u7531\u91CD\u590D\uFF08${p}/${m}\uFF09`;
      seen.add(key);
    }
  }
  return null;
}
const NS = "dsh-memory";
const ALWAYS_ON = {
  enabled: true,
  capture: false,
  distill: false,
  recall: true,
  reasoningEffort: "",
  distillProvider: "",
  distillModel: "",
  distillChain: [],
  distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0 },
  distillMaxInputChars: 0,
  distillLayerChains: { l1: [], l2: [], l3: [] }
};
let cachedScope;
let cachedUnwatch;
let cachedSvc;
function liveSettingsSchema() {
  const budget = () => Schema.number().min(0).max(1e6).default(0);
  const chainEntry = () => Schema.object({
    provider: Schema.string().default(""),
    model: Schema.string().default(""),
    reasoningEffort: Schema.union([...EFFORT_CHOICES]).default("")
  });
  return Schema.object({
    enabled: Schema.boolean().default(true),
    capture: Schema.boolean().default(false),
    distill: Schema.boolean().default(false),
    recall: Schema.boolean().default(true),
    reasoningEffort: Schema.union([...EFFORT_CHOICES]).default(""),
    distillProvider: Schema.string().default(""),
    distillModel: Schema.string().default(""),
    distillChain: Schema.array(chainEntry()).default([]),
    distillLayerChains: Schema.object({
      l1: Schema.array(chainEntry()).default([]),
      l2: Schema.array(chainEntry()).default([]),
      l3: Schema.array(chainEntry()).default([])
    }).default({ l1: [], l2: [], l3: [] }),
    distillBudgets: Schema.object({
      extract: budget(),
      dedup: budget(),
      l2: budget(),
      l3: budget()
    }).default({ extract: 0, dedup: 0, l2: 0, l3: 0 }),
    distillMaxInputChars: Schema.number().min(0).max(1e6).default(0)
  });
}
function registerLiveSettings(ctx, logger) {
  let inner = {
    supported: false,
    get: () => ALWAYS_ON,
    update: () => Promise.reject(new Error("settings \u670D\u52A1\u4E0D\u53EF\u7528"))
  };
  const wireScope = (scope) => {
    cachedUnwatch?.();
    let current = resolveSettings(scope.get());
    cachedUnwatch = scope.watch((next) => {
      const prev = current;
      current = resolveSettings(next);
      const b = current.distillBudgets;
      const budgetNote = b.extract || b.dedup || b.l2 || b.l3 ? `\uFF0C\u8F93\u51FA\u9884\u7B97=\u62BD\u53D6 ${b.extract || "\u9ED8\u8BA4"}/\u53BB\u91CD ${b.dedup || "\u9ED8\u8BA4"}/L2 ${b.l2 || "\u9ED8\u8BA4"}/L3 ${b.l3 || "\u9ED8\u8BA4"}` : "";
      const inputNote = current.distillMaxInputChars > 0 ? `\uFF0C\u8F93\u5165\u9884\u7B97=${current.distillMaxInputChars}` : "";
      logger.info(
        `[memory] \u8BB0\u5FC6\u6A21\u5F0F\u5F00\u5173\u66F4\u65B0\uFF1A\u603B=${current.enabled} \u6355\u83B7=${current.capture} \u84B8\u998F=${current.distill} \u53EC\u56DE=${current.recall}\uFF0C\u84B8\u998F\u601D\u8003=${current.reasoningEffort || "\u8DDF\u968F\u914D\u7F6E"}\uFF08\u6B64\u524D \u603B=${prev.enabled}\uFF09` + (current.distillProvider && current.distillModel ? `\uFF0C\u84B8\u998F\u6A21\u578B=${current.distillProvider}/${current.distillModel}` : "") + budgetNote + inputNote
      );
    });
    return {
      supported: true,
      get: () => current,
      update: async (patch) => {
        await scope.update(patch);
      }
    };
  };
  const invalidateCache = () => {
    cachedScope = void 0;
    cachedSvc = void 0;
    cachedUnwatch?.();
    cachedUnwatch = void 0;
  };
  const tryAttach = () => {
    const settings = ctx.get("settings");
    if (!settings) return false;
    if (cachedScope && cachedSvc === settings) {
      try {
        inner = wireScope(cachedScope);
        const c = inner.get();
        logger.info(
          `[memory] \u8BB0\u5FC6\u6A21\u5F0F\u5F00\u5173\u91CD\u6302\uFF08\u590D\u7528\u8FDB\u7A0B\u5185\u6CE8\u518C\uFF0C\u5F53\u524D\uFF1A\u603B=${c.enabled} \u6355\u83B7=${c.capture} \u84B8\u998F=${c.distill} \u53EC\u56DE=${c.recall}\uFF0C\u84B8\u998F\u601D\u8003=${c.reasoningEffort || "\u8DDF\u968F\u914D\u7F6E"}\uFF09`
        );
        return true;
      } catch (err) {
        logger.warn(`[memory] \u8BB0\u5FC6\u6A21\u5F0F\u5F00\u5173\u7F13\u5B58\u590D\u7528\u5931\u8D25\uFF0C\u6539\u4E3A\u91CD\u65B0\u6CE8\u518C: ${err instanceof Error ? err.message : String(err)}`);
        invalidateCache();
      }
    }
    try {
      const scope = settings.register(NS, liveSettingsSchema(), { applies: "live" });
      cachedScope = scope;
      cachedSvc = settings;
      inner = wireScope(scope);
      logger.info(
        `[memory] \u8BB0\u5FC6\u6A21\u5F0F\u5F00\u5173\u5C31\u7EEA\uFF08settings \u547D\u540D\u7A7A\u95F4 dsh-memory\uFF0C\u5F53\u524D\uFF1A\u603B=${inner.get().enabled} \u6355\u83B7=${inner.get().capture} \u84B8\u998F=${inner.get().distill} \u53EC\u56DE=${inner.get().recall}\uFF0C\u84B8\u998F\u601D\u8003=${inner.get().reasoningEffort || "\u8DDF\u968F\u914D\u7F6E"}\uFF09`
      );
      return true;
    } catch (err) {
      logger.warn(`[memory] \u8BB0\u5FC6\u6A21\u5F0F\u5F00\u5173\u6CE8\u518C\u5931\u8D25\uFF08\u4FDD\u6301\u5168\u5F00\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return true;
    }
  };
  if (!tryAttach()) {
    logger.warn("[memory] settings \u670D\u52A1\u672A\u5C31\u7EEA\uFF0C\u8BB0\u5FC6\u6A21\u5F0F\u5F00\u5173\u6682\u4E0D\u53EF\u7528\uFF08\u4FDD\u6301\u5168\u5F00\uFF0C\u7B49\u5F85\u670D\u52A1\u4E0A\u7EBF\uFF09");
  }
  ctx.on("internal/service", (name, impl) => {
    if (name !== "settings") return;
    if (!impl) {
      if (cachedSvc !== void 0) {
        invalidateCache();
        logger.warn("[memory] settings \u670D\u52A1\u4E0B\u7EBF\uFF0C\u5F00\u5173\u7F13\u5B58\u5DF2\u4F5C\u5E9F\uFF08\u671F\u95F4\u8BFB\u6570\u4E3A\u51BB\u7ED3\u503C\uFF0C\u6062\u590D\u540E\u81EA\u52A8\u91CD\u6302\uFF09");
      }
      return;
    }
    if (impl !== cachedSvc) invalidateCache();
    tryAttach();
  });
  return {
    get supported() {
      return inner.supported;
    },
    get: () => inner.get(),
    update: (patch) => inner.update(patch)
  };
}
function resolveSettings(value) {
  if (!value || typeof value !== "object") return { ...ALWAYS_ON, distillChain: [] };
  const v = value;
  const num = (x) => typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
  const rawBudgets = v.distillBudgets ?? {};
  const defuseChain = (raw) => {
    const out = [];
    if (!Array.isArray(raw)) return out;
    for (const item of raw) {
      if (out.length >= DISTILL_CHAIN_MAX) break;
      if (!item || typeof item !== "object") continue;
      const e = item;
      const eff = typeof e.reasoningEffort === "string" && EFFORT_CHOICES.includes(e.reasoningEffort) ? e.reasoningEffort : "";
      out.push({
        provider: typeof e.provider === "string" ? e.provider.slice(0, 200) : "",
        model: typeof e.model === "string" ? e.model.slice(0, 200) : "",
        reasoningEffort: eff
      });
    }
    return out;
  };
  const rawLayer = v.distillLayerChains ?? {};
  return {
    enabled: v.enabled !== false,
    capture: v.capture !== false,
    distill: v.distill !== false,
    recall: v.recall !== false,
    reasoningEffort: typeof v.reasoningEffort === "string" && EFFORT_CHOICES.includes(v.reasoningEffort) ? v.reasoningEffort : "",
    distillProvider: typeof v.distillProvider === "string" ? v.distillProvider : "",
    distillModel: typeof v.distillModel === "string" ? v.distillModel : "",
    distillChain: defuseChain(v.distillChain),
    distillLayerChains: {
      l1: defuseChain(rawLayer.l1),
      l2: defuseChain(rawLayer.l2),
      l3: defuseChain(rawLayer.l3)
    },
    distillBudgets: {
      extract: num(rawBudgets.extract),
      dedup: num(rawBudgets.dedup),
      l2: num(rawBudgets.l2),
      l3: num(rawBudgets.l3)
    },
    distillMaxInputChars: num(v.distillMaxInputChars)
  };
}
export {
  DISTILL_CHAIN_MAX,
  liveSettingsSchema,
  projectDistillChain,
  registerLiveSettings,
  validateDistillChain
};

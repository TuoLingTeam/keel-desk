import { createRequire } from "node:module";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { EFFORT_CHOICES, resolveDataDir } from "./config.js";
import { effectiveCfg } from "./pipeline/runner.js";
import { emptyRecallStats } from "./hooks/recall.js";
import { buildRouteChain, decideSendableEffort, LAYER_DEFAULT_BUDGETS, layerChainOrNull, resolveModelContextWindow, resolveModelEfforts, resolveModelRoute } from "./llm.js";
import { projectDistillChain, validateDistillChain } from "./settings.js";
import { errDetail } from "./util/filelog.js";
import { snapshotTokenCost } from "./token-cost.js";
import { consolidateSceneCards } from "./store/scene-card.js";
import { buildRuntimeInsights, buildWorkspaceOverview, collectAssetActivity, decodeCursor } from "./workspace-aggregates.js";
const require2 = createRequire(import.meta.url);
const PLUGIN_VERSION = require2("../package.json").version;
function registerMemoryRpc(ctx, cfg, stores, logger, status, live, modes, dataDir, rebuild, embedManager, sessionInfo) {
  let holding = false;
  let registeredImpl;
  const tryRegister = () => {
    if (holding) return;
    const connection = ctx.get("connection");
    if (!connection) return;
    holding = true;
    let active = true;
    const dispose = connection.rpc.handle(
      "/rpc",
      async (endpoint, payload) => {
        try {
          const value = await handleEndpoint(endpoint, payload, {
            ctx,
            cfg,
            stores,
            status,
            live,
            modes,
            dataDir: dataDir ?? resolveDataDir(cfg),
            logger,
            rebuild,
            embedManager,
            sessionInfo
          });
          return { ok: true, value };
        } catch (err) {
          return {
            ok: false,
            error: { code: "internal", message: err instanceof Error ? err.message : String(err), details: {} }
          };
        }
      },
      { authority: "loopback" }
    );
    registeredImpl = connection;
    if (!active) {
      void dispose();
      return;
    }
    logger.debug?.("[memory] \u72B6\u6001 RPC \u5DF2\u6CE8\u518C\uFF08/rpc \u2192 dsh-memory/*\uFF09");
    disposers.push(() => {
      active = false;
      holding = false;
      void dispose();
    });
  };
  const release = () => {
    for (const dispose of disposers.splice(0)) dispose();
  };
  const disposers = [];
  ctx.effect(() => {
    tryRegister();
    const off = ctx.on("internal/service", (name, impl) => {
      if (name !== "connection") return;
      if (!impl) {
        release();
        registeredImpl = void 0;
        logger.debug?.("[memory] connection \u670D\u52A1\u4E0B\u7EBF\uFF0CRPC \u6CE8\u518C\u5DF2\u91CA\u653E\uFF08\u5F85\u6062\u590D\u91CD\u6302\uFF09");
        return;
      }
      if (impl !== registeredImpl) {
        release();
        registeredImpl = void 0;
      }
      tryRegister();
    });
    return () => {
      off();
      release();
    };
  });
}
async function buildStats(cfg, stores, status) {
  const chat = stores.state.forFamily("chat");
  const work = stores.state.forFamily("work");
  const [chatScenes, workScenes, chatPersona, workPersona] = await Promise.all([
    stores.scenes.chat.list(),
    stores.scenes.work.list(),
    stores.persona.chat.read(),
    stores.persona.work.read()
  ]);
  const degraded = status?.degraded() ?? false;
  const personaChars = (chatPersona?.length ?? 0) + (workPersona?.length ?? 0);
  const max = (a, b) => Math.max(a, b);
  const iso = (t) => t ? new Date(t).toISOString() : null;
  return {
    ok: true,
    dataDir: resolveDataDir(cfg),
    family: cfg.family,
    version: PLUGIN_VERSION,
    l0Today: await stores.l0.countToday(),
    l1Count: stores.l1.size,
    l1TotalExtracted: chat.totalExtracted + work.totalExtracted,
    sceneCount: chatScenes.length + workScenes.length,
    personaChars,
    hasPersona: chat.hasPersona || work.hasPersona,
    lastExtractAt: iso(max(chat.lastExtractAt, work.lastExtractAt)),
    lastL2At: iso(max(chat.lastL2At, work.lastL2At)),
    lastL3At: iso(max(chat.lastL3At, work.lastL3At)),
    memoriesSinceL2: chat.newMemoriesSinceL2 + work.newMemoriesSinceL2,
    memoriesSinceL3: chat.memoriesSinceL3 + work.memoriesSinceL3,
    pendingExtract: status?.pending() ?? 0,
    message: degraded ? "degraded\uFF1A\u5B58\u50A8\u4E0D\u53EF\u7528\uFF0C\u8BB0\u5FC6\u529F\u80FD\u5DF2\u505C\u7528" : "running",
    thresholds: { l2MinNewMemories: cfg.l2.minNewMemories, l3Interval: cfg.l3.interval }
  };
}
function expectSessionId(v) {
  if (typeof v !== "string" || !v) throw new Error("sessionId \u7F3A\u5931");
  if (v.length > 512) throw new Error("sessionId \u8FC7\u957F\uFF08\u2264512 \u5B57\u7B26\uFF09");
  return v;
}
async function handleEndpoint(endpoint, payload, deps) {
  const { cfg, stores, status, live, modes, dataDir, rebuild, embedManager, sessionInfo } = deps;
  switch (endpoint) {
    case "dsh-memory/stats":
      return buildStats(cfg, stores, status);
    // ── 工作台聚合（UI 重构分散式；只读，装配见 workspace-aggregates.ts） ──
    case "dsh-memory/workspace-overview": {
      const base = await buildStats(cfg, stores, status);
      const caps = sessionInfo?.capabilities();
      const retrieval = caps ? caps.vectorSearch ? caps.ftsSearch ? "hybrid" : "vector" : caps.ftsSearch ? "keyword" : "none" : null;
      const weekWin = snapshotTokenCost("day", 0).windows.find((w) => w.range === "week");
      return buildWorkspaceOverview(stores, base, weekWin && weekWin.calls > 0 ? weekWin : null, retrieval);
    }
    case "dsh-memory/asset-activity": {
      const p = payload ?? {};
      if (p.query !== void 0 && p.query.length > 4096) throw new Error("query \u8FC7\u957F\uFF08\u22644096 \u5B57\u7B26\uFF09");
      const kind = p.kind === "l1" || p.kind === "l2" || p.kind === "l3" ? p.kind : "";
      const family = p.family === "chat" || p.family === "work" ? p.family : "";
      const sinceNum = Number(p.since);
      const since = Number.isFinite(sinceNum) && sinceNum > 0 && sinceNum <= 864e13 ? sinceNum : 0;
      const limit = Math.min(Math.max(Number(p.limit) || 30, 1), 100);
      const offset = Math.min(decodeCursor(typeof p.cursor === "string" ? p.cursor : null), 1e6);
      return collectAssetActivity(stores, {
        query: (p.query ?? "").trim(),
        kind,
        family,
        sinceMs: since,
        limit,
        offset
      });
    }
    case "dsh-memory/asset-delete": {
      const p = payload ?? {};
      if (typeof p.id !== "string" || !p.id) throw new Error("id \u7F3A\u5931");
      if (p.id.length > 512) throw new Error("id \u8FC7\u957F\uFF08\u2264512 \u5B57\u7B26\uFF09");
      const parts = p.id.split(":");
      const kind = parts[0];
      if (kind === "l1") {
        const recId = parts.slice(1).join(":");
        if (!recId) throw new Error("\u8BB0\u5FC6 id \u975E\u6CD5");
        await stores.l1.deleteBatch([recId]);
        return { ok: true };
      }
      if (kind === "l2") {
        const family = parts[1];
        const name = parts.slice(2).join(":");
        if (family !== "chat" && family !== "work" || !name) throw new Error("\u573A\u666F id \u975E\u6CD5");
        await stores.scenes[family].write(name, "[DELETED]");
        return { ok: true };
      }
      if (kind === "l3") {
        const family = parts[1];
        if (family !== "chat" && family !== "work") throw new Error("\u753B\u50CF id \u975E\u6CD5");
        await stores.persona[family].write("");
        return { ok: true };
      }
      throw new Error("\u4E0D\u652F\u6301\u5220\u9664\u8BE5\u7C7B\u578B");
    }
    case "dsh-memory/asset-update": {
      const p = payload ?? {};
      if (typeof p.id !== "string" || !p.id) throw new Error("id \u7F3A\u5931");
      if (p.id.length > 512) throw new Error("id \u8FC7\u957F\uFF08\u2264512 \u5B57\u7B26\uFF09");
      const content = String(p.content ?? "");
      if (!content.trim()) throw new Error("content \u4E3A\u7A7A");
      if (content.length > 5e4) throw new Error("content \u8FC7\u957F\uFF08\u226450000 \u5B57\u7B26\uFF09");
      const parts = p.id.split(":");
      const kind = parts[0];
      if (kind === "l1") {
        const recId = parts.slice(1).join(":");
        if (!recId) throw new Error("\u8BB0\u5FC6 id \u975E\u6CD5");
        const prev = stores.l1.getByIds([recId])[0];
        if (!prev) throw new Error("\u8BB0\u5FC6\u4E0D\u5B58\u5728");
        const now = Date.now();
        const next = {
          ...prev,
          content: content.trim(),
          updatedAt: now,
          timestamps: Array.from(/* @__PURE__ */ new Set([...prev.timestamps ?? [], now])).sort((a, b) => a - b),
          version: (prev.version ?? 0) + 1
        };
        await stores.l1.rewrite(next);
        return {
          ok: true,
          item: {
            id: `l1:${next.id}`,
            kind: "l1",
            verb: "upd",
            family: next.family ?? "chat",
            title: next.content.split("\n", 1)[0].trim().slice(0, 60),
            content: next.content,
            createdAt: next.createdAt ? new Date(next.createdAt).toISOString() : null,
            updatedAt: new Date(next.updatedAt).toISOString(),
            version: next.version ?? 1,
            sourceSession: next.sessionId ?? null,
            scene: next.scene_name || null,
            l1Type: next.type || null
          }
        };
      }
      if (kind === "l2") {
        const family = parts[1];
        const name = parts.slice(2).join(":");
        if (family !== "chat" && family !== "work" || !name) throw new Error("\u573A\u666F id \u975E\u6CD5");
        await stores.scenes[family].write(name, content);
        return {
          ok: true,
          item: {
            id: p.id,
            kind: "l2",
            verb: "upd",
            family,
            title: name.replace(/\.md$/i, ""),
            content,
            createdAt: null,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            version: null,
            sourceSession: null,
            scene: null,
            l1Type: null
          }
        };
      }
      if (kind === "l3") {
        const family = parts[1];
        if (family !== "chat" && family !== "work") throw new Error("\u753B\u50CF id \u975E\u6CD5");
        await stores.persona[family].write(content);
        return {
          ok: true,
          item: {
            id: p.id,
            kind: "l3",
            verb: "upd",
            family,
            title: `persona-${family}.md`,
            content,
            createdAt: null,
            updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
            version: null,
            sourceSession: null,
            scene: null,
            l1Type: null
          }
        };
      }
      throw new Error("\u4E0D\u652F\u6301\u4FEE\u6539\u8BE5\u7C7B\u578B");
    }
    case "dsh-memory/asset-consolidate": {
      const result = await consolidateSceneCards(stores.l1);
      return { ok: true, ...result };
    }
    case "dsh-memory/runtime-insights":
      return buildRuntimeInsights(stores, sessionInfo, modes, live);
    case "dsh-memory/token-cost": {
      const p = payload ?? {};
      const granularity = p.granularity === "week" || p.granularity === "month" ? p.granularity : "day";
      const retention = cfg.tokenCost.retentionDays;
      const upper = retention > 0 ? retention : 3650;
      const rawDays = p.rangeDays;
      const rangeDays = typeof rawDays === "number" && Number.isInteger(rawDays) && rawDays > 0 && rawDays <= upper ? rawDays : 0;
      return snapshotTokenCost(granularity, rangeDays);
    }
    case "dsh-memory/session-mode-get": {
      if (!modes) throw new Error("\u6863\u4F4D\u5B58\u50A8\u672A\u521D\u59CB\u5316");
      const p = payload ?? {};
      const sessionId = expectSessionId(p.sessionId);
      const s = live?.get();
      const globalRecall = s?.recall ?? true;
      const v = {
        sessionId,
        mode: modes.get(sessionId),
        defaultMode: modes.default,
        recall: modes.getRecall(sessionId) ?? null,
        recallResolved: modes.resolvedRecall(sessionId, globalRecall),
        resume: modes.getResume(sessionId)
      };
      return v;
    }
    case "dsh-memory/session-mode-set": {
      if (!modes) throw new Error("\u6863\u4F4D\u5B58\u50A8\u672A\u521D\u59CB\u5316");
      const p = payload ?? {};
      const sessionId = expectSessionId(p.sessionId);
      const allowed = ["auto", "chat", "work", "off"];
      if (typeof p.mode !== "string" || !allowed.includes(p.mode)) {
        throw new Error(`\u975E\u6CD5\u6863\u4F4D: ${String(p.mode)}\uFF08\u5141\u8BB8 ${allowed.join("/")}\uFF09`);
      }
      if (p.recall !== void 0 && typeof p.recall !== "boolean" && p.recall !== null) {
        throw new Error(`\u975E\u6CD5\u6CE8\u5165\u8986\u76D6: ${String(p.recall)}\uFF08\u5141\u8BB8 true/false/null\uFF09`);
      }
      modes.set(sessionId, p.mode);
      if (typeof p.recall === "boolean") {
        modes.setRecall(sessionId, p.recall);
      } else if (p.recall === null) {
        modes.setRecall(sessionId, void 0);
      }
      deps.logger.info(
        `[memory] \u4F1A\u8BDD\u6863\u4F4D\u8BBE\u7F6E session=${sessionId} mode=${p.mode} recall=${JSON.stringify(modes.getRecall(sessionId) ?? null)}`
      );
      const s = live?.get();
      const v = {
        sessionId,
        mode: p.mode,
        recall: modes.getRecall(sessionId) ?? null,
        recallResolved: modes.resolvedRecall(sessionId, s?.recall ?? true),
        resume: modes.getResume(sessionId)
      };
      return v;
    }
    // ── 会话级统计（悬浮卡信息区；热路径端点，见 SessionInfoSource 的零 I/O 硬规则） ──
    case "dsh-memory/session-stats": {
      if (!sessionInfo) return { supported: false };
      const p = payload ?? {};
      const sessionId = expectSessionId(p.sessionId);
      const mode = modes ? modes.get(sessionId) : "auto";
      const caps = sessionInfo.capabilities();
      const l0Count = await sessionInfo.l0Count(sessionId);
      const s = live?.get();
      const globalRecall = s?.recall ?? true;
      const sessionRecall = modes ? modes.resolvedRecall(sessionId, globalRecall) : true;
      let recallReason;
      if (!cfg.recall.enabled) recallReason = "deploy";
      else if (!globalRecall) recallReason = "global";
      else if (!sessionRecall) recallReason = "session";
      else if (mode === "off") recallReason = "mode";
      const recallOn = recallReason === void 0;
      const view = sessionInfo.runnerView(sessionId, mode);
      const distillView = { ...view, lastDistillAt: view.lastDistillAt ? new Date(view.lastDistillAt).toISOString() : null };
      const chat = stores.state.forFamily("chat");
      const work = stores.state.forFamily("work");
      const lastAt = Math.max(chat.lastExtractAt, work.lastExtractAt);
      let contextWindowTokens = null;
      try {
        const sel = deps.ctx.get("agentDefaultModel")?.currentSelection?.();
        if (sel?.provider && sel?.model) {
          contextWindowTokens = await Promise.race([
            resolveModelContextWindow(deps.ctx, sel.provider, sel.model),
            new Promise((resolve) => setTimeout(() => resolve(null), 3e3))
          ]);
        }
      } catch {
      }
      const v = {
        supported: true,
        sessionId,
        mode,
        defaultMode: modes?.default ?? cfg.family,
        recall: {
          enabled: recallOn,
          ...recallReason ? { reason: recallReason } : {},
          ...sessionInfo.recallStats(sessionId) ?? emptyRecallStats()
        },
        memoryOccupancy: sessionInfo.memoryOccupancy(sessionId),
        occupancyBackfill: sessionInfo.profileEstimate ? {
          recallTokens: sessionInfo.recallEstimate ? await sessionInfo.recallEstimate(sessionId) : null,
          profileTokens: sessionInfo.profileEstimate(sessionId)
        } : null,
        contextWindowTokens,
        distill: distillView,
        l0Count,
        retrieval: caps.vectorSearch ? caps.ftsSearch ? "hybrid" : "vector" : caps.ftsSearch ? "keyword" : "none",
        global: {
          degraded: status?.degraded() ?? false,
          pendingTotal: status?.pending() ?? 0,
          lastExtractAt: lastAt ? new Date(lastAt).toISOString() : null
        }
      };
      return v;
    }
    case "dsh-memory/settings-get": {
      const s = live?.get();
      const budgets = s?.distillBudgets ?? { extract: 0, dedup: 0, l2: 0, l3: 0 };
      let effortEffective = s?.reasoningEffort || cfg.llm.reasoningEffort;
      let effortOptions = ["high"];
      let effortRoute = null;
      try {
        const ecfg = effectiveCfg(cfg, live);
        effortRoute = await resolveModelRoute(deps.ctx, ecfg);
        const cap = await resolveModelEfforts(deps.ctx, effortRoute.provider, effortRoute.model);
        if (cap) {
          effortEffective = decideSendableEffort(cap, ecfg.llm.reasoningEffort).effort;
          if (cap.efforts.length > 0) effortOptions = cap.efforts;
        }
      } catch {
      }
      const resp = {
        supported: live?.supported ?? false,
        settings: s ?? {
          enabled: true,
          capture: true,
          distill: true,
          recall: true,
          reasoningEffort: "",
          distillProvider: "",
          distillModel: "",
          distillChain: [],
          distillBudgets: { extract: 0, dedup: 0, l2: 0, l3: 0 },
          distillMaxInputChars: 0,
          distillLayerChains: { l1: [], l2: [], l3: [] }
        },
        // 静态部署上限（cordis.patch.yml）：运行时开关与它取 AND
        ceilings: { capture: cfg.capture.enabled, distill: cfg.extract.enabled, recall: cfg.recall.enabled },
        effort: {
          current: s?.reasoningEffort ?? "",
          // 静态 schema 与 settings-set 写入门都以 EFFORT_CHOICES 白名单校验，这里断言回窄类型
          effective: effortEffective,
          fallback: cfg.llm.reasoningEffort,
          options: effortOptions,
          ...effortRoute ? { route: effortRoute } : {}
        },
        // 分层输出预算：current 是运行时覆盖（0 = 跟随默认），defaults 是内置默认（UI 占位/提示用）
        budgets: {
          current: budgets,
          defaults: { ...LAYER_DEFAULT_BUDGETS },
          effective: {
            extract: budgets.extract > 0 ? budgets.extract : LAYER_DEFAULT_BUDGETS.extract,
            dedup: budgets.dedup > 0 ? budgets.dedup : LAYER_DEFAULT_BUDGETS.dedup,
            l2: budgets.l2 > 0 ? budgets.l2 : LAYER_DEFAULT_BUDGETS.l2,
            l3: budgets.l3 > 0 ? budgets.l3 : LAYER_DEFAULT_BUDGETS.l3
          }
        },
        // 输入预算（字符）：current 是运行时覆盖（0 = 跟随配置），fallback 是静态配置值
        inputBudget: {
          current: s?.distillMaxInputChars ?? 0,
          fallback: cfg.llm.maxInputChars,
          effective: s && s.distillMaxInputChars > 0 ? s.distillMaxInputChars : cfg.llm.maxInputChars
        }
      };
      return resp;
    }
    case "dsh-memory/settings-set": {
      if (!live) throw new Error("\u5F00\u5173\u901A\u9053\u672A\u521D\u59CB\u5316");
      const patch = payload ?? {};
      const clean = {};
      for (const key of ["enabled", "capture", "distill", "recall"]) {
        if (typeof patch[key] === "boolean") clean[key] = patch[key];
      }
      if (patch.distillChain !== void 0) {
        const err = validateDistillChain(patch.distillChain);
        if (err) throw new Error(err);
        clean.distillChain = patch.distillChain;
      }
      if (patch.distillLayerChains !== void 0) {
        const rawLC = patch.distillLayerChains ?? {};
        const prev = live.get().distillLayerChains ?? {};
        const merged = {
          l1: prev.l1 ?? [],
          l2: prev.l2 ?? [],
          l3: prev.l3 ?? []
        };
        for (const key of ["l1", "l2", "l3"]) {
          if (rawLC[key] === void 0) continue;
          const err = validateDistillChain(rawLC[key], { requireExplicitHead: true });
          if (err) throw new Error(`\u5C42\u8DEF\u7531 ${key}\uFF1A${err}`);
          merged[key] = rawLC[key];
        }
        clean.distillLayerChains = merged;
      }
      if (patch.reasoningEffort !== void 0) {
        const v2 = String(patch.reasoningEffort);
        if (!EFFORT_CHOICES.includes(v2)) {
          throw new Error(`\u975E\u6CD5\u601D\u8003\u6863\u4F4D: ${v2}\uFF08\u5141\u8BB8 '' \u6216 ${EFFORT_CHOICES.filter((x) => x !== "").join("/")}\uFF09`);
        }
        clean.reasoningEffort = v2;
      }
      for (const key of ["distillProvider", "distillModel"]) {
        if (patch[key] !== void 0) {
          const v2 = String(patch[key]);
          if (v2.length > 200) throw new Error(`${key} \u8FC7\u957F\uFF08\u2264200 \u5B57\u7B26\uFF09`);
          clean[key] = v2;
        }
      }
      if (patch.distillBudgets !== void 0) {
        const raw = patch.distillBudgets ?? {};
        const budgets = {};
        for (const key of ["extract", "dedup", "l2", "l3"]) {
          const n = Number(raw[key] ?? 0);
          if (!Number.isInteger(n) || n < 0 || n > 1e6) {
            throw new Error(`distillBudgets.${key} \u987B\u4E3A 0~1000000 \u7684\u6574\u6570\uFF080 = \u8DDF\u968F\u9ED8\u8BA4\uFF09`);
          }
          budgets[key] = n;
        }
        clean.distillBudgets = budgets;
      }
      if (patch.distillMaxInputChars !== void 0) {
        const n = Number(patch.distillMaxInputChars);
        if (!Number.isInteger(n) || n < 0 || n > 1e6 || n > 0 && n < 1e3) {
          throw new Error("distillMaxInputChars \u987B\u4E3A 0 \u6216 1000~1000000 \u7684\u6574\u6570\uFF080 = \u8DDF\u968F\u914D\u7F6E\uFF09");
        }
        clean.distillMaxInputChars = n;
      }
      if (Object.keys(clean).length === 0) throw new Error("\u5F00\u5173\u66F4\u65B0\u8F7D\u8377\u4E3A\u7A7A");
      await live.update(clean);
      deps.logger.info(`[memory] \u8BBE\u7F6E\u66F4\u65B0\uFF1A${JSON.stringify(clean)}`);
      const v = { ok: true, settings: live.get() };
      return v;
    }
    case "dsh-memory/list-records": {
      const p = payload ?? {};
      if (p.query !== void 0 && p.query.length > 4096) throw new Error("query \u8FC7\u957F\uFF08\u22644096 \u5B57\u7B26\uFF09");
      const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 200);
      const offset = Math.min(Math.max(Number(p.offset) || 0, 0), 1e6);
      if (p.query && p.query.trim()) {
        const SEARCH_CAP = 200;
        const wanted = offset + limit + 1;
        const hits = await stores.l1.search(p.query, Math.min(wanted, SEARCH_CAP), { type: p.type || void 0 });
        const filtered = p.scene ? hits.filter((h) => h.scene_name === p.scene) : hits;
        const resp2 = {
          items: filtered.slice(offset, offset + limit).map(hitToUiRecord),
          hasMore: filtered.length > offset + limit,
          total: null,
          truncated: wanted > SEARCH_CAP,
          scenes: offset === 0 ? stores.l1.distinctScenes() : void 0
        };
        return resp2;
      }
      const { items, total } = stores.l1.list({ type: p.type || void 0, scene: p.scene || void 0, limit, offset });
      const resp = {
        items: items.map(hitToUiRecord),
        hasMore: offset + items.length < total,
        total,
        truncated: false,
        scenes: offset === 0 ? stores.l1.distinctScenes() : void 0
      };
      return resp;
    }
    case "dsh-memory/scenes": {
      const items = [];
      for (const family of ["chat", "work"]) {
        const summaries = await stores.scenes[family].list();
        for (const s of summaries) {
          items.push({ path: s.path, family, summary: s.summary, updated: s.updated, heat: s.heat, content: await stores.scenes[family].read(s.path) ?? "" });
        }
      }
      items.sort((a, b) => a.updated < b.updated ? 1 : -1);
      return { items };
    }
    case "dsh-memory/persona": {
      const [chat, work] = await Promise.all([stores.persona.chat.read(), stores.persona.work.read()]);
      const parts = [];
      if (chat) parts.push(`<!-- family: chat -->
${chat}`);
      if (work) parts.push(`<!-- family: work -->
${work}`);
      return { content: parts.join("\n\n---\n\n") };
    }
    case "dsh-memory/log-tail": {
      const p = payload ?? {};
      return { lines: readLogTail(join(dataDir, "memory.log"), Math.min(Math.max(Number(p.lines) || 200, 1), 1e3)) };
    }
    case "dsh-memory/rebuild-status": {
      if (!rebuild) {
        const v = { supported: false, running: false, phase: "idle" };
        return v;
      }
      return rebuild.getStatus();
    }
    case "dsh-memory/rebuild-start": {
      if (!rebuild) throw new Error("\u91CD\u5EFA\u63A7\u5236\u5668\u672A\u521D\u59CB\u5316\uFF08\u5B58\u50A8\u4E0D\u53EF\u7528\uFF09");
      if (status?.degraded()) throw new Error("\u5B58\u50A8\u5904\u4E8E\u964D\u7EA7\u72B6\u6001\uFF0C\u65E0\u6CD5\u91CD\u5EFA");
      const s = live?.get();
      if (s && (!s.enabled || !s.distill)) throw new Error("\u84B8\u998F\u5F00\u5173\u5DF2\u5173\u95ED\uFF0C\u8BF7\u5148\u5F00\u542F\u84B8\u998F\u518D\u91CD\u5EFA");
      if (!cfg.extract.enabled) throw new Error("\u90E8\u7F72\u914D\u7F6E\u5DF2\u505C\u7528\u84B8\u998F\uFF08extract.enabled=false\uFF09\uFF0C\u65E0\u6CD5\u91CD\u5EFA");
      const result = rebuild.start();
      deps.logger.info("[memory] \u6536\u5230\u91CD\u5EFA\u6307\u4EE4\uFF08\u8BBE\u7F6E\u9875\u6309\u94AE\uFF09");
      return result;
    }
    case "dsh-memory/rebuild-cancel": {
      if (!rebuild) throw new Error("\u91CD\u5EFA\u63A7\u5236\u5668\u672A\u521D\u59CB\u5316");
      return rebuild.requestCancel();
    }
    // ── 蒸馏模型选择器（用户已配置的供应商路由） ──
    case "dsh-memory/llm-providers": {
      let providers = [];
      try {
        providers = deps.ctx.llm.listProviders();
      } catch (err) {
        deps.logger.warn(`[memory] \u4F9B\u5E94\u5546\u5217\u8868\u8BFB\u53D6\u5931\u8D25: ${errDetail(err)}`);
      }
      let def = null;
      try {
        const sel = deps.ctx.get("agentDefaultModel")?.currentSelection?.();
        if (sel?.provider && sel?.model) def = { provider: sel.provider, model: sel.model };
      } catch {
      }
      const s = live?.get();
      const current = { provider: s?.distillProvider ?? "", model: s?.distillModel ?? "" };
      const chainCurrent = projectDistillChain(s);
      let effectiveChain = [];
      let effective = null;
      let cfgView = cfg;
      try {
        cfgView = effectiveCfg(cfg, live);
        effective = await resolveModelRoute(deps.ctx, cfgView);
        effectiveChain = buildRouteChain(
          { provider: effective.provider, model: effective.model, effort: cfgView.llm.primaryEffort || "" },
          cfgView.llm.fallbacks,
          cfgView.llm.reasoningEffort
        );
      } catch {
        effective = null;
      }
      const pinned = Boolean(cfg.llm.provider && cfg.llm.model);
      const mkLayerView = (key) => {
        const rt = s?.distillLayerChains?.[key] ?? [];
        const lr = layerChainOrNull(cfgView, key);
        const rtLive = !pinned && rt.length > 0 && !!rt[0].provider && !!rt[0].model;
        return {
          runtime: rt,
          static: cfg.llm.layerRoutes?.[key] ?? [],
          effectiveChain: lr ?? effectiveChain,
          source: rtLive ? "runtime" : lr ? "static" : "global"
        };
      };
      const resp = {
        supported: true,
        providers,
        default: def,
        // 部署静态 pin（provider+model 双字段）优先于运行时选择，UI 据此禁用选择器
        pinned,
        current,
        // 所选供应商是否仍在已注册路由中（用户删掉供应商后提示回退）
        currentRegistered: current.provider === "" || providers.some((p) => p.id === current.provider),
        effective,
        chain: {
          current: chainCurrent,
          static: cfg.llm.fallbacks ?? [],
          effectiveChain,
          source: chainCurrent.length ? "runtime" : "static"
        },
        // 按层层链（#34）：source 三态与解析真值同径（layerChainOrNull）——pinned 下
        // 运行时层链不生效（与 effectiveCfg 注入条件一致），存量照实返回供 UI 展示
        layerChains: {
          l1: mkLayerView("l1"),
          l2: mkLayerView("l2"),
          l3: mkLayerView("l3")
        }
      };
      return resp;
    }
    case "dsh-memory/llm-models": {
      const p = payload ?? {};
      if (typeof p.provider !== "string" || !p.provider) throw new Error("provider \u7F3A\u5931");
      if (p.provider.length > 200) throw new Error("provider \u8FC7\u957F\uFF08\u2264200 \u5B57\u7B26\uFF09");
      const models = await Promise.race([
        deps.ctx.llm.listModels(p.provider),
        new Promise((_, reject) => setTimeout(() => reject(new Error("\u6A21\u578B\u5217\u8868\u67E5\u8BE2\u8D85\u65F6")), 8e3))
      ]);
      const baseModels = models.map((m) => ({ id: m.id, name: m.name, description: m.description ?? null, efforts: [] }));
      const providerId = p.provider;
      const withEfforts = await Promise.race([
        (async () => {
          const out = [];
          for (const m of models) {
            let efforts = [];
            try {
              efforts = (await resolveModelEfforts(deps.ctx, providerId, m.id))?.efforts ?? [];
            } catch {
              efforts = [];
            }
            out.push({ id: m.id, name: m.name, description: m.description ?? null, efforts });
          }
          return out;
        })(),
        new Promise((resolve) => setTimeout(() => resolve(baseModels), 4e3))
      ]);
      const resp = { provider: p.provider, models: withEfforts };
      return resp;
    }
    // ── 嵌入源（远程/本地/关闭 三态）与模型管理 ──
    case "dsh-memory/embedding-state-get": {
      if (!embedManager) {
        const v2 = { supported: false };
        return v2;
      }
      const v = { supported: true, ...await embedManager.snapshot() };
      return v;
    }
    case "dsh-memory/embedding-source-set": {
      if (!embedManager) throw new Error("\u5D4C\u5165\u7BA1\u7406\u5668\u672A\u521D\u59CB\u5316\uFF08\u5B58\u50A8\u4E0D\u53EF\u7528\uFF09");
      const p = payload ?? {};
      if (p.source !== "remote" && p.source !== "local" && p.source !== "off") {
        throw new Error("source \u5FC5\u987B\u662F remote | local | off");
      }
      if (typeof p.activeModel === "string" && p.activeModel.length > 200) {
        throw new Error("activeModel \u8FC7\u957F\uFF08\u2264200 \u5B57\u7B26\uFF09");
      }
      const r = embedManager.requestSource({ source: p.source, activeModel: p.activeModel ?? null });
      if (!r.accepted) throw new Error(r.error ?? "\u5207\u6362\u8BF7\u6C42\u88AB\u62D2\u7EDD");
      deps.logger.info(`[memory] \u6536\u5230\u5D4C\u5165\u6E90\u5207\u6362\u6307\u4EE4\uFF08source=${p.source}${p.activeModel ? "\uFF0Cmodel=" + p.activeModel : ""}\uFF09`);
      return { accepted: true };
    }
    case "dsh-memory/embedding-download-start": {
      if (!embedManager) throw new Error("\u5D4C\u5165\u7BA1\u7406\u5668\u672A\u521D\u59CB\u5316\uFF08\u5B58\u50A8\u4E0D\u53EF\u7528\uFF09");
      const p = payload ?? {};
      if (typeof p.modelId !== "string" || !p.modelId) throw new Error("modelId \u7F3A\u5931");
      const r = embedManager.startDownload(p.modelId);
      if (!r.ok) throw new Error(r.error ?? "\u4E0B\u8F7D\u8BF7\u6C42\u88AB\u62D2\u7EDD");
      deps.logger.info(`[memory] \u6536\u5230\u6A21\u578B\u4E0B\u8F7D\u6307\u4EE4\uFF08${p.modelId}\uFF09`);
      return { accepted: true };
    }
    case "dsh-memory/embedding-download-cancel": {
      if (!embedManager) throw new Error("\u5D4C\u5165\u7BA1\u7406\u5668\u672A\u521D\u59CB\u5316");
      return { cancelled: embedManager.cancelDownload() };
    }
    case "dsh-memory/embedding-model-delete": {
      if (!embedManager) throw new Error("\u5D4C\u5165\u7BA1\u7406\u5668\u672A\u521D\u59CB\u5316");
      const p = payload ?? {};
      if (typeof p.modelId !== "string" || !p.modelId) throw new Error("modelId \u7F3A\u5931");
      return embedManager.deleteModel(p.modelId);
    }
    case "dsh-memory/embedding-runtime-cancel": {
      if (!embedManager) throw new Error("\u5D4C\u5165\u7BA1\u7406\u5668\u672A\u521D\u59CB\u5316");
      return { cancelled: embedManager.cancelRuntimeInstall() };
    }
    case "dsh-memory/embedding-reindex-cancel": {
      if (!embedManager) throw new Error("\u5D4C\u5165\u7BA1\u7406\u5668\u672A\u521D\u59CB\u5316");
      return { cancelled: embedManager.cancelReindex() };
    }
    default:
      throw new Error(`unknown endpoint: ${endpoint}`);
  }
}
function hitToUiRecord(r) {
  return {
    id: r.id,
    content: r.content,
    type: r.type,
    priority: r.priority ?? 60,
    scene: r.scene_name,
    family: r.family ?? null,
    timestamps: (r.timestamps ?? []).map((t) => new Date(t).toISOString()),
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
    version: r.version ?? 0,
    sourceMessageIds: r.source_message_ids ?? [],
    score: r.score ?? null
  };
}
function readLogTail(logPath, maxLines) {
  let fd;
  try {
    fd = openSync(logPath, "r");
    const { size } = statSync(logPath);
    const CHUNK = 64 * 1024;
    const bufs = [];
    let newlines = 0;
    let pos = size;
    while (pos > 0) {
      const read = Math.min(CHUNK, pos);
      pos -= read;
      const buf = Buffer.alloc(read);
      readSync(fd, buf, 0, read, pos);
      bufs.unshift(buf);
      for (let i = 0; i < buf.length; i++) if (buf[i] === 10) newlines++;
      if (newlines > maxLines) break;
    }
    const lines = Buffer.concat(bufs).toString("utf8").split("\n").filter((l) => l.length > 0);
    return lines.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
export {
  PLUGIN_VERSION,
  registerMemoryRpc
};

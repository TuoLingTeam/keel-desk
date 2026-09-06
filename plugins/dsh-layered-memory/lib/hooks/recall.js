import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { RecallDedupeStore } from "../store/recall-dedupe.js";
import { OccupancyStore } from "../store/occupancy.js";
import { applyRecallBudget, raceRecallTimeout, RECALL_EMBED_CAP_MS } from "../util/recall-budget.js";
import {
  clearProfileShare,
  emptyOccupancyLedger,
  estimateInjectedMessageTokens,
  estimateStableSectionTokens,
  recordProfileShare,
  recordRecallInjection,
  resetForCompaction
} from "../util/context-occupancy.js";
import { errDetail } from "../util/filelog.js";
import { blocksToText } from "../util/text.js";
const PROFILE_TTL = 6e4;
const storedEstimateCache = /* @__PURE__ */ new Map();
const RECALL_QUERY_TAIL_MESSAGES = 8;
const RECALL_QUERY_MAX_CHARS = 2e3;
function buildRecallQuery(messages, tailMessages = RECALL_QUERY_TAIL_MESSAGES, maxChars = RECALL_QUERY_MAX_CHARS) {
  const tail = messages.slice(-tailMessages);
  let text = tail.map((m) => blocksToText(m.content)).join(" ").trim();
  if (text.length > maxChars) text = text.slice(-maxChars);
  return text;
}
const MEMORY_TOOLS_GUIDE = `<memory-tools-guide>
## \u8BB0\u5FC6\u5DE5\u5177\u8C03\u7528\u6307\u5357

\u5F53\u4E0A\u65B9\u6CE8\u5165\u7684\u8BB0\u5FC6\u7247\u6BB5\u4E0D\u8DB3\u4EE5\u56DE\u7B54\u7528\u6237\u95EE\u9898\u65F6\uFF0C\u53EF\u4E3B\u52A8\u8C03\u7528\u4EE5\u4E0B\u5DE5\u5177\u83B7\u53D6\u66F4\u591A\u4FE1\u606F\uFF1A

- **memory_search**\uFF1A\u641C\u7D22 L1\uFF0C\u8FD4\u56DE **id**\u3002\u6539/\u5220\u4E4B\u524D\u5FC5\u987B\u5148\u641C\u51FA id\u3002
- **conversation_search**\uFF1A\u641C\u7D22\u539F\u59CB\u5BF9\u8BDD\uFF08L0\uFF09\u3002
- **memory_read_scene**\uFF1A\u8BFB\u53D6 L2 \u573A\u666F\u5757\u6216 L3 \u753B\u50CF\u3002
- **memory_remember**\uFF1A\u540C\u4E00 scene_name \u53EA\u7559\u4E00\u5F20\u6D3B\u5361\u7247\uFF0C\u9ED8\u8BA4\u7528\u65B0\u6B63\u6587\u6574\u5361\u66FF\u6362\uFF08\u4E0D\u8981\u518D\u5F00\u4E00\u6761\uFF09\u3002\u8F6E\u6B21\u65E5\u5FD7\u8981\u4FDD\u7559\u5386\u53F2\u65F6\u4F20 append=true\u3002\u7A7A\u573A\u666F\u540D\u624D\u6309\u4E00\u6761\u4E00\u4E8B\u65B0\u589E\u3002
- **memory_forget**\uFF1A\u6309 id \u5220\u9664\u3002\u7528\u6237\u8BF4\u300C\u5220\u6389\u8FD9\u6761\u300D\u65F6\u5148 search \u518D forget\u3002

### \u26A0\uFE0F \u8C03\u7528\u6B21\u6570\u9650\u5236
\u6BCF\u8F6E\u5BF9\u8BDD\u4E2D\uFF0Cmemory_search \u548C conversation_search **\u5408\u8BA1\u6700\u591A\u8C03\u7528 3 \u6B21**\u3002
- \u9996\u6B21\u641C\u7D22\u65E0\u7ED3\u679C\u65F6\uFF0C\u53EF\u6362\u5173\u952E\u8BCD\u6216\u6362\u5DE5\u5177\u91CD\u8BD5\uFF0C\u4F46\u603B\u8C03\u7528\u6B21\u6570\u4E0D\u8981\u8D85\u8FC7 3 \u6B21\u3002
- \u82E5 3 \u6B21\u641C\u7D22\u540E\u4ECD\u65E0\u7ED3\u679C\uFF0C\u8BF4\u660E\u8BE5\u4FE1\u606F\u4E0D\u5728\u8BB0\u5FC6\u4E2D\uFF0C\u8BF7\u76F4\u63A5\u6839\u636E\u5DF2\u6709\u4FE1\u606F\u56DE\u590D\u7528\u6237\u3002
- memory_remember / memory_forget \u4E0D\u53D7\u4E0A\u8FF0 3 \u6B21\u4E0A\u9650\u7EA6\u675F\uFF0C\u4F46\u6BCF\u8F6E\u5404\u6700\u591A\u8C03\u7528 1 \u6B21\u3002
- \u6539\u8BB0\u5FC6\u7684\u6B63\u786E\u987A\u5E8F\uFF1Amemory_search \u2192 memory_remember(id=\u2026, content=\u5B8C\u6574\u65B0\u6B63\u6587)\u3002\u4E0D\u8981\u53EA\u5199\u65B0\u6761\u3002

\u6CE8\uFF1A\u82E5\u5F53\u524D\u73AF\u5883\u9650\u5236\u76F4\u63A5\u8C03\u7528\u5DE5\u5177\uFF08\u5982\u4EC5\u5141\u8BB8\u4EE3\u7801\u6267\u884C\u5165\u53E3\uFF09\uFF0C\u8BF7\u7ECF\u7531\u8BE5\u73AF\u5883\u7684\u5DE5\u5177\u8C03\u7528\u673A\u5236
\uFF08\u5982 run_code \u7A0B\u5E8F\u5185\uFF09\u4F7F\u7528\u4EE5\u4E0A\u8BB0\u5FC6\u5DE5\u5177\u3002
</memory-tools-guide>`;
function emptyRecallStats(now = Date.now()) {
  return {
    injectedTurns: 0,
    hitTurns: 0,
    totalHits: 0,
    timeouts: 0,
    suppressedRecalls: 0,
    lastHits: 0,
    lastDurationMs: 0,
    updatedAt: now
  };
}
function registerRecall(ctx, cfg, stores, logger, live, modes, dataDir) {
  const dedupe = new RecallDedupeStore(dataDir, logger);
  const occupancyStore = new OccupancyStore(dataDir, logger);
  const recallStats = /* @__PURE__ */ new Map();
  const statFor = (id) => {
    let s = recallStats.get(id);
    if (!s) {
      s = emptyRecallStats();
      recallStats.set(id, s);
    }
    return s;
  };
  const occupancyByAgent = /* @__PURE__ */ new Map();
  const ledgerFor = (id) => {
    let led = occupancyByAgent.get(id);
    if (!led) {
      led = occupancyStore.load(id) ?? emptyOccupancyLedger();
      occupancyByAgent.set(id, led);
    }
    return led;
  };
  const profileCache = {
    chat: { persona: "", nav: "" },
    work: { persona: "", nav: "" }
  };
  const refreshProfile = async () => {
    try {
      const [chat, work] = await Promise.all([
        loadProfileParts(stores, cfg, "chat"),
        loadProfileParts(stores, cfg, "work")
      ]);
      profileCache.chat = chat;
      profileCache.work = work;
    } catch (err) {
      logger.warn(`[memory] \u753B\u50CF/\u573A\u666F\u7F13\u5B58\u5237\u65B0\u5931\u8D25: ${errDetail(err)}`);
    }
  };
  void refreshProfile();
  ctx.effect(() => {
    const timer = setInterval(() => void refreshProfile(), PROFILE_TTL);
    return () => clearInterval(timer);
  });
  const invalidateProfile = () => {
    void refreshProfile();
  };
  ctx.on("agent/disposed", (payload) => {
    recallStats.delete(payload.agent.id);
    occupancyByAgent.delete(payload.agent.id);
  });
  ctx.on("agent/session-start", (payload) => {
    if (payload.source === "compact" || payload.source === "clear") {
      dedupe.reset(payload.agent.id);
      const led = ledgerFor(payload.agent.id);
      resetForCompaction(led);
      occupancyStore.save(payload.agent.id, led);
      logger.info(`[memory] \u53EC\u56DE\u53BB\u91CD\u4E0E\u5360\u7528\u8D26\u672C\u91CD\u7F6E\uFF08agent=${payload.agent.id}\uFF0Csource=${payload.source}\uFF09`);
    }
  });
  if (cfg.recall.enabled) {
    ctx.on(
      "agent/pre-step",
      async (payload, next) => {
        const decision = await next();
        if (decision.kind === "reject" || payload.signal.aborted) return decision;
        try {
          const s = live.get();
          const mode = modes.get(payload.agent.id);
          if (!s.enabled || mode === "off" || !modes.resolvedRecall(payload.agent.id, s.recall)) return decision;
          const hasNewUserMessage = decision.messages.some(
            (m) => m.source?.kind === "user"
          );
          if (!hasNewUserMessage) return decision;
          const query = buildRecallQuery(payload.messages);
          if (!query) {
            const degenerate = statFor(payload.agent.id);
            degenerate.lastHits = 0;
            return decision;
          }
          const st = statFor(payload.agent.id);
          st.injectedTurns++;
          st.lastHits = 0;
          st.updatedAt = Date.now();
          const searchStart = Date.now();
          const hits = await raceRecallTimeout(
            stores.l1.search(query, cfg.recall.maxResults, {
              scoreThreshold: cfg.recall.scoreThreshold,
              family: mode === "auto" ? void 0 : mode,
              // 嵌入内层钳制：给 FTS 降级留出总预算内的时间（远程限 HTTP fetch；本地经 worker 代理 race 放弃）
              embeddingTimeoutMs: RECALL_EMBED_CAP_MS
            }),
            cfg.recall.timeoutMs
          );
          st.updatedAt = Date.now();
          if (hits === void 0) {
            st.timeouts++;
            logger.warn("[memory] \u53EC\u56DE\u8D85\u65F6\uFF0C\u8DF3\u8FC7\u672C\u8F6E\u6CE8\u5165\uFF08\u4E0D\u963B\u585E\u5BF9\u8BDD\uFF09");
            return decision;
          }
          st.lastDurationMs = Date.now() - searchStart;
          const seen = dedupe.seen(payload.agent.id);
          const fresh = hits.filter((h) => !seen.has(h.id));
          const suppressed = hits.length - fresh.length;
          st.suppressedRecalls += suppressed;
          if (suppressed > 0) {
            logger.debug?.(
              `[memory] \u53EC\u56DE\u53BB\u91CD\uFF1A\u538B\u5236 ${suppressed} \u6761\u5DF2\u6CE8\u5165\u8BB0\u5FC6\uFF08agent=${payload.agent.id}\uFF0C\u4F59 ${fresh.length} \u6761\u65B0\u9C9C\u547D\u4E2D\uFF09`
            );
          }
          if (hits.length > 0) {
            st.hitTurns++;
            st.totalHits += fresh.length;
          }
          if (fresh.length === 0) return decision;
          const lines = applyRecallBudget(
            fresh.map((h) => `- [${h.scene_name ? `${h.type}|${h.scene_name}` : h.type}] ${h.content}`),
            { maxCharsPerMemory: cfg.recall.maxCharsPerMemory, maxTotalRecallChars: cfg.recall.maxTotalRecallChars }
          );
          if (lines.length === 0) return decision;
          dedupe.mark(payload.agent.id, fresh.slice(0, lines.length).map((h) => h.id));
          st.lastHits = lines.length;
          const text = [
            "<relevant-memories>",
            "\u4EE5\u4E0B\u662F\u5F53\u524D\u5BF9\u8BDD\u53EC\u56DE\u7684\u76F8\u5173\u8BB0\u5FC6\uFF0C\u4E0D\u4EE3\u8868\u5F53\u524D\u4EFB\u52A1\u8FDB\u7A0B\uFF0C\u4EC5\u4F5C\u4E3A\u53C2\u8003\uFF1A",
            "",
            ...lines,
            "",
            "</relevant-memories>"
          ].join("\n");
          logger.info(
            `[memory] \u53EC\u56DE\u6CE8\u5165 ${lines.length} \u6761 L1\uFF08mode=${mode}\uFF0Cquery="${query.slice(0, 30).replace(/\n/g, " ")}\u2026"\uFF0Cagent=${payload.agent.id}\uFF0C\u6D88\u606F\u4FA7\uFF09`
          );
          const injection = createUserMessage({
            content: [{ type: "text", text }],
            // plugin 字段是宿主 UI 的署名后缀（"上下文注入 · memory"）——用展示友好的
            // 子系统名，不用 cordis id（dsh-memory）；kind:'plugin' 的标题恒为通用
            // "上下文注入"（专用"跨会话召回"标题仅留给 session-reference 来源）
            source: { kind: "plugin", plugin: "memory", form: "recall" }
          });
          const led = ledgerFor(payload.agent.id);
          recordRecallInjection(led, text.length);
          occupancyStore.save(payload.agent.id, led);
          return { kind: "enter", messages: [injection, ...decision.messages] };
        } catch (err) {
          logger.warn(`[memory] \u53EC\u56DE\u6CE8\u5165\u5931\u8D25\uFF08\u8DF3\u8FC7\u672C\u8F6E\uFF09: ${errDetail(err)}`);
          return decision;
        }
      },
      { prepend: true }
    );
  }
  const composeStableText = (agentId) => {
    const s = live.get();
    const mode = modes.get(agentId);
    if (!s.enabled || mode === "off" || !modes.resolvedRecall(agentId, s.recall)) return "";
    const body = mode === "auto" ? formatProfileAuto(profileCache.chat, profileCache.work) : formatProfileSingle(profileCache[mode]);
    const hasRecallHit = (recallStats.get(agentId)?.lastHits ?? 0) > 0;
    if (!cfg.tools) return body;
    if (!body && !hasRecallHit) return "";
    return body ? `${body}

${MEMORY_TOOLS_GUIDE}` : MEMORY_TOOLS_GUIDE;
  };
  async function estimateRecallFromStorage(sessionId) {
    if (storedEstimateCache.has(sessionId)) return storedEstimateCache.get(sessionId) ?? null;
    let tokens = null;
    try {
      const persistence = await ctx.get?.("sessionPersistence");
      const stored = typeof persistence?.loadStored === "function" ? await persistence.loadStored(sessionId) : void 0;
      if (stored?.events) {
        tokens = 0;
        for (const ev of stored.events) {
          if (typeof ev.type === "string" && ev.type.startsWith("compaction")) tokens = 0;
          if (ev.type !== "user/message") continue;
          const src = ev.data?.source;
          if (!src || src.kind !== "plugin" || src.plugin !== "memory" || src.form !== "recall") continue;
          let chars = 0;
          for (const b of ev.data?.content ?? []) {
            if (b?.type === "text" && typeof b.text === "string") chars += b.text.length;
          }
          if (chars > 0) tokens += estimateInjectedMessageTokens(chars);
        }
      }
    } catch {
      tokens = null;
    }
    storedEstimateCache.set(sessionId, tokens);
    return tokens;
  }
  const estimateRecallTokens = async (sessionId) => {
    try {
      const sessions = ctx.get?.("sessions");
      const session = typeof sessions?.get === "function" ? sessions.get(sessionId) : void 0;
      if (session) {
        const visible = new Set(session.surface.nodes);
        let total = 0;
        for (const ev of session.events) {
          if (ev.type !== "user/message" || !visible.has(ev.seq)) continue;
          const msg = ev.data;
          const src = msg?.source;
          if (!src || src.kind !== "plugin" || src.plugin !== "memory" || src.form !== "recall") continue;
          let chars = 0;
          for (const b of msg.content ?? []) {
            if (b?.type === "text" && typeof b.text === "string") chars += b.text.length;
          }
          if (chars > 0) total += estimateInjectedMessageTokens(chars);
        }
        return total;
      }
      return estimateRecallFromStorage(sessionId);
    } catch {
      return null;
    }
  };
  const registered = /* @__PURE__ */ new WeakSet();
  const contextDisposers = [];
  const registerForAgent = (agent) => {
    if (registered.has(agent)) return;
    registered.add(agent);
    try {
      contextDisposers.push(
        agent.ctx.systemPrompt.context({
          name: "memory:profile",
          order: 510,
          text: () => {
            const final = composeStableText(agent.id);
            const ledger = ledgerFor(agent.id);
            if (final === "") clearProfileShare(ledger);
            else recordProfileShare(ledger, final.length);
            occupancyStore.save(agent.id, ledger);
            return final;
          }
        })
      );
    } catch (err) {
      logger.warn(`[memory] \u53EC\u56DE\u4E0A\u4E0B\u6587\u6CE8\u518C\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const agents = ctx.get("agents");
  if (agents) {
    for (const agent of agents.list()) registerForAgent(agent);
  }
  ctx.on("agent/created", (payload) => {
    registerForAgent(payload.agent);
  });
  ctx.effect(() => () => {
    for (const dispose of contextDisposers.splice(0)) {
      try {
        dispose();
      } catch {
      }
    }
  });
  return {
    invalidateProfile,
    stats: (id) => recallStats.get(id),
    /** 全量会话召回统计（工作台洞察聚合；进程内注册表深拷贝，重启归零）。 */
    statsAll: () => Array.from(recallStats.values(), (s) => ({ ...s })),
    /** 占用账本只读出口：内存优先，miss 时从流水复生（重启后历史会话）；从未注入返回 null。 */
    occupancy: (id) => {
      const led = occupancyByAgent.get(id) ?? occupancyStore.load(id);
      if (led) occupancyByAgent.set(id, led);
      return led ?? null;
    },
    estimateProfileTokens: (id) => estimateStableSectionTokens(composeStableText(id).length),
    estimateRecallTokens
  };
}
const DOMAIN_HINT = "\u4EE5\u4E0B\u5185\u5BB9\u6309\u8BB0\u5FC6\u57DF\u5206\u5757\uFF1Achat=\u7528\u6237\u4E2A\u4EBA\u753B\u50CF\uFF08User Narrative Profile\uFF09\uFF0Cwork=\u56E2\u961F\u5DE5\u4F5C\u51C6\u5219\uFF08Team Operating Doctrine\uFF09\u3002\u4E24\u57DF\u72EC\u7ACB\u84B8\u998F\u4E0E\u66F4\u65B0\uFF0C\u8BF7\u6309\u5F53\u524D\u5BF9\u8BDD\u8BED\u5883\u53C2\u8003\u5BF9\u5E94\u57DF\uFF0C\u4E0D\u8981\u628A\u4E00\u57DF\u7684\u5185\u5BB9\u5F53\u4F5C\u53E6\u4E00\u57DF\u7684\u4E8B\u5B9E\u3002";
function wrapDomain(family, content) {
  const label = family === "chat" ? "\u7528\u6237\u4E2A\u4EBA\u753B\u50CF" : "\u56E2\u961F\u5DE5\u4F5C\u51C6\u5219";
  return `<domain family="${family}" label="${label}">
${content.trim()}
</domain>`;
}
function formatProfileSingle(parts) {
  const segments = [];
  if (parts.persona) segments.push(`<user-persona>
${parts.persona}
</user-persona>`);
  if (parts.nav) segments.push(`<scene-navigation>
${parts.nav}
</scene-navigation>`);
  return segments.join("\n\n");
}
function formatProfileAuto(chat, work) {
  const segments = [];
  const personas = [
    ["chat", chat.persona],
    ["work", work.persona]
  ];
  const personaBlocks = personas.filter(([, p]) => p.trim()).map(([f, p]) => wrapDomain(f, p));
  if (personaBlocks.length > 0) {
    segments.push(`<user-persona>
${DOMAIN_HINT}

${personaBlocks.join("\n\n")}
</user-persona>`);
  }
  const navs = [
    ["chat", chat.nav],
    ["work", work.nav]
  ];
  const navBlocks = navs.filter(([, n]) => n.trim()).map(([f, n]) => wrapDomain(f, n));
  if (navBlocks.length > 0) {
    segments.push(`<scene-navigation>
${navBlocks.join("\n\n")}
</scene-navigation>`);
  }
  return segments.join("\n\n");
}
async function loadProfileParts(stores, cfg, family) {
  const persona = cfg.recall.includePersona ? await stores.persona[family].read() ?? "" : "";
  const nav = cfg.recall.includeSceneNav ? (await stores.scenes[family].navigation() ?? "").trim() : "";
  return { persona, nav };
}
export {
  buildRecallQuery,
  emptyRecallStats,
  registerRecall
};

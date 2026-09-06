import { randomBytes } from "node:crypto";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { listSceneCards, mergeIntoSceneCard, sceneCardKey } from "../store/scene-card.js";
import { familyForType } from "../types.js";
const OFF_NOTICE = '\u672C\u4F1A\u8BDD\u7684\u8BB0\u5FC6\u6863\u4F4D\u4E3A"\u5173\u95ED"\uFF1A\u8BE5\u4F1A\u8BDD\u5BF9\u8BB0\u5FC6\u7CFB\u7EDF\u5B8C\u5168\u9690\u8EAB\uFF0C\u4E0D\u8BFB\u53D6\u4E5F\u4E0D\u5199\u5165\u8BB0\u5FC6\u3002';
const WRITE_ONLY_NOTICE = "\u672C\u4F1A\u8BDD\u4E3A\u53EA\u5199\u6A21\u5F0F\uFF1A\u8BB0\u5FC6\u7167\u5E38\u6C89\u6DC0\uFF0C\u4F46\u4E0D\u8BFB\u53D6\u3002";
const GLOBAL_OFF_NOTICE = "\u8BB0\u5FC6\u6CE8\u5165\u5DF2\u5168\u5C40\u505C\u7528\uFF1A\u672C\u4F1A\u8BDD\u4E0D\u8BFB\u53D6\u8BB0\u5FC6\uFF08\u6C89\u6DC0\u7167\u5E38\uFF09\u3002";
function registerMemoryTools(ctx, cfg, stores, logger, modes, live) {
  if (!cfg.tools) return;
  let warnedNoAgent = false;
  const familyOfCaller = (agentId) => {
    if (agentId === void 0) {
      if (!warnedNoAgent) {
        warnedNoAgent = true;
        logger.warn("[memory] \u5DE5\u5177\u8C03\u7528\u7F3A\u5C11 agent \u6807\u8BC6\uFF08exec.agent \u672A\u4F20\u9012\uFF09\uFF0C\u6863\u4F4D\u8FC7\u6EE4\u9000\u5316\u4E3A\u5168\u65CF\u68C0\u7D22");
      }
      return void 0;
    }
    const mode = modes.get(agentId);
    if (mode === "off") return null;
    if (!modes.resolvedRecall(agentId, live.get().recall)) return null;
    return mode === "auto" ? void 0 : mode;
  };
  const blockNoticeOf = (agentId) => {
    if (agentId !== void 0) {
      if (modes.get(agentId) === "off") return OFF_NOTICE;
      if (modes.getRecall(agentId) === false) return WRITE_ONLY_NOTICE;
      if (!modes.resolvedRecall(agentId, live.get().recall)) return GLOBAL_OFF_NOTICE;
    }
    return OFF_NOTICE;
  };
  ctx.tools.register(
    defineTool({
      name: "memory_search",
      description: "\u641C\u7D22\u7ED3\u6784\u5316\u8BB0\u5FC6\uFF08L1\uFF09\u3002\u8FD4\u56DE id / type / scene_name / content\u3002\u7528\u6237\u8981\u6539\u6216\u5220\u67D0\u6761\u65F6\u5148\u641C\u51FA id\uFF0C\u518D\u628A id \u4F20\u7ED9 memory_remember \u6216 memory_forget\u3002",
      parameters: {
        query: { type: "string", required: true, description: "\u641C\u7D22\u67E5\u8BE2\u6587\u672C\uFF08\u81EA\u7136\u8BED\u8A00\uFF09" },
        limit: { type: "number", description: "\u6700\u5927\u8FD4\u56DE\u6761\u6570\uFF08\u9ED8\u8BA4 5\uFF09" },
        type: { type: "string", description: "\u6309\u8BB0\u5FC6\u7C7B\u578B\u8FC7\u6EE4\uFF08\u5982 persona/episodic/instruction/work_fact/work_task/work_method/work_artifact\uFF09" }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  content: { type: "string" },
                  type: { type: "string" },
                  scene_name: { type: "string" },
                  score: { type: "number" }
                },
                additionalProperties: false
              }
            },
            notice: { type: "string", description: "\u975E\u641C\u7D22\u7ED3\u679C\u7684\u72B6\u6001\u63D0\u793A\uFF08\u5982\u672C\u4F1A\u8BDD\u8BB0\u5FC6\u5DF2\u5173\u95ED\uFF09" }
          },
          additionalProperties: false
        },
        render: (_args, value) => [
          { type: "text", text: value.notice ?? renderMemoryItems(value.items ?? []) }
        ]
      },
      execute: async (args, exec) => {
        const family = familyOfCaller(exec.agent?.id);
        if (family === null) return { items: [], notice: blockNoticeOf(exec.agent?.id) };
        const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
        const hits = await stores.l1.search(args.query, limit, { type: args.type || void 0, family: family ?? void 0 });
        return {
          items: hits.map((h) => ({
            id: h.id,
            content: h.content,
            type: h.type,
            scene_name: h.scene_name,
            score: Math.round(h.score * 100) / 100
          }))
        };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "conversation_search",
      description: "\u641C\u7D22\u539F\u59CB\u5BF9\u8BDD\u5386\u53F2\uFF08L0\uFF09\u3002\u8FD4\u56DE\u5E26\u65F6\u95F4\u6233\u7684\u539F\u59CB\u6D88\u606F\uFF0C\u9002\u7528\u4E8E\u67E5\u627E\u5177\u4F53\u6D88\u606F\u539F\u6587\u3001\u65F6\u95F4\u7EBF\u3001\u4E0A\u4E0B\u6587\u7EC6\u8282\u3002",
      parameters: {
        query: { type: "string", required: true, description: "\u641C\u7D22\u67E5\u8BE2\u6587\u672C" },
        limit: { type: "number", description: "\u6700\u5927\u8FD4\u56DE\u6761\u6570\uFF08\u9ED8\u8BA4 5\uFF09" }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  session_id: { type: "string" },
                  role: { type: "string" },
                  content: { type: "string" },
                  timestamp: { type: "number" }
                },
                additionalProperties: false
              }
            },
            notice: { type: "string", description: "\u975E\u641C\u7D22\u7ED3\u679C\u7684\u72B6\u6001\u63D0\u793A\uFF08\u5982\u672C\u4F1A\u8BDD\u8BB0\u5FC6\u5DF2\u5173\u95ED\uFF09" }
          },
          additionalProperties: false
        },
        render: (_args, value) => [
          { type: "text", text: value.notice ?? renderConversationItems(value.items ?? []) }
        ]
      },
      execute: async (args, exec) => {
        if (familyOfCaller(exec.agent?.id) === null) return { items: [], notice: blockNoticeOf(exec.agent?.id) };
        const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
        const records = await stores.l0.search(args.query, limit);
        return {
          items: records.map((r) => ({
            session_id: r.sessionId,
            role: r.role,
            content: r.content,
            timestamp: r.timestamp
          }))
        };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "memory_remember",
      description: "\u5199\u5165\u6216\u6539\u5199 L1\u3002\u6709 scene_name \u65F6\u540C\u4E00\u573A\u666F\u53EA\u7559\u4E00\u5F20\u6D3B\u5361\u7247\uFF0C\u9ED8\u8BA4\u7528\u65B0\u6B63\u6587\u6574\u5361\u66FF\u6362\uFF08\u6539 IP/\u6539\u7ED3\u8BBA\uFF09\u3002\u8F6E\u6B21\u65E5\u5FD7\u8981\u4FDD\u7559\u5386\u53F2\u65F6\u4F20 append=true\u3002\u7A7A\u573A\u666F\u540D\u624D\u6309\u4E00\u6761\u4E00\u4E8B\u65B0\u589E\u3002",
      parameters: {
        content: { type: "string", required: true, description: "\u8981\u8BB0\u4F4F\u7684\u5B8C\u6574\u4E8B\u5B9E\uFF08\u81EA\u7136\u8BED\u8A00\uFF0C\u4E00\u6761\u4E00\u4E8B\uFF09" },
        id: { type: "string", description: "\u8981\u8986\u76D6\u7684\u5DF2\u6709\u8BB0\u5FC6 id\uFF08\u6765\u81EA memory_search\uFF09\u3002\u7528\u6237\u8BF4\u6539/\u66F4\u65B0\u65F6\u5FC5\u586B\u3002" },
        type: {
          type: "string",
          description: "\u8BB0\u5FC6\u7C7B\u578B\uFF1Apersona / episodic / instruction / work_fact / work_task / work_method / work_artifact\uFF08\u9ED8\u8BA4 work_fact\uFF09"
        },
        scene_name: { type: "string", description: "\u60C5\u5883\u540D\uFF0C\u5982\u300C\u53F7\u6C60\u751F\u4EA7\u673A\u300D\u300CCursor \u7A81\u7834\u300D\u3002\u6539\u540C\u4E00\u4E3B\u9898\u65F6\u6CBF\u7528\u65E7\u540D\u3002" },
        family: { type: "string", description: "chat \u6216 work\uFF08\u7F3A\u7701\u6309 type \u63A8\u65AD\uFF09" },
        append: { type: "boolean", description: "true=\u628A\u65B0\u8FDB\u5EA6\u53E0\u8FDB\u540C\u573A\u666F\u6D3B\u5361\u7247\uFF08\u8F6E\u6B21\u65E5\u5FD7\uFF09\uFF1B\u7F3A\u7701\u6574\u5361\u66FF\u6362\u4E3A\u65B0\u6B63\u6587" }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            id: { type: "string" },
            notice: { type: "string" }
          },
          additionalProperties: false
        },
        render: (_args, value) => [
          { type: "text", text: value.notice ?? (value.ok ? `\u5DF2\u8BB0\u4F4F\uFF08${value.id ?? ""}\uFF09` : "\u5199\u5165\u5931\u8D25") }
        ]
      },
      execute: async (args, exec) => {
        const agentId = exec.agent?.id;
        if (agentId !== void 0 && modes.get(agentId) === "off") {
          return { ok: false, notice: OFF_NOTICE };
        }
        if (live.get().enabled === false) {
          return { ok: false, notice: "\u8BB0\u5FC6\u603B\u5F00\u5173\u5DF2\u5173\u95ED\uFF0C\u65E0\u6CD5\u5199\u5165\u3002\u8BF7\u5728\u8BBE\u7F6E \u2192 \u8BB0\u5FC6 \u2192 \u81EA\u52A8\u5316\u91CC\u6253\u5F00\u603B\u5F00\u5173\u540E\u518D\u8BB0\u3002" };
        }
        const content = String(args.content ?? "").trim();
        if (!content) return { ok: false, notice: "content \u4E3A\u7A7A\uFF0C\u672A\u5199\u5165" };
        const type = String(args.type ?? "work_fact").trim() || "work_fact";
        const familyRaw = String(args.family ?? "").trim();
        const family = familyRaw === "chat" || familyRaw === "work" ? familyRaw : familyForType(type);
        const now = Date.now();
        const sceneName = String(args.scene_name ?? "").trim();
        const explicitId = String(args.id ?? "").trim();
        const staleIds = await findSameFactIds(stores.l1, { content, family, sceneName, explicitId });
        const replacing = staleIds.length > 0;
        const id = replacing ? staleIds[0] : `mem_${now}_${randomBytes(3).toString("hex")}`;
        const prev = replacing ? stores.l1.getByIds([id])[0] : void 0;
        const append = args.append === true || String(args.append ?? "") === "true";
        const folded = prev && append ? mergeIntoSceneCard(prev.content, content, now) : content;
        const record = {
          id,
          content: folded,
          type: prev?.type ?? type,
          priority: prev?.priority ?? 90,
          scene_name: sceneName || prev?.scene_name || "",
          timestamps: Array.from(/* @__PURE__ */ new Set([...prev?.timestamps ?? [], now])).sort((a, b) => a - b),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
          version: replacing ? (prev?.version ?? 0) + 1 : 0,
          family,
          sessionId: prev?.sessionId ?? agentId ?? "default"
        };
        if (replacing) {
          await stores.l1.rewrite(record);
          const extras = staleIds.slice(1);
          if (extras.length > 0) await stores.l1.deleteBatch(extras);
          logger.info(
            `[memory] memory_remember \u53E0\u5165\u573A\u666F\u5361 ${id} type=${record.type} family=${family} extras=${extras.length}`
          );
          return { ok: true, id, notice: `\u5DF2\u66F4\u65B0\u8BB0\u5FC6\uFF08${id}\uFF09` };
        }
        await stores.l1.appendNew([record]);
        logger.info(`[memory] memory_remember \u5199\u5165 ${id} type=${type} family=${family}`);
        return { ok: true, id, notice: `\u5DF2\u8BB0\u4F4F\uFF08${id}\uFF09` };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "memory_forget",
      description: "\u6309 id \u5220\u9664\u4E00\u6761 L1 \u8BB0\u5FC6\u3002\u7528\u6237\u8BF4\u300C\u5220\u6389\u8FD9\u6761\u8BB0\u5FC6\u300D\u300C\u5FD8\u6389\u521A\u624D\u90A3\u6761\u300D\u65F6\uFF1A\u5148 memory_search \u62FF\u5230 id\uFF0C\u518D\u8C03\u7528\u672C\u5DE5\u5177\u3002\u53EF\u4E00\u6B21\u5220\u591A\u6761\u3002",
      parameters: {
        id: { type: "string", description: "\u8981\u5220\u9664\u7684\u8BB0\u5FC6 id\uFF08\u6765\u81EA memory_search\uFF09" },
        ids: { type: "string", description: "\u9017\u53F7\u5206\u9694\u7684\u591A\u4E2A id\uFF0C\u6279\u91CF\u5220\u9664\u65F6\u7528" }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            deleted: { type: "number" },
            notice: { type: "string" }
          },
          additionalProperties: false
        },
        render: (_args, value) => [
          { type: "text", text: value.notice ?? (value.ok ? `\u5DF2\u5220\u9664 ${value.deleted ?? 0} \u6761` : "\u5220\u9664\u5931\u8D25") }
        ]
      },
      execute: async (args, exec) => {
        const agentId = exec.agent?.id;
        if (agentId !== void 0 && modes.get(agentId) === "off") {
          return { ok: false, deleted: 0, notice: OFF_NOTICE };
        }
        if (live.get().enabled === false) {
          return { ok: false, deleted: 0, notice: "\u8BB0\u5FC6\u603B\u5F00\u5173\u5DF2\u5173\u95ED\uFF0C\u65E0\u6CD5\u5220\u9664\u3002" };
        }
        const raw = [String(args.id ?? ""), String(args.ids ?? "")].join(",").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        const ids = [...new Set(raw)];
        if (ids.length === 0) return { ok: false, deleted: 0, notice: "id \u7F3A\u5931" };
        const existing = stores.l1.getByIds(ids).map((r) => r.id);
        if (existing.length === 0) return { ok: false, deleted: 0, notice: "\u627E\u4E0D\u5230\u8FD9\u4E9B\u8BB0\u5FC6" };
        await stores.l1.deleteBatch(existing);
        logger.info(`[memory] memory_forget \u5220\u9664 ${existing.join(",")}`);
        return { ok: true, deleted: existing.length, notice: `\u5DF2\u5220\u9664 ${existing.length} \u6761\uFF08${existing.join(", ")}\uFF09` };
      }
    })
  );
  ctx.tools.register(
    defineTool({
      name: "memory_read_scene",
      description: "\u8BFB\u53D6\u8BB0\u5FC6\u6587\u4EF6\u8BE6\u60C5\uFF1AL2 \u573A\u666F\u5757\uFF08\u573A\u666F\u76EE\u5F55\u4E0B\u7684 .md \u6587\u4EF6\uFF09\u6216 L3 \u753B\u50CF\uFF08persona-chat.md / persona-work.md\uFF09\u3002\u8FD4\u56DE\u6587\u4EF6\u5B8C\u6574\u5185\u5BB9\u3002",
      parameters: {
        path: { type: "string", required: true, description: "\u573A\u666F\u6587\u4EF6\u540D\uFF0C\u6216 persona-chat.md / persona-work.md" }
      },
      output: {
        schema: {
          type: "object",
          properties: {
            content: { type: "string", description: "\u6587\u4EF6\u5185\u5BB9\uFF08\u4E0D\u5B58\u5728\u5219\u4E3A\u7A7A\u5B57\u7B26\u4E32\uFF09" }
          },
          additionalProperties: false
        },
        render: (_args, value) => [
          { type: "text", text: value.content ? `\`\`\`markdown
${value.content}
\`\`\`` : "\uFF08\u6587\u4EF6\u4E0D\u5B58\u5728\u6216\u4E3A\u7A7A\uFF09" }
        ]
      },
      execute: async (args, exec) => {
        if (familyOfCaller(exec.agent?.id) === null) return { content: blockNoticeOf(exec.agent?.id) };
        const p = args.path.trim();
        let content;
        if (p === "persona.md" || p === "persona-chat.md" || p === "persona" || p === "persona-chat") {
          content = await stores.persona.chat.read();
        } else if (p === "persona-work.md" || p === "persona-work") {
          content = await stores.persona.work.read();
        } else {
          const primary = familyOfCaller(exec.agent?.id) ?? "chat";
          const other = primary === "chat" ? "work" : "chat";
          content = await stores.scenes[primary].read(p) ?? await stores.scenes[other].read(p);
        }
        return { content: content ?? "" };
      }
    })
  );
  logger.info("[memory] \u5DE5\u5177\u5DF2\u6CE8\u518C: memory_search / conversation_search / memory_read_scene / memory_remember / memory_forget");
}
async function findSameFactIds(l1, opts) {
  const ids = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (id) => {
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  };
  if (opts.explicitId) {
    const hit = l1.getByIds([opts.explicitId])[0];
    if (hit) {
      push(hit.id);
      return ids;
    }
  }
  if (sceneCardKey(opts.family, opts.sceneName)) {
    for (const r of listSceneCards(l1, opts.family, opts.sceneName)) push(r.id);
    if (ids.length > 0) return ids;
  }
  const incoming = factSkeleton(opts.content);
  if (incoming.length >= 2) {
    const hits = await l1.search(opts.content, 8, { family: opts.family });
    for (const h of hits) {
      if (h.id && sameFact(incoming, factSkeleton(h.content))) push(h.id);
    }
  }
  return ids;
}
function factSkeleton(text) {
  return text.toLowerCase().replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, " ").replace(/\bhttps?:\/\/\S+/g, " ").replace(/[\d.:：/_-]+/g, " ").split(/[^\p{L}\p{N}]+/u).map((w) => w.trim()).filter((w) => w.length >= 2 && !FACT_STOP.has(w));
}
const FACT_STOP = /* @__PURE__ */ new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "are",
  "was",
  "were",
  "\u5728",
  "\u662F",
  "\u7684",
  "\u4E86",
  "\u548C",
  "\u4E0E",
  "\u628A",
  "\u88AB",
  "\u7531",
  "\u5230",
  "\u4E3A",
  "\u53CA",
  "\u4E00\u53F0",
  "\u4E00\u4E2A",
  "\u4E00\u6761",
  "\u4EE5\u53CA",
  "\u66F4\u6362",
  "\u6539\u6210",
  "\u6539\u4E3A",
  "\u66F4\u65B0",
  "\u53D8\u6210",
  "ssh",
  "http",
  "https",
  "root"
]);
function sameFact(a, b) {
  if (a.length === 0 || b.length === 0) return false;
  const bs = new Set(b);
  const overlap = a.filter((t) => bs.has(t)).length;
  const min = Math.min(a.length, b.length);
  return overlap >= Math.max(2, Math.ceil(min * 0.55));
}
function renderMemoryItems(items) {
  if (!items || items.length === 0) return "\uFF08\u6CA1\u6709\u627E\u5230\u76F8\u5173\u8BB0\u5FC6\uFF09";
  return items.map((it, i) => `${i + 1}. [${it.type ?? ""}]${it.scene_name ? ` (${it.scene_name})` : ""} id=${it.id ?? ""} ${it.content ?? ""}`).join("\n");
}
function renderConversationItems(items) {
  if (!items || items.length === 0) return "\uFF08\u6CA1\u6709\u627E\u5230\u76F8\u5173\u5BF9\u8BDD\uFF09";
  return items.map((it, i) => {
    const time = it.timestamp ? new Date(it.timestamp).toISOString() : "";
    return `${i + 1}. [${it.role ?? ""}]${time ? ` ${time}` : ""} (session=${it.session_id ?? ""})
${it.content ?? ""}`;
  }).join("\n\n");
}
export {
  registerMemoryTools
};

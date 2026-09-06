import { randomBytes } from "node:crypto";
import { blocksToText } from "../util/text.js";
import { sanitizeText, shouldCaptureL0, stripCodeBlocks } from "../util/sanitize.js";
const RELEVANT_TYPES = /* @__PURE__ */ new Set(["user/message", "assistant/message", "turn/start", "turn/end"]);
function isCaptureRelevant(type) {
  return RELEVANT_TYPES.has(type);
}
const MAX_BUFFER = 500;
class CaptureBuffers {
  map = /* @__PURE__ */ new Map();
  /** 活跃缓冲条目数（诊断/冒烟用）。 */
  get size() {
    return this.map.size;
  }
  push(sid, event) {
    let buf = this.map.get(sid);
    if (!buf) {
      buf = [];
      this.map.set(sid, buf);
    }
    buf.push(event);
    trimBuffer(buf);
  }
  /** 取出该 turn 的全部事件（不含 turn/start 自身）；无匹配 start 时返回整个缓冲。 */
  takeTurn(sid, turn) {
    const buf = this.map.get(sid);
    if (!buf) return [];
    const startIdx = findTurnStart(buf, turn);
    const turnEvents = startIdx === -1 ? buf : buf.slice(startIdx + 1);
    const rest = startIdx === -1 ? [] : buf.slice(0, startIdx);
    if (rest.length === 0) this.map.delete(sid);
    else this.map.set(sid, rest);
    return turnEvents;
  }
}
function registerCapture(ctx, cfg, runner, l0, logger, live, modes) {
  if (!cfg.capture.enabled) return;
  const startFloor = Date.now();
  const buffers = new CaptureBuffers();
  let l0Queue = Promise.resolve();
  ctx.on("session/event", (session, event) => {
    try {
      const s = live.get();
      if (!s.enabled || !s.capture) return;
      const sid = String(session.id ?? session);
      if (modes.get(sid) === "off") return;
      if (!isCaptureRelevant(event.type)) return;
      if (event.time < startFloor) {
        if (event.type === "user/message") {
          logger.info(
            `[memory] L0 \u8DF3\u8FC7\u65E9\u4E8E\u63D2\u4EF6\u542F\u52A8\u7684 user \u6D88\u606F\uFF08\u51B7\u542F\u52A8\u4FDD\u62A4\uFF0C\u65E9 ${startFloor - event.time}ms\uFF09`
          );
        }
        return;
      }
      buffers.push(sid, event);
      if (event.type === "turn/end") {
        const turn = event.data.turn;
        const turnEvents = buffers.takeTurn(sid, turn);
        const messages = turnEventsToMessages(turnEvents, cfg, logger);
        if (messages.length > 0) {
          const roles = messages.reduce((acc, m) => {
            acc[m.role] = (acc[m.role] ?? 0) + 1;
            return acc;
          }, {});
          const mode = modes.get(sid);
          if (mode === "off") {
            logger.info(`[memory] turn=${turn} \u7ED3\u675F\u65F6\u6863\u4F4D\u4E3A\u5173\u95ED\uFF0C\u672C\u8F6E\u4E0D\u843D\u76D8\u4E0D\u84B8\u998F\uFF08session=${sid}\uFF09`);
            return;
          }
          logger.info(
            `[memory] L0 \u6355\u83B7 turn=${turn} ${messages.length} \u6761\uFF08${Object.entries(roles).map(([k, v]) => `${k}=${v}`).join("/")}\uFF0Csession=${sid}\uFF0Cmode=${mode}\uFF09`
          );
          const n = messages.length;
          l0Queue = l0Queue.then(() => l0.append(sid, messages)).then(() => logger.info(`[memory] L0 \u843D\u76D8 ${n} \u6761`)).catch(
            (err) => logger.warn(`[memory] L0 \u843D\u76D8\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`)
          );
          runner.enqueue(sid, messages, mode);
        }
      }
    } catch (err) {
      logger.warn(`[memory] session/event \u5904\u7406\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return () => l0Queue;
}
function trimBuffer(buf) {
  if (buf.length <= MAX_BUFFER) return;
  let openStart = -1;
  let closed = true;
  for (let i = 0; i < buf.length; i++) {
    const t = buf[i].type;
    if (t === "turn/start" && closed) {
      openStart = i;
      closed = false;
    } else if (t === "turn/end") {
      closed = true;
      openStart = -1;
    }
  }
  const floorIdx = openStart === -1 ? Math.max(0, buf.length - MAX_BUFFER) : openStart;
  if (floorIdx > 0) buf.splice(0, floorIdx);
}
function findTurnStart(buf, turn) {
  for (let i = buf.length - 1; i >= 0; i--) {
    const e = buf[i];
    if (e.type === "turn/start" && e.data.turn === turn) return i;
  }
  return -1;
}
function turnEventsToMessages(events, cfg, logger) {
  const out = [];
  for (const event of events) {
    if (event.type === "user/message") {
      const msg = event.data;
      if (msg.source?.kind !== "user") {
        logger.info(`[memory] L0 \u8DF3\u8FC7\u975E\u7528\u6237\u6765\u6E90\u6D88\u606F\uFF08source.kind=${msg.source?.kind ?? "none"}\uFF09`);
        continue;
      }
      const content = sanitizeText(blocksToText(msg.content));
      if (shouldCaptureL0(content)) {
        out.push(makeMessage("user", content, event.time, cfg.capture.maxMessageChars));
      }
    } else if (event.type === "assistant/message") {
      const data = event.data;
      let content = sanitizeText(blocksToText(data.message?.content));
      if (cfg.capture.stripCodeBlocks) content = stripCodeBlocks(content);
      if (shouldCaptureL0(content)) {
        out.push(makeMessage("assistant", content, event.time, cfg.capture.maxMessageChars));
      }
    }
  }
  if (out.length > 0) {
    logger.debug?.(`[memory] \u8F6E\u6B21\u6D88\u606F ${events.length} \u4E8B\u4EF6 \u2192 ${out.length} \u6761\uFF08\u6E05\u6D17\u8FC7\u6EE4\u540E\uFF09`);
  }
  return out;
}
function makeMessage(role, content, timestamp, maxChars) {
  return {
    id: `msg_${Date.now()}_${randomBytes(3).toString("hex")}`,
    role,
    content: content.slice(0, maxChars),
    timestamp
  };
}
export {
  CaptureBuffers,
  isCaptureRelevant,
  registerCapture,
  trimBuffer
};

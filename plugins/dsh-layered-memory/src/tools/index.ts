/**
 * 模型可调用工具：memory_search（L1）、conversation_search（L0）、memory_read_scene（L2/L3）。
 *
 * 会话档位联动：execute 的 exec.agent 即发起调用的 agent（agent.id === sessionId），
 * memory_search 按会话档位过滤族（auto 不过滤，纯档只查本族）；off 档下三工具统一
 * 返回提示（本会话已对记忆系统隐身）。conversation_search 检索范围保持全库。
 * 只写会话（#38：注入覆盖=关）同款拒读，notice 区分文案。
 * 自动捕获关闭时，显式写入走 memory_remember（用户说「记住」才落盘）。
 * 改/删必须走 id。有 scene_name 时同一场景只留一张活卡片：新进度叠进正文，不新开条。
 */
import { randomBytes } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { MemoryConfig } from '../config.js';
import type { LiveSettingsHandle } from '../settings.js';
import type { L0Store } from '../store/l0.js';
import type { L1Store } from '../store/l1.js';
import type { PersonaStore } from '../store/persona.js';
import type { SceneStore } from '../store/scenes.js';
import type { SessionModeStore } from '../store/session-modes.js';
import { listSceneCards, mergeIntoSceneCard, sceneCardKey } from '../store/scene-card.js';
import { familyForType, type MemoryFamily, type MemoryLogger } from '../types.js';

const OFF_NOTICE = '本会话的记忆档位为"关闭"：该会话对记忆系统完全隐身，不读取也不写入记忆。';
const WRITE_ONLY_NOTICE = '本会话为只写模式：记忆照常沉淀，但不读取。';
const GLOBAL_OFF_NOTICE = '记忆注入已全局停用：本会话不读取记忆（沉淀照常）。';

export function registerMemoryTools(
  ctx: Context,
  cfg: MemoryConfig,
  stores: {
    l0: L0Store;
    l1: L1Store;
    scenes: Record<MemoryFamily, SceneStore>;
    persona: Record<MemoryFamily, PersonaStore>;
  },
  logger: MemoryLogger,
  modes: SessionModeStore,
  live: LiveSettingsHandle,
): void {
  if (!cfg.tools) return;

  /**
   * 调用会话的检索族（auto → undefined 不过滤；off/只写 → null 表示整体禁用）。
   * fail-open：exec.agent 缺失（宿主调用路径未带 agent 标识）按全族检索放行——
   * 档位隔离依赖宿主正确传递 exec.agent.id，缺失只告警一次不拒绝工具调用。
   */
  let warnedNoAgent = false;
  const familyOfCaller = (agentId: string | undefined): MemoryFamily | undefined | null => {
    if (agentId === undefined) {
      if (!warnedNoAgent) {
        warnedNoAgent = true;
        logger.warn('[memory] 工具调用缺少 agent 标识（exec.agent 未传递），档位过滤退化为全族检索');
      }
      return undefined;
    }
    const mode = modes.get(agentId);
    if (mode === 'off') return null;
    // 只写会话拒读（#38，T2 裁决）：与注入同属读维度，不拒则"不注入"从工具路径漏风
    if (!modes.resolvedRecall(agentId, live.get().recall)) return null;
    return mode === 'auto' ? undefined : mode;
  };

  /** 拒读时的归因文案（familyOfCaller 判 null 后重查内存 Map，成本可忽略）：
   *  off 完全隐身 / 会话只写覆盖 / 全局召回关——三种停用各说各话，不谎报只写。 */
  const blockNoticeOf = (agentId: string | undefined): string => {
    if (agentId !== undefined) {
      if (modes.get(agentId) === 'off') return OFF_NOTICE;
      if (modes.getRecall(agentId) === false) return WRITE_ONLY_NOTICE;
      if (!modes.resolvedRecall(agentId, live.get().recall)) return GLOBAL_OFF_NOTICE;
    }
    return OFF_NOTICE;
  };

  // ── memory_search: L1 结构化记忆 ──
  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        '搜索结构化记忆（L1）。返回 id / type / scene_name / content。用户要改或删某条时先搜出 id，再把 id 传给 memory_remember 或 memory_forget。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索查询文本（自然语言）' },
        limit: { type: 'number', description: '最大返回条数（默认 5）' },
        type: { type: 'string', description: '按记忆类型过滤（如 persona/episodic/instruction/work_fact/work_task/work_method/work_artifact）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  content: { type: 'string' },
                  type: { type: 'string' },
                  scene_name: { type: 'string' },
                  score: { type: 'number' },
                },
                additionalProperties: false,
              },
            },
            notice: { type: 'string', description: '非搜索结果的状态提示（如本会话记忆已关闭）' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.notice ?? renderMemoryItems(value.items ?? []) },
        ],
      },
      execute: async (args, exec) => {
        const family = familyOfCaller(exec.agent?.id);
        if (family === null) return { items: [], notice: blockNoticeOf(exec.agent?.id) };
        const limit = Math.min(Math.max(args.limit ?? 5, 1), 20);
        const hits = await stores.l1.search(args.query, limit, { type: args.type || undefined, family: family ?? undefined });
        return {
          items: hits.map((h) => ({
            id: h.id,
            content: h.content,
            type: h.type,
            scene_name: h.scene_name,
            score: Math.round(h.score * 100) / 100,
          })),
        };
      },
    }),
  );

  // ── conversation_search: L0 原始对话 ──
  ctx.tools.register(
    defineTool({
      name: 'conversation_search',
      description:
        '搜索原始对话历史（L0）。返回带时间戳的原始消息，适用于查找具体消息原文、时间线、上下文细节。',
      parameters: {
        query: { type: 'string', required: true, description: '搜索查询文本' },
        limit: { type: 'number', description: '最大返回条数（默认 5）' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  session_id: { type: 'string' },
                  role: { type: 'string' },
                  content: { type: 'string' },
                  timestamp: { type: 'number' },
                },
                additionalProperties: false,
              },
            },
            notice: { type: 'string', description: '非搜索结果的状态提示（如本会话记忆已关闭）' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.notice ?? renderConversationItems(value.items ?? []) },
        ],
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
            timestamp: r.timestamp,
          })),
        };
      },
    }),
  );

  // ── memory_remember: 用户明确要求记住时写入 L1（不依赖自动捕获）──
  ctx.tools.register(
    defineTool({
      name: 'memory_remember',
      description:
        '写入或改写 L1。有 scene_name 时同一场景只留一张活卡片，默认用新正文整卡替换（改 IP/改结论）。轮次日志要保留历史时传 append=true。空场景名才按一条一事新增。',
      parameters: {
        content: { type: 'string', required: true, description: '要记住的完整事实（自然语言，一条一事）' },
        id: { type: 'string', description: '要覆盖的已有记忆 id（来自 memory_search）。用户说改/更新时必填。' },
        type: {
          type: 'string',
          description:
            '记忆类型：persona / episodic / instruction / work_fact / work_task / work_method / work_artifact（默认 work_fact）',
        },
        scene_name: { type: 'string', description: '情境名，如「号池生产机」「Cursor 突破」。改同一主题时沿用旧名。' },
        family: { type: 'string', description: 'chat 或 work（缺省按 type 推断）' },
        append: { type: 'boolean', description: 'true=把新进度叠进同场景活卡片（轮次日志）；缺省整卡替换为新正文' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            id: { type: 'string' },
            notice: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.notice ?? (value.ok ? `已记住（${value.id ?? ''}）` : '写入失败') },
        ],
      },
      execute: async (args, exec) => {
        const agentId = exec.agent?.id;
        if (agentId !== undefined && modes.get(agentId) === 'off') {
          return { ok: false, notice: OFF_NOTICE };
        }
        if (live.get().enabled === false) {
          return { ok: false, notice: '记忆总开关已关闭，无法写入。请在设置 → 记忆 → 自动化里打开总开关后再记。' };
        }
        const content = String(args.content ?? '').trim();
        if (!content) return { ok: false, notice: 'content 为空，未写入' };
        const type = String(args.type ?? 'work_fact').trim() || 'work_fact';
        const familyRaw = String(args.family ?? '').trim();
        const family = familyRaw === 'chat' || familyRaw === 'work' ? familyRaw : familyForType(type);
        const now = Date.now();
        const sceneName = String(args.scene_name ?? '').trim();
        const explicitId = String(args.id ?? '').trim();
        const staleIds = await findSameFactIds(stores.l1, { content, family, sceneName, explicitId });
        const replacing = staleIds.length > 0;
        const id = replacing ? staleIds[0]! : `mem_${now}_${randomBytes(3).toString('hex')}`;
        const prev = replacing ? stores.l1.getByIds([id])[0] : undefined;
        const append = args.append === true || String(args.append ?? '') === 'true';
        const folded = prev && append ? mergeIntoSceneCard(prev.content, content, now) : content;
        const record = {
          id,
          content: folded,
          type: prev?.type ?? type,
          priority: prev?.priority ?? 90,
          scene_name: sceneName || prev?.scene_name || '',
          timestamps: Array.from(new Set([...(prev?.timestamps ?? []), now])).sort((a, b) => a - b),
          createdAt: prev?.createdAt ?? now,
          updatedAt: now,
          version: replacing ? (prev?.version ?? 0) + 1 : 0,
          family,
          sessionId: prev?.sessionId ?? agentId ?? 'default',
        };
        if (replacing) {
          await stores.l1.rewrite(record);
          const extras = staleIds.slice(1);
          if (extras.length > 0) await stores.l1.deleteBatch(extras);
          logger.info(
            `[memory] memory_remember 叠入场景卡 ${id} type=${record.type} family=${family} extras=${extras.length}`,
          );
          return { ok: true, id, notice: `已更新记忆（${id}）` };
        }
        await stores.l1.appendNew([record]);
        logger.info(`[memory] memory_remember 写入 ${id} type=${type} family=${family}`);
        return { ok: true, id, notice: `已记住（${id}）` };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: 'memory_forget',
      description:
        '按 id 删除一条 L1 记忆。用户说「删掉这条记忆」「忘掉刚才那条」时：先 memory_search 拿到 id，再调用本工具。可一次删多条。',
      parameters: {
        id: { type: 'string', description: '要删除的记忆 id（来自 memory_search）' },
        ids: { type: 'string', description: '逗号分隔的多个 id，批量删除时用' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            deleted: { type: 'number' },
            notice: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.notice ?? (value.ok ? `已删除 ${value.deleted ?? 0} 条` : '删除失败') },
        ],
      },
      execute: async (args, exec) => {
        const agentId = exec.agent?.id;
        if (agentId !== undefined && modes.get(agentId) === 'off') {
          return { ok: false, deleted: 0, notice: OFF_NOTICE };
        }
        if (live.get().enabled === false) {
          return { ok: false, deleted: 0, notice: '记忆总开关已关闭，无法删除。' };
        }
        const raw = [String(args.id ?? ''), String(args.ids ?? '')]
          .join(',')
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean);
        const ids = [...new Set(raw)];
        if (ids.length === 0) return { ok: false, deleted: 0, notice: 'id 缺失' };
        const existing = stores.l1.getByIds(ids).map((r) => r.id);
        if (existing.length === 0) return { ok: false, deleted: 0, notice: '找不到这些记忆' };
        await stores.l1.deleteBatch(existing);
        logger.info(`[memory] memory_forget 删除 ${existing.join(',')}`);
        return { ok: true, deleted: existing.length, notice: `已删除 ${existing.length} 条（${existing.join(', ')}）` };
      },
    }),
  );

  // ── memory_read_scene: 读取 L2 场景块 / L3 画像 ──
  ctx.tools.register(
    defineTool({
      name: 'memory_read_scene',
      description:
        '读取记忆文件详情：L2 场景块（场景目录下的 .md 文件）或 L3 画像（persona-chat.md / persona-work.md）。返回文件完整内容。',
      parameters: {
        path: { type: 'string', required: true, description: '场景文件名，或 persona-chat.md / persona-work.md' },
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            content: { type: 'string', description: '文件内容（不存在则为空字符串）' },
          },
          additionalProperties: false,
        },
        render: (_args, value) => [
          { type: 'text', text: value.content ? `\`\`\`markdown\n${value.content}\n\`\`\`` : '（文件不存在或为空）' },
        ],
      },
      execute: async (args, exec) => {
        if (familyOfCaller(exec.agent?.id) === null) return { content: blockNoticeOf(exec.agent?.id) };
        const p = args.path.trim();
        let content: string | undefined;
        if (p === 'persona.md' || p === 'persona-chat.md' || p === 'persona' || p === 'persona-chat') {
          content = await stores.persona.chat.read();
        } else if (p === 'persona-work.md' || p === 'persona-work') {
          content = await stores.persona.work.read();
        } else {
          // 场景文件在两族目录里按名查找（先本族后另一族）
          const primary = familyOfCaller(exec.agent?.id) ?? 'chat';
          const other: MemoryFamily = primary === 'chat' ? 'work' : 'chat';
          content =
            (await stores.scenes[primary].read(p)) ?? (await stores.scenes[other].read(p));
        }
        return { content: content ?? '' };
      },
    }),
  );

  logger.info('[memory] 工具已注册: memory_search / conversation_search / memory_read_scene / memory_remember / memory_forget');
}

/** 覆盖：显式 id → 同场景全部卡片（一张活卡）→ 无场景时才按正文骨架撞一条。 */
async function findSameFactIds(
  l1: L1Store,
  opts: { content: string; family: MemoryFamily; sceneName: string; explicitId: string },
): Promise<string[]> {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | undefined) => {
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

function factSkeleton(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ')
    .replace(/[\d.:：/_-]+/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .map((w) => w.trim())
    .filter((w) => w.length >= 2 && !FACT_STOP.has(w));
}

const FACT_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'are', 'was', 'were',
  '在', '是', '的', '了', '和', '与', '把', '被', '由', '到', '为', '及',
  '一台', '一个', '一条', '以及', '更换', '改成', '改为', '更新', '变成',
  'ssh', 'http', 'https', 'root',
]);

function sameFact(a: string[], b: string[]): boolean {
  if (a.length === 0 || b.length === 0) return false;
  const bs = new Set(b);
  const overlap = a.filter((t) => bs.has(t)).length;
  const min = Math.min(a.length, b.length);
  return overlap >= Math.max(2, Math.ceil(min * 0.55));
}

function renderMemoryItems(
  items: Array<{ id?: string; content?: string; type?: string; scene_name?: string; score?: number }>,
): string {
  if (!items || items.length === 0) return '（没有找到相关记忆）';
  return items
    .map((it, i) => `${i + 1}. [${it.type ?? ''}]${it.scene_name ? ` (${it.scene_name})` : ''} id=${it.id ?? ''} ${it.content ?? ''}`)
    .join('\n');
}

function renderConversationItems(
  items: Array<{ session_id?: string; role?: string; content?: string; timestamp?: number }>,
): string {
  if (!items || items.length === 0) return '（没有找到相关对话）';
  return items
    .map((it, i) => {
      const time = it.timestamp ? new Date(it.timestamp).toISOString() : '';
      return `${i + 1}. [${it.role ?? ''}]${time ? ` ${time}` : ''} (session=${it.session_id ?? ''})\n${it.content ?? ''}`;
    })
    .join('\n\n');
}

import { createRequire } from "node:module";
import { existsSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import { familyForType } from "../types.js";
import { bm25RankToScore, buildFtsQuery, tokenizeForFts } from "./search-utils.js";
import { describeTokenizer, ensureTokenizer, tokenizerStamp } from "../util/tokenizer.js";
const require2 = createRequire(import.meta.url);
const TAG = "[memory][sqlite]";
import { CostLedger } from "./cost-ledger.js";
const ZERO_VEC_BUFFER = 10;
const IN_CHUNK = 900;
const VEC_SKIP_CAP = 900;
function chunkIds(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(ids.slice(i, i + IN_CHUNK));
  return out;
}
function emptyCostAggregate() {
  return { calls: 0, inputChars: 0, outputTokens: 0, reasoningTokens: 0, avgOutputTokens: 0, medianOutputTokens: 0 };
}
class MemoryDb {
  db;
  degraded = false;
  ftsAvailable = false;
  vecLoaded = false;
  vecLoadWarned = false;
  /** 向量维度：活切换嵌入源（D5）时会变——vec0 表随维度重建。 */
  dimensions;
  logger;
  stmtUpsertL1;
  stmtGetL1;
  /** 主表存在性点查（防御性 FTS 删除的前置判断，走主键索引）。 */
  stmtL1Exists;
  stmtDeleteL1Meta;
  stmtDeleteL1Vec;
  stmtInsertL1Vec;
  stmtSearchL1Vec;
  stmtL1FtsInsert;
  stmtL1FtsDelete;
  stmtL1FtsSearch;
  stmtL1FtsSearchFamily;
  /** 成本账本（token_cost 表族；init 内初始化，未就绪时方法返回零值）。 */
  costLedger = new CostLedger();
  stmtUpsertL0;
  stmtGetL0;
  /** 主表存在性点查（同 L1：防御性 FTS 删除的前置判断）。 */
  stmtL0Exists;
  stmtDeleteL0Vec;
  stmtInsertL0Vec;
  stmtSearchL0Vec;
  stmtL0FtsInsert;
  stmtL0FtsDelete;
  stmtL0FtsSearch;
  constructor(dbPath, dimensions, logger) {
    this.dimensions = dimensions;
    this.logger = logger;
    try {
      const dbDir = path.dirname(dbPath);
      if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });
      const { DatabaseSync: DbSync } = require2("node:sqlite");
      this.db = new DbSync(dbPath, { allowExtension: true });
      this.db.exec("PRAGMA busy_timeout = 5000");
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
      this.db.exec("PRAGMA cache_size = -65536");
      this.db.exec("PRAGMA mmap_size = 134217728");
      this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    } catch (err) {
      this.degraded = true;
      this.logger?.error(
        `${TAG} \u6570\u636E\u5E93\u6253\u5F00\u5931\u8D25\uFF0C\u5B58\u50A8\u8FDB\u5165\u964D\u7EA7\u6A21\u5F0F\uFF08\u8BB0\u5FC6\u8BFB\u5199\u505C\u7528\uFF09: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  isDegraded() {
    return this.degraded;
  }
  getCapabilities() {
    return {
      ftsSearch: this.ftsAvailable && !this.degraded,
      vectorSearch: this.vecLoaded && this.dimensions > 0 && !this.degraded
    };
  }
  /**
   * 加载 sqlite-vec 扩展并建 schema。构造后必须调用一次。
   * providerInfo 变化（provider/model/维度）时 drop 向量表并返回 needsReindex。
   */
  init(providerInfo) {
    if (this.degraded) return { needsReindex: false, reason: "database open failed" };
    this.ensureVecLoaded();
    ensureTokenizer();
    this.logger?.info(`${TAG} \u5206\u8BCD\u5668\uFF1A${describeTokenizer()}`);
    try {
      return this.initSchema(providerInfo);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`${TAG} schema \u521D\u59CB\u5316\u5931\u8D25\uFF0C\u5B58\u50A8\u8FDB\u5165\u964D\u7EA7\u6A21\u5F0F: ${message}`);
      this.degraded = true;
      return { needsReindex: false, reason: `schema init failed: ${message}` };
    }
  }
  /** 惰性加载 sqlite-vec（纯 FTS 起步后切本地嵌入时补加载）；失败只停用向量能力并告警一次。 */
  ensureVecLoaded() {
    if (this.vecLoaded || this.dimensions <= 0) return;
    try {
      const sqliteVec = require2("sqlite-vec");
      this.db.enableLoadExtension(true);
      try {
        sqliteVec.load(this.db);
        this.vecLoaded = true;
      } finally {
        this.db.enableLoadExtension(false);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.vecLoadWarned) {
        this.vecLoadWarned = true;
        this.logger?.warn(`${TAG} sqlite-vec \u52A0\u8F7D\u5931\u8D25\uFF0C\u5411\u91CF\u68C0\u7D22\u505C\u7528\uFF08\u964D\u7EA7\u4E3A\u7EAF FTS\uFF09: ${message}`);
      }
    }
  }
  /**
   * 活切换嵌入源（D5）：provider/model/维度任一变化 → drop 向量表按新维度重建，
   * 返回 needsReindex=true（调用方后台重嵌，全部成功后 markEmbeddingSynced）；
   * 配置未变化 → false（切回同一模型不重嵌）。
   * 新维度 > 0 但 sqlite-vec 不可用 → ok=false（调用方向用户说明，维持 FTS）。
   */
  swapProvider(info) {
    if (this.degraded) return { ok: false, needsReindex: false, error: "\u6570\u636E\u5E93\u964D\u7EA7\u6A21\u5F0F" };
    if (info.dimensions <= 0) {
      this.dimensions = 0;
      return { ok: true, needsReindex: false };
    }
    this.dimensions = info.dimensions;
    this.ensureVecLoaded();
    if (!this.vecLoaded) {
      return { ok: false, needsReindex: false, error: "sqlite-vec \u6269\u5C55\u4E0D\u53EF\u7528\uFF0C\u65E0\u6CD5\u542F\u7528\u5411\u91CF\u68C0\u7D22" };
    }
    const saved = this.readEmbeddingMeta();
    const physical = this.physicalVecDims();
    const unchanged = saved && saved.provider === info.provider && saved.model === info.model && saved.dimensions === info.dimensions && physical === info.dimensions;
    if (unchanged) return { ok: true, needsReindex: false };
    this.dropVectorTables();
    return { ok: true, needsReindex: true };
  }
  /** l1_vec 物理表的向量维度（建表 DDL 里的 float[N]）；无表返回 null。 */
  physicalVecDims() {
    try {
      const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'l1_vec'").get();
      if (!row?.sql) return null;
      const m = /float\[(\d+)\]/.exec(row.sql);
      return m ? Number(m[1]) : null;
    } catch {
      return null;
    }
  }
  initSchema(providerInfo) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    let needsReindex = false;
    let reason;
    const savedMeta = this.readEmbeddingMeta();
    if (providerInfo) {
      if (savedMeta) {
        const providerChanged = savedMeta.provider !== providerInfo.provider;
        const modelChanged = savedMeta.model !== providerInfo.model;
        const dimsChanged = savedMeta.dimensions !== this.dimensions;
        if (providerChanged || modelChanged || dimsChanged) {
          const reasons = [];
          if (providerChanged) reasons.push(`provider: ${savedMeta.provider} \u2192 ${providerInfo.provider}`);
          if (modelChanged) reasons.push(`model: ${savedMeta.model} \u2192 ${providerInfo.model}`);
          if (dimsChanged) reasons.push(`dimensions: ${savedMeta.dimensions} \u2192 ${this.dimensions}`);
          reason = reasons.join(", ");
          this.logger?.info(`${TAG} embedding \u914D\u7F6E\u53D8\u5316\uFF08${reason}\uFF09\uFF0C\u91CD\u5EFA\u5411\u91CF\u8868`);
          this.dropVectorTables();
          needsReindex = true;
        }
      } else if (this.countL1() > 0 || this.countL0() > 0) {
        this.dropVectorTables();
        needsReindex = true;
        reason = "embedding \u9996\u6B21\u542F\u7528\uFF0C\u5DF2\u6709\u6570\u636E\u9700\u8981\u91CD\u5D4C\u5165";
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l1_records (
        record_id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        type TEXT DEFAULT '',
        priority INTEGER DEFAULT 50,
        scene_name TEXT DEFAULT '',
        session_id TEXT DEFAULT 'default',
        version INTEGER NOT NULL DEFAULT 0,
        timestamp_str TEXT DEFAULT '',
        timestamp_start TEXT DEFAULT '',
        timestamp_end TEXT DEFAULT '',
        created_time TEXT DEFAULT '',
        updated_time TEXT DEFAULT '',
        metadata_json TEXT DEFAULT '{}',
        family TEXT NOT NULL DEFAULT 'chat'
      )
    `);
    if (!this.hasColumn("l1_records", "family")) {
      this.db.exec("ALTER TABLE l1_records ADD COLUMN family TEXT NOT NULL DEFAULT 'chat'");
      this.logger?.info(`${TAG} l1_records \u8865 family \u5217\uFF08\u65E7\u6570\u636E\u6309 type \u524D\u7F00\u56DE\u586B\uFF09`);
    }
    const backfilled = this.db.prepare("UPDATE l1_records SET family = 'work' WHERE type LIKE 'work\\_%' ESCAPE '\\' AND family != 'work'").run().changes;
    if (backfilled > 0) this.logger?.info(`${TAG} family \u56DE\u586B ${backfilled} \u6761 work \u8BB0\u5F55`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_type ON l1_records(type)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_scene ON l1_records(scene_name)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_ts_start ON l1_records(timestamp_start)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_updated ON l1_records(updated_time)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l1_family ON l1_records(family)");
    this.stmtUpsertL1 = this.db.prepare(`
      INSERT INTO l1_records (
        record_id, content, type, priority, scene_name, session_id, version,
        timestamp_str, timestamp_start, timestamp_end, created_time, updated_time, metadata_json, family
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        content=excluded.content,
        type=excluded.type,
        priority=excluded.priority,
        scene_name=excluded.scene_name,
        version=excluded.version,
        timestamp_str=excluded.timestamp_str,
        timestamp_start=excluded.timestamp_start,
        timestamp_end=excluded.timestamp_end,
        updated_time=excluded.updated_time,
        metadata_json=excluded.metadata_json,
        family=excluded.family
    `);
    this.stmtGetL1 = this.db.prepare(`
      SELECT record_id, content, type, priority, scene_name, version, timestamp_str,
             timestamp_start, timestamp_end, created_time, updated_time, metadata_json, family
      FROM l1_records WHERE record_id = ?
    `);
    this.stmtL1Exists = this.db.prepare("SELECT 1 FROM l1_records WHERE record_id = ?");
    this.stmtDeleteL1Meta = this.db.prepare("DELETE FROM l1_records WHERE record_id = ?");
    this.prepareL1VecStatements();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS l0_conversations (
        record_id TEXT PRIMARY KEY,
        session_id TEXT DEFAULT 'default',
        role TEXT NOT NULL DEFAULT '',
        message_text TEXT NOT NULL,
        recorded_at TEXT DEFAULT '',
        timestamp INTEGER DEFAULT 0
      )
    `);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_session_id ON l0_conversations(session_id)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_recorded ON l0_conversations(recorded_at)");
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_l0_timestamp ON l0_conversations(timestamp)");
    this.stmtUpsertL0 = this.db.prepare(`
      INSERT INTO l0_conversations (record_id, session_id, role, message_text, recorded_at, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(record_id) DO UPDATE SET
        session_id=excluded.session_id,
        role=excluded.role,
        message_text=excluded.message_text,
        recorded_at=excluded.recorded_at,
        timestamp=excluded.timestamp
    `);
    this.stmtGetL0 = this.db.prepare(
      "SELECT session_id, role, message_text, recorded_at, timestamp FROM l0_conversations WHERE record_id = ?"
    );
    this.stmtL0Exists = this.db.prepare("SELECT 1 FROM l0_conversations WHERE record_id = ?");
    this.prepareL0VecStatements();
    this.costLedger.init(this.db, this.logger);
    try {
      const wantStamp = tokenizerStamp();
      const savedStamp = this.readMetaString("fts_tokenizer") ?? "bigram-v1";
      const tokenizerChanged = savedStamp !== wantStamp;
      let ftsRebuilt = false;
      if (this.tableExists("l1_fts") && (!this.hasColumn("l1_fts", "family") || tokenizerChanged)) {
        this.db.exec("DROP TABLE l1_fts");
        ftsRebuilt = true;
        this.logger?.info(`${TAG} l1_fts \u7F3A family \u5217\u6216\u5206\u8BCD\u5668\u5DF2\u53D8\u66F4\uFF08${savedStamp} \u2192 ${wantStamp}\uFF09\uFF0C\u91CD\u5EFA\u5168\u6587\u7D22\u5F15`);
      }
      let l0FtsRebuilt = false;
      if (this.tableExists("l0_fts") && tokenizerChanged) {
        this.db.exec("DROP TABLE l0_fts");
        l0FtsRebuilt = true;
        this.logger?.info(`${TAG} l0_fts \u5206\u8BCD\u5668\u5DF2\u53D8\u66F4\uFF08${savedStamp} \u2192 ${wantStamp}\uFF09\uFF0C\u91CD\u5EFA\u5168\u6587\u7D22\u5F15`);
      }
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_fts USING fts5(
          content,
          content_original UNINDEXED,
          record_id UNINDEXED,
          type UNINDEXED,
          priority UNINDEXED,
          scene_name UNINDEXED,
          session_id UNINDEXED,
          version UNINDEXED,
          timestamp_str UNINDEXED,
          timestamp_start UNINDEXED,
          timestamp_end UNINDEXED,
          metadata_json UNINDEXED,
          family UNINDEXED
        )
      `);
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_fts USING fts5(
          message_text,
          message_text_original UNINDEXED,
          record_id UNINDEXED,
          session_id UNINDEXED,
          role UNINDEXED,
          recorded_at UNINDEXED,
          timestamp UNINDEXED
        )
      `);
      this.stmtL1FtsInsert = this.db.prepare(`
        INSERT INTO l1_fts (content, content_original, record_id, type, priority, scene_name,
          session_id, version, timestamp_str, timestamp_start, timestamp_end, metadata_json, family)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtL1FtsDelete = this.db.prepare("DELETE FROM l1_fts WHERE record_id = ?");
      this.stmtL1FtsSearch = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name, version,
               timestamp_str, timestamp_start, timestamp_end, metadata_json, family,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);
      this.stmtL1FtsSearchFamily = this.db.prepare(`
        SELECT record_id, content_original AS content, type, priority, scene_name, version,
               timestamp_str, timestamp_start, timestamp_end, metadata_json, family,
               bm25(l1_fts) AS rank
        FROM l1_fts
        WHERE l1_fts MATCH ? AND family = ?
        ORDER BY rank ASC
        LIMIT ?
      `);
      if (ftsRebuilt) this.backfillL1Fts();
      this.stmtL0FtsInsert = this.db.prepare(`
        INSERT INTO l0_fts (message_text, message_text_original, record_id, session_id, role, recorded_at, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      this.stmtL0FtsDelete = this.db.prepare("DELETE FROM l0_fts WHERE record_id = ?");
      this.stmtL0FtsSearch = this.db.prepare(`
        SELECT record_id, message_text_original AS message_text, session_id, role, recorded_at, timestamp,
               bm25(l0_fts) AS rank
        FROM l0_fts
        WHERE l0_fts MATCH ?
        ORDER BY rank ASC
        LIMIT ?
      `);
      if (l0FtsRebuilt) this.backfillL0Fts();
      try {
        this.writeMetaString("fts_tokenizer", wantStamp);
      } catch {
      }
      this.ftsAvailable = true;
    } catch (err) {
      this.ftsAvailable = false;
      this.logger?.warn(
        `${TAG} FTS5 \u4E0D\u53EF\u7528\uFF08\u53EF\u80FD\u672A\u7F16\u8BD1\u8FDB SQLite\uFF09: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (providerInfo && this.countL1() === 0 && this.countL0() === 0) {
      this.writeEmbeddingMeta(providerInfo);
    }
    return { needsReindex, reason };
  }
  prepareL1VecStatements() {
    if (this.vecLoaded && this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l1_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          updated_time TEXT DEFAULT ''
        )
      `);
      this.stmtDeleteL1Vec = this.db.prepare("DELETE FROM l1_vec WHERE record_id = ?");
      this.stmtInsertL1Vec = this.db.prepare(
        "INSERT INTO l1_vec (record_id, embedding, updated_time) VALUES (?, ?, ?)"
      );
      this.stmtSearchL1Vec = this.db.prepare(`
        SELECT record_id, distance
        FROM l1_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    } else {
      this.stmtDeleteL1Vec = void 0;
      this.stmtInsertL1Vec = void 0;
      this.stmtSearchL1Vec = void 0;
    }
  }
  prepareL0VecStatements() {
    if (this.vecLoaded && this.dimensions > 0) {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS l0_vec USING vec0(
          record_id TEXT PRIMARY KEY,
          embedding float[${this.dimensions}] distance_metric=cosine,
          recorded_at TEXT DEFAULT ''
        )
      `);
      this.stmtDeleteL0Vec = this.db.prepare("DELETE FROM l0_vec WHERE record_id = ?");
      this.stmtInsertL0Vec = this.db.prepare(
        "INSERT INTO l0_vec (record_id, embedding, recorded_at) VALUES (?, ?, ?)"
      );
      this.stmtSearchL0Vec = this.db.prepare(`
        SELECT record_id, distance
        FROM l0_vec
        WHERE embedding MATCH ?
          AND k = ?
        ORDER BY distance
      `);
    } else {
      this.stmtDeleteL0Vec = void 0;
      this.stmtInsertL0Vec = void 0;
      this.stmtSearchL0Vec = void 0;
    }
  }
  dropVectorTables() {
    this.db.exec("DROP TABLE IF EXISTS l1_vec");
    this.db.exec("DROP TABLE IF EXISTS l0_vec");
    this.inStmts.clear();
    this.clearVecSkipIds("l1");
    this.clearVecSkipIds("l0");
    this.prepareL1VecStatements();
    this.prepareL0VecStatements();
  }
  tableExists(table) {
    const row = this.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table);
    return row !== void 0;
  }
  hasColumn(table, column) {
    const rows = this.db.prepare(`PRAGMA table_info(${table})`).all();
    return rows.some((r) => r.name === column);
  }
  /** 重建后的 l1_fts 从 l1_records 全量回灌（仅在 drop 重建时调用）。 */
  backfillL1Fts() {
    const rows = this.db.prepare(
      `SELECT record_id, content, type, priority, scene_name, session_id, version,
                timestamp_str, timestamp_start, timestamp_end, metadata_json, family FROM l1_records`
    ).all();
    for (const r of rows) {
      try {
        this.stmtL1FtsInsert.run(
          tokenizeForFts(String(r.content ?? "")),
          String(r.content ?? ""),
          String(r.record_id ?? ""),
          String(r.type ?? ""),
          Number(r.priority ?? 50),
          String(r.scene_name ?? ""),
          String(r.session_id ?? "default"),
          Number(r.version ?? 0),
          String(r.timestamp_str ?? ""),
          String(r.timestamp_start ?? ""),
          String(r.timestamp_end ?? ""),
          String(r.metadata_json ?? "{}"),
          String(r.family ?? "chat")
        );
      } catch {
      }
    }
    if (rows.length > 0) this.logger?.info(`${TAG} l1_fts \u56DE\u704C ${rows.length} \u884C`);
  }
  /** 重建后的 l0_fts 从 l0_conversations 全量回灌（仅 drop 重建时调用；iterate 流式防大库内存峰值）。 */
  backfillL0Fts() {
    let count = 0;
    const stmt = this.db.prepare(
      "SELECT record_id, session_id, role, message_text, recorded_at, timestamp FROM l0_conversations"
    );
    for (const r of stmt.iterate()) {
      try {
        this.stmtL0FtsInsert.run(
          tokenizeForFts(String(r.message_text ?? "")),
          String(r.message_text ?? ""),
          String(r.record_id ?? ""),
          String(r.session_id ?? "default"),
          String(r.role ?? ""),
          String(r.recorded_at ?? ""),
          Number(r.timestamp ?? 0)
        );
        count++;
      } catch {
      }
    }
    if (count > 0) this.logger?.info(`${TAG} l0_fts \u56DE\u704C ${count} \u884C`);
  }
  readEmbeddingMeta() {
    try {
      const row = this.db.prepare("SELECT value FROM embedding_meta WHERE key = ?").get("embedding_provider_info");
      if (!row) return void 0;
      const parsed = JSON.parse(row.value);
      if (typeof parsed.provider !== "string") return void 0;
      return {
        provider: parsed.provider,
        model: parsed.model ?? "",
        dimensions: parsed.dimensions ?? 0
      };
    } catch {
      return void 0;
    }
  }
  writeEmbeddingMeta(info) {
    this.db.prepare(
      "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run("embedding_provider_info", JSON.stringify(info));
  }
  /** 通用字符串 kv（embedding_meta 表兼作元数据 kv 存储，如 FTS 分词器版本戳）。 */
  readMetaString(key) {
    try {
      const row = this.db.prepare("SELECT value FROM embedding_meta WHERE key = ?").get(key);
      return row?.value ?? null;
    } catch {
      return null;
    }
  }
  writeMetaString(key, value) {
    this.db.prepare(
      "INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, value);
  }
  /**
   * 持久化 embedding meta（语义：物理向量表当前对应的 provider/维度）。
   * 活切换在 swapProvider 成功后即写（表已是新维度）；启动/补齐链在
   * 缺失向量补齐收敛（missing=0）后写——缺失行补齐判据是行数差，
   * 不依赖 meta（review P7 语义在 backfill 计数判据下仍然收敛）。
   */
  markEmbeddingSynced(info) {
    if (this.degraded) return;
    try {
      this.writeEmbeddingMeta(info);
    } catch (err) {
      this.logger?.warn(`${TAG} embedding meta \u5199\u5165\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // ============================
  // L1 写入 / 删除 / 读取
  // ============================
  /** upsert 一条 L1（元数据 + FTS 同步；embedding 非零时写向量）。失败返回 false 不抛。 */
  upsertL1(record, embedding) {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.upsertL1InTx(record, embedding);
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} L1 upsert \u5931\u8D25\uFF08\u975E\u81F4\u547D\uFF09id=${record.id}: ${err instanceof Error ? err.message : String(err)}`
      );
      return false;
    }
  }
  /**
   * 批量 upsert L1（单事务；与单条同语义：FTS 失败整批回滚）。
   * 追加/导入热路径用它——逐条开事务在 WAL FULL 下每条一次 fsync。
   * 整批失败时回退逐条写入：好记录照常入库、坏记录只丢自身——否则
   * JSONL 事实源已先行追加，检索库却整批缺失且无自动重导路径（批次空洞）。
   */
  upsertL1Batch(records, embeddings) {
    if (this.degraded || records.length === 0) return false;
    try {
      this.db.exec("BEGIN");
      try {
        for (let i = 0; i < records.length; i++) {
          this.upsertL1InTx(records[i], embeddings?.[i]);
        }
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw err;
      }
      return true;
    } catch (err) {
      this.logger?.warn(
        `${TAG} L1 \u6279\u91CF\u5199\u5165\u5931\u8D25\uFF0C\u56DE\u9000\u9010\u6761\u5199\u5165: ${err instanceof Error ? err.message : String(err)}`
      );
      const failed = [];
      for (let i = 0; i < records.length; i++) {
        if (!this.upsertL1(records[i], embeddings?.[i])) failed.push(records[i]?.id ?? `#${i}`);
      }
      if (failed.length > 0) {
        this.logger?.warn(
          `${TAG} \u9010\u6761\u56DE\u9000\u540E\u4ECD\u5931\u8D25 ${failed.length}/${records.length} \u6761: ${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "\u2026" : ""}`
        );
      }
      return failed.length === 0;
    }
  }
  /** 事务内的单条写入体（upsertL1 / upsertL1Batch 共用；调用方负责 BEGIN/COMMIT）。 */
  upsertL1InTx(record, embedding) {
    const ts = timestampsToDb(record.timestamps);
    const type = record.type ?? "";
    const priority = record.priority ?? 50;
    const sceneName = record.scene_name ?? "";
    const family = record.family ?? familyForType(type);
    const ftsExisted = this.ftsAvailable ? this.stmtL1Exists.get(record.id) !== void 0 : false;
    this.stmtUpsertL1.run(
      record.id,
      record.content,
      type,
      priority,
      sceneName,
      record.sessionId ?? "default",
      record.version ?? 0,
      ts.str,
      ts.start,
      ts.end,
      toIso(record.createdAt),
      toIso(record.updatedAt),
      JSON.stringify(record.metadata ?? {}),
      family
    );
    if (this.stmtDeleteL1Vec && this.stmtInsertL1Vec) {
      this.stmtDeleteL1Vec.run(record.id);
      if (embedding && !isZeroVector(embedding)) {
        this.stmtInsertL1Vec.run(record.id, vecToBuffer(embedding), toIso(record.updatedAt));
      }
    }
    if (this.ftsAvailable) {
      if (ftsExisted) this.stmtL1FtsDelete.run(record.id);
      this.stmtL1FtsInsert.run(
        tokenizeForFts(record.content),
        record.content,
        record.id,
        type,
        priority,
        sceneName,
        record.sessionId ?? "default",
        record.version ?? 0,
        ts.str,
        ts.start,
        ts.end,
        JSON.stringify(record.metadata ?? {}),
        family
      );
    }
  }
  /** 批量删除 L1（元数据 + 向量 + FTS），返回删除条数。IN 按 ≤900 分块（避变量数上限）。 */
  deleteL1Batch(ids) {
    if (this.degraded || ids.length === 0) return 0;
    try {
      this.db.exec("BEGIN");
      try {
        for (const chunk of chunkIds(ids)) this.inStatement("l1_records", "delete", chunk.length).run(...chunk);
        if (this.stmtDeleteL1Vec) {
          for (const chunk of chunkIds(ids)) this.inStatement("l1_vec", "delete", chunk.length).run(...chunk);
        }
        if (this.ftsAvailable) {
          for (const chunk of chunkIds(ids)) this.inStatement("l1_fts", "delete", chunk.length).run(...chunk);
        }
        this.db.exec("COMMIT");
        return ids.length;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u6279\u91CF\u5220\u9664\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }
  /** 按块缓存的 IN 语句（表名/动作/尺寸 → 预编译语句）：热路径不再每次动态 prepare。 */
  inStmts = /* @__PURE__ */ new Map();
  inStatement(table, action, size) {
    const key = `${table}:${action}:${size}`;
    let stmt = this.inStmts.get(key);
    if (!stmt) {
      const ph = Array.from({ length: size }, () => "?").join(",");
      stmt = action === "delete" ? this.db.prepare(`DELETE FROM ${table} WHERE record_id IN (${ph})`) : this.db.prepare(
        `SELECT record_id, content, type, priority, scene_name, session_id, version, timestamp_str, created_time, updated_time, metadata_json, family FROM ${table} WHERE record_id IN (${ph})`
      );
      this.inStmts.set(key, stmt);
    }
    return stmt;
  }
  /**
   * 清空 L1 检索库全部数据（重建用）。records/FTS 直接 DELETE；
   * 向量表走 DROP + 重建（vec0 的全表 DELETE 语义不可靠，dropVectorTables
   * 会连 l0_vec 一起删——L0 向量必须保留——故此处单独处理 l1_vec）。
   * L0 表与 embedding_meta 不动：backfill 的行数比对天然重新一致。
   */
  clearL1() {
    if (this.degraded) return false;
    try {
      this.db.exec("BEGIN");
      try {
        this.db.exec("DELETE FROM l1_records");
        if (this.ftsAvailable) this.db.exec("DELETE FROM l1_fts");
        this.db.exec("COMMIT");
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw err;
      }
      if (this.stmtDeleteL1Vec) {
        this.db.exec("DROP TABLE IF EXISTS l1_vec");
        this.prepareL1VecStatements();
        this.inStmts.clear();
      }
      this.clearVecSkipIds("l1");
      this.logger?.info(`${TAG} L1 \u68C0\u7D22\u5E93\u5DF2\u6E05\u7A7A\uFF08\u91CD\u5EFA\uFF09`);
      return true;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u6E05\u7A7A\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  countL1() {
    if (this.degraded) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l1_records").get();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }
  /** 全量读取（调试/迁移/重嵌入用；检索请走 FTS/向量）。 */
  getAllL1() {
    if (this.degraded) return [];
    const rows = this.db.prepare(
      "SELECT record_id, content, type, priority, scene_name, session_id, version, timestamp_str, created_time, updated_time, metadata_json, family FROM l1_records"
    ).all();
    return rows.map(rowToRecord);
  }
  getL1ByIds(ids) {
    if (this.degraded || ids.length === 0) return [];
    const rows = [];
    for (const chunk of chunkIds(ids)) {
      rows.push(...this.inStatement("l1_records", "select", chunk.length).all(...chunk));
    }
    return rows.map(rowToRecord);
  }
  /** 浏览列表（UI 用）：按更新时间倒序，支持类型/场景/族/时间下限过滤与分页。失败返回空。 */
  listL1(opts) {
    if (this.degraded) return { items: [], total: 0 };
    try {
      const where = [];
      const params = [];
      if (opts.type) {
        where.push("type = ?");
        params.push(opts.type);
      }
      if (opts.scene) {
        where.push("scene_name = ?");
        params.push(opts.scene);
      }
      if (opts.family) {
        where.push("family = ?");
        params.push(opts.family);
      }
      if (opts.since) {
        where.push("updated_time >= ?");
        params.push(opts.since);
      }
      const whereSql = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
      const totalRow = this.db.prepare(`SELECT COUNT(*) AS n FROM l1_records${whereSql}`).get(...params);
      const rows = this.db.prepare(
        `SELECT record_id, content, type, priority, scene_name, session_id, version, timestamp_str, created_time, updated_time, metadata_json, family FROM l1_records${whereSql} ORDER BY updated_time DESC LIMIT ? OFFSET ?`
      ).all(...params, opts.limit, opts.offset);
      return { items: rows.map(rowToRecord), total: totalRow?.n ?? 0 };
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u6D4F\u89C8\u5217\u8868\u67E5\u8BE2\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return { items: [], total: 0 };
    }
  }
  /** 近 N 天逐日 L1 更新计数（工作台活动图；idx_l1_updated 范围扫描 + GROUP BY）。
   *  day 为 ISO 日期前缀 YYYY-MM-DD（updated_time 存 ISO 文本，substr 即日期）。 */
  countL1ByDay(sinceIso) {
    if (this.degraded) return [];
    try {
      return this.db.prepare(
        "SELECT substr(updated_time, 1, 10) AS day, COUNT(*) AS n FROM l1_records WHERE updated_time >= ? AND updated_time <> '' GROUP BY day ORDER BY day"
      ).all(sinceIso);
    } catch {
      return [];
    }
  }
  /** 场景名去重列表（UI 筛选器数据源）。失败返回空。 */
  distinctL1Scenes() {
    if (this.degraded) return [];
    try {
      const rows = this.db.prepare("SELECT DISTINCT scene_name FROM l1_records ORDER BY scene_name").all();
      return rows.map((r) => r.scene_name).filter(Boolean);
    } catch {
      return [];
    }
  }
  // ============================
  // L1 检索
  // ============================
  /** FTS5 BM25 检索（family 缺省不过滤）。失败返回空数组（调用方降级）。 */
  searchL1Fts(query, limit, family) {
    if (this.degraded || !this.ftsAvailable || limit <= 0) return [];
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      const rows = family ? this.stmtL1FtsSearchFamily.all(ftsQuery, family, limit) : this.stmtL1FtsSearch.all(ftsQuery, limit);
      return rows.map((r) => ({
        id: r.record_id,
        content: r.content,
        type: r.type,
        priority: r.priority,
        scene_name: r.scene_name,
        family: normFamily(r.family, r.type),
        score: bm25RankToScore(r.rank)
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} L1 FTS \u68C0\u7D22\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /** vec0 余弦 KNN 检索（score = 1 - cosine distance；family 过滤走过度召回 + 回查过滤，vec0 无法 WHERE）。失败返回空数组。 */
  searchL1Vector(embedding, topK, family) {
    if (this.degraded || !this.stmtSearchL1Vec || topK <= 0) return [];
    try {
      const retrieveCount = (topK + ZERO_VEC_BUFFER) * (family ? 3 : 1);
      const rows = this.stmtSearchL1Vec.all(vecToBuffer(embedding), retrieveCount);
      const hits = [];
      for (const { record_id, distance } of rows) {
        if (distance == null || Number.isNaN(distance)) continue;
        const meta = this.stmtGetL1.get(record_id);
        if (!meta) continue;
        if (family && normFamily(meta.family, meta.type) !== family) continue;
        hits.push({
          id: record_id,
          content: meta.content,
          type: meta.type,
          priority: meta.priority,
          scene_name: meta.scene_name,
          family: normFamily(meta.family, meta.type),
          score: 1 - distance
        });
      }
      return hits.slice(0, topK);
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u5411\u91CF\u68C0\u7D22\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  // ============================
  // L0 写入 / 删除 / 读取
  // ============================
  /** 批量 upsert L0 消息（元数据 + FTS；embeddings 与 records 等长，可省略）。 */
  upsertL0Batch(records, embeddings) {
    if (this.degraded || records.length === 0) return false;
    try {
      this.db.exec("BEGIN");
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const sessionId = rec.sessionId ?? "default";
        const role = rec.role ?? "";
        const content = rec.content ?? "";
        const recordedAt = rec.recordedAt ?? "";
        const timestamp = rec.timestamp ?? 0;
        const ftsExisted = this.ftsAvailable ? this.stmtL0Exists.get(rec.id) !== void 0 : false;
        this.stmtUpsertL0.run(rec.id, sessionId, role, content, recordedAt, timestamp);
        if (this.stmtDeleteL0Vec && this.stmtInsertL0Vec) {
          this.stmtDeleteL0Vec.run(rec.id);
          const vec = embeddings?.[i];
          if (vec && !isZeroVector(vec)) {
            this.stmtInsertL0Vec.run(rec.id, vecToBuffer(vec), recordedAt);
          }
        }
        if (this.ftsAvailable) {
          if (ftsExisted) this.stmtL0FtsDelete.run(rec.id);
          this.stmtL0FtsInsert.run(tokenizeForFts(content), content, rec.id, sessionId, role, recordedAt, timestamp);
        }
      }
      this.db.exec("COMMIT");
      return true;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
      }
      this.logger?.warn(`${TAG} L0 \u6279\u91CF\u5199\u5165\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
  /** 记录一次蒸馏调用成本（委托 cost-ledger；语义见 CostLedger.insertCostCall）。 */
  insertCostCall(provider, model, layer, inputChars, outputTokens, reasoningTokens, retentionDays) {
    this.costLedger.insertCostCall(provider, model, layer, inputChars, outputTokens, reasoningTokens, retentionDays);
  }
  /** 查询 token_cost 单窗口聚合（委托 cost-ledger；降级/异常返回零值）。 */
  aggregateCost(since) {
    return this.costLedger.aggregateCost(since);
  }
  /** 按层级归并聚合（委托 cost-ledger；降级/异常返回空数组）。 */
  aggregateCostByLayer(since) {
    return this.costLedger.aggregateCostByLayer(since);
  }
  /** 按时间桶 + model 聚合（委托 cost-ledger；趋势图与日均/周均/月均共用）。 */
  aggregateByBucket(bucketMs, offsetMs, since, layer) {
    return this.costLedger.aggregateByBucket(bucketMs, offsetMs, since, layer);
  }
  countL0() {
    if (this.degraded) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l0_conversations").get();
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }
  /** 统计 recorded_at >= iso 的消息数（状态面板"今日捕获"用）。 */
  countL0Since(iso) {
    if (this.degraded) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l0_conversations WHERE recorded_at >= ?").get(iso);
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }
  /** 统计某会话已捕获消息数（session-stats 数据源；idx_l0_session_id 索引点查）。 */
  countL0BySession(sessionId) {
    if (this.degraded) return 0;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l0_conversations WHERE session_id = ?").get(sessionId);
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }
  /** 按会话取最近消息（时间升序返回；走 idx_l0_session_id 索引）。
   *  蒸馏背景参考专用——按会话现查替代全局内存数组（ADR-0003）。 */
  recentL0BySession(sessionId, limit) {
    if (this.degraded || limit <= 0) return [];
    try {
      const rows = this.db.prepare(
        "SELECT record_id, session_id, role, message_text, recorded_at, timestamp FROM l0_conversations WHERE session_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?"
      ).all(sessionId, limit);
      return rows.map((r) => ({
        sessionId: r.session_id,
        recordedAt: r.recorded_at,
        id: r.record_id,
        role: r.role,
        content: r.message_text,
        timestamp: r.timestamp ?? 0
      })).reverse();
    } catch (err) {
      this.logger?.warn(`[memory] L0 \u6309\u4F1A\u8BDD\u53D6\u6700\u8FD1\u6D88\u606F\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /** L0 全量列举（重建快照用；按时间升序，事务一致性避开 JSONL 追加竞态）。 */
  listL0All() {
    if (this.degraded) return [];
    try {
      const rows = this.db.prepare("SELECT record_id, session_id, role, message_text, recorded_at, timestamp FROM l0_conversations ORDER BY timestamp ASC").all();
      return rows.map((r) => ({
        sessionId: r.session_id,
        recordedAt: r.recorded_at,
        id: r.record_id,
        role: r.role,
        content: r.message_text,
        timestamp: r.timestamp ?? 0
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} L0 \u5168\u91CF\u5217\u4E3E\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /** 重建成本预估（一次全表聚合：会话数 / 消息数 / 字符量）。 */
  l0RebuildEstimate() {
    if (this.degraded) return { sessions: 0, messages: 0, chars: 0 };
    try {
      const row = this.db.prepare(
        "SELECT COUNT(DISTINCT session_id) AS s, COUNT(*) AS n, COALESCE(SUM(LENGTH(message_text)), 0) AS c FROM l0_conversations"
      ).get();
      return { sessions: row?.s ?? 0, messages: row?.n ?? 0, chars: row?.c ?? 0 };
    } catch {
      return { sessions: 0, messages: 0, chars: 0 };
    }
  }
  /** 向量表行数（backfill 判据：与元数据行数的差值即缺失向量数；不可用时返回 -1）。 */
  countL1Vec() {
    if (this.degraded || !this.stmtSearchL1Vec) return -1;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l1_vec").get();
      return row?.n ?? -1;
    } catch {
      return -1;
    }
  }
  countL0Vec() {
    if (this.degraded || !this.stmtSearchL0Vec) return -1;
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS n FROM l0_vec").get();
      return row?.n ?? -1;
    } catch {
      return -1;
    }
  }
  // ============================
  // L0 检索
  // ============================
  searchL0Fts(query, limit) {
    if (this.degraded || !this.ftsAvailable || limit <= 0) return [];
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    try {
      const rows = this.stmtL0FtsSearch.all(ftsQuery, limit);
      return rows.map((r) => ({
        sessionId: r.session_id,
        recordedAt: r.recorded_at,
        id: r.record_id,
        role: r.role,
        content: r.message_text,
        timestamp: r.timestamp ?? 0,
        score: bm25RankToScore(r.rank)
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} L0 FTS \u68C0\u7D22\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  searchL0Vector(embedding, topK) {
    if (this.degraded || !this.stmtSearchL0Vec) return [];
    try {
      const retrieveCount = topK + ZERO_VEC_BUFFER;
      const rows = this.stmtSearchL0Vec.all(vecToBuffer(embedding), retrieveCount);
      const hits = [];
      for (const { record_id, distance } of rows) {
        if (distance == null || Number.isNaN(distance)) continue;
        const row = this.stmtGetL0.get(record_id);
        if (!row) continue;
        hits.push({
          sessionId: row.session_id,
          recordedAt: row.recorded_at,
          id: record_id,
          role: row.role,
          content: row.message_text,
          timestamp: row.timestamp ?? 0,
          score: 1 - distance
        });
      }
      return hits.slice(0, topK);
    } catch (err) {
      this.logger?.warn(`${TAG} L0 \u5411\u91CF\u68C0\u7D22\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  // ============================
  // 重嵌入（reindexAll 用）
  // ============================
  /** L1 缺失向量的记录数（排除 skip 集后的补齐判据；向量能力不可用返回 -1）。 */
  countL1VecMissing(exclude) {
    if (this.degraded || !this.stmtSearchL1Vec) return -1;
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM l1_records r
           LEFT JOIN l1_vec v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause("r.record_id", exclude)}`
      ).all(...notInParams(exclude))[0];
      return row?.n ?? 0;
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u7F3A\u5931\u5411\u91CF\u8BA1\u6570\u5931\u8D25\uFF08\u8865\u9F50\u5224\u636E\u6309\u65E0\u7F3A\u5931\u5904\u7406\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    }
  }
  /** L0 缺失向量的记录数（同上）。 */
  countL0VecMissing(exclude) {
    if (this.degraded || !this.stmtSearchL0Vec) return -1;
    try {
      const row = this.db.prepare(
        `SELECT COUNT(*) AS n FROM l0_conversations r
           LEFT JOIN l0_vec v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause("r.record_id", exclude)}`
      ).all(...notInParams(exclude))[0];
      return row?.n ?? 0;
    } catch (err) {
      this.logger?.warn(`${TAG} L0 \u7F3A\u5931\u5411\u91CF\u8BA1\u6570\u5931\u8D25\uFF08\u8865\u9F50\u5224\u636E\u6309\u65E0\u7F3A\u5931\u5904\u7406\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return -1;
    }
  }
  /**
   * 待重嵌入的 L1：只取缺失向量的记录（增量），排除 skip 集里已判定
   * "当前 provider 下不可嵌入（零向量）"的 id——缺 1 条不再全量重嵌，
   * 零向量记录也不再反复喂给 embeddings API（H1 死循环双根因）。
   */
  getL1ForReindex(exclude) {
    if (this.degraded) return [];
    try {
      return this.db.prepare(
        `SELECT r.record_id AS id, r.content FROM l1_records r
           LEFT JOIN l1_vec v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause("r.record_id", exclude)}`
      ).all(...notInParams(exclude));
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u91CD\u5D4C\u5165\u53D6\u6570\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF0C\u672C\u8F6E\u8DF3\u8FC7\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  /** 待重嵌入的 L0（增量 + 排除 skip 集，同 getL1ForReindex）。 */
  getL0ForReindex(exclude) {
    if (this.degraded) return [];
    try {
      return this.db.prepare(
        `SELECT r.record_id AS id, r.message_text AS text FROM l0_conversations r
           LEFT JOIN l0_vec v ON v.record_id = r.record_id
           WHERE v.record_id IS NULL${notInClause("r.record_id", exclude)}`
      ).all(...notInParams(exclude));
    } catch (err) {
      this.logger?.warn(`${TAG} L0 \u91CD\u5D4C\u5165\u53D6\u6570\u5931\u8D25\uFF08\u8FD4\u56DE\u7A7A\uFF0C\u672C\u8F6E\u8DF3\u8FC7\uFF09: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }
  // ── 零向量 skip 集（embedding_meta 持久化；provider 变化时随向量表一起清空） ──
  getVecSkipSet(kind) {
    if (this.degraded) return /* @__PURE__ */ new Set();
    try {
      const row = this.db.prepare("SELECT value FROM embedding_meta WHERE key = ?").get(vecSkipKey(kind));
      if (!row) return /* @__PURE__ */ new Set();
      const parsed = JSON.parse(row.value);
      if (!Array.isArray(parsed)) return /* @__PURE__ */ new Set();
      return new Set(parsed.filter((x) => typeof x === "string"));
    } catch {
      return /* @__PURE__ */ new Set();
    }
  }
  addVecSkippedIds(kind, ids) {
    if (this.degraded || ids.length === 0) return;
    try {
      let merged = [.../* @__PURE__ */ new Set([...this.getVecSkipSet(kind), ...ids])];
      if (merged.length > VEC_SKIP_CAP) {
        merged = merged.slice(-VEC_SKIP_CAP);
        this.logger?.warn(`${TAG} skip \u96C6\u8FBE\u4E0A\u9650 ${VEC_SKIP_CAP}\uFF08\u96F6\u5411\u91CF\u8BB0\u5F55\u8FC7\u591A\uFF0Cembedding \u670D\u52A1\u7591\u4F3C\u5F02\u5E38\uFF09`);
      }
      this.db.prepare("INSERT INTO embedding_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(vecSkipKey(kind), JSON.stringify(merged));
    } catch (err) {
      this.logger?.warn(`${TAG} skip \u96C6\u5199\u5165\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  clearVecSkipIds(kind) {
    if (this.degraded) return;
    try {
      this.db.prepare("DELETE FROM embedding_meta WHERE key = ?").run(vecSkipKey(kind));
    } catch {
    }
  }
  /** 只更新向量行（重嵌入用）。 */
  updateL1Vec(id, embedding) {
    if (this.degraded || !this.stmtDeleteL1Vec || !this.stmtInsertL1Vec) return false;
    if (isZeroVector(embedding)) return false;
    try {
      this.stmtDeleteL1Vec.run(id);
      this.stmtInsertL1Vec.run(id, vecToBuffer(embedding), (/* @__PURE__ */ new Date()).toISOString());
      return true;
    } catch {
      return false;
    }
  }
  updateL0Vec(id, embedding, recordedAt) {
    if (this.degraded || !this.stmtDeleteL0Vec || !this.stmtInsertL0Vec) return false;
    if (isZeroVector(embedding)) return false;
    try {
      this.stmtDeleteL0Vec.run(id);
      this.stmtInsertL0Vec.run(id, vecToBuffer(embedding), recordedAt);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * 批量更新 L1 向量行（重嵌入热路径）：单事务写入整批，替代逐条裸写——
   * 逐条每行一次隐式事务，批量场景（万级记录重嵌）开销集中在 fsync 上。
   * 整批失败回退逐条：好行照常入库，坏行只丢自身（向量行 id 寻址，无顺序依赖）。
   * 返回成功写入的行数（零向量行防御性跳过、不计入）。
   */
  updateL1VecBatch(items) {
    if (this.degraded || !this.stmtDeleteL1Vec || !this.stmtInsertL1Vec || items.length === 0) return 0;
    try {
      this.db.exec("BEGIN");
      try {
        let written = 0;
        for (const it of items) {
          if (isZeroVector(it.embedding)) continue;
          this.stmtDeleteL1Vec.run(it.id);
          this.stmtInsertL1Vec.run(it.id, vecToBuffer(it.embedding), (/* @__PURE__ */ new Date()).toISOString());
          written++;
        }
        this.db.exec("COMMIT");
        return written;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`${TAG} L1 \u5411\u91CF\u6279\u91CF\u5199\u5165\u5931\u8D25\uFF0C\u56DE\u9000\u9010\u6761: ${err instanceof Error ? err.message : String(err)}`);
      let ok = 0;
      for (const it of items) if (this.updateL1Vec(it.id, it.embedding)) ok++;
      return ok;
    }
  }
  /** L0 版 updateL1VecBatch（语义同：单事务 + 失败回退逐条）。recordedAt 整批统一。 */
  updateL0VecBatch(items, recordedAt) {
    if (this.degraded || !this.stmtDeleteL0Vec || !this.stmtInsertL0Vec || items.length === 0) return 0;
    try {
      this.db.exec("BEGIN");
      try {
        let written = 0;
        for (const it of items) {
          if (isZeroVector(it.embedding)) continue;
          this.stmtDeleteL0Vec.run(it.id);
          this.stmtInsertL0Vec.run(it.id, vecToBuffer(it.embedding), recordedAt);
          written++;
        }
        this.db.exec("COMMIT");
        return written;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
        }
        throw err;
      }
    } catch (err) {
      this.logger?.warn(`${TAG} L0 \u5411\u91CF\u6279\u91CF\u5199\u5165\u5931\u8D25\uFF0C\u56DE\u9000\u9010\u6761: ${err instanceof Error ? err.message : String(err)}`);
      let ok = 0;
      for (const it of items) if (this.updateL0Vec(it.id, it.embedding, recordedAt)) ok++;
      return ok;
    }
  }
  close() {
    try {
      this.db.close();
    } catch {
    }
  }
}
function rowToRecord(row) {
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json || "{}");
  } catch {
  }
  return {
    id: row.record_id,
    content: row.content,
    type: row.type,
    priority: row.priority,
    scene_name: row.scene_name,
    sessionId: row.session_id || void 0,
    timestamps: dbToTimestamps(row.timestamp_str),
    createdAt: Date.parse(row.created_time) || 0,
    updatedAt: Date.parse(row.updated_time) || 0,
    version: row.version ?? 0,
    metadata,
    family: normFamily(row.family, row.type)
  };
}
function timestampsToDb(ts) {
  if (!ts || ts.length === 0) return { str: "", start: "", end: "" };
  const sorted = [...ts].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  if (sorted.length === 0) return { str: "", start: "", end: "" };
  const isos = sorted.map((t) => new Date(t).toISOString());
  return { str: isos.join(","), start: isos[0], end: isos[isos.length - 1] };
}
function dbToTimestamps(str) {
  if (!str) return [];
  return str.split(",").map((t) => Date.parse(t)).filter((t) => !Number.isNaN(t));
}
function toIso(epochMs) {
  if (!epochMs || !Number.isFinite(epochMs)) return "";
  return new Date(epochMs).toISOString();
}
function isZeroVector(vec) {
  for (const v of vec) {
    if (v !== 0) return false;
  }
  return true;
}
function notInClause(column, exclude) {
  if (!exclude || exclude.size === 0) return "";
  return ` AND ${column} NOT IN (${[...exclude].map(() => "?").join(",")})`;
}
function notInParams(exclude) {
  if (!exclude || exclude.size === 0) return [];
  return [...exclude];
}
function vecSkipKey(kind) {
  return kind === "l1" ? "embedding_zero_vec_l1" : "embedding_zero_vec_l0";
}
function normFamily(raw, type) {
  if (raw === "work" || raw === "chat") return raw;
  return familyForType(type);
}
function vecToBuffer(vec) {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
export {
  MemoryDb,
  isZeroVector
};

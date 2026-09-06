import { promises as fs } from "node:fs";
import * as path from "node:path";
import { NoopEmbeddingService, RemoteEmbeddingService } from "./embedding.js";
import { catalogById, MODEL_CATALOG } from "./model-catalog.js";
import { LocalEmbeddingService } from "./local-embedding.js";
class EmbeddingSourceStore {
  state = { source: "remote", activeModel: null };
  file;
  writeQueue = Promise.resolve();
  logger;
  constructor(dataDir, logger) {
    this.file = path.join(dataDir, "embedding-source.json");
    this.logger = logger;
  }
  get() {
    return { ...this.state };
  }
  async init() {
    try {
      const raw = await fs.readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      if ((parsed.source === "remote" || parsed.source === "local" || parsed.source === "off") && (parsed.activeModel === null || typeof parsed.activeModel === "string")) {
        this.state = { source: parsed.source, activeModel: parsed.activeModel };
      } else {
        this.logger?.warn("[memory] \u5D4C\u5165\u6E90\u72B6\u6001\u6587\u4EF6\u635F\u574F\uFF0C\u6309\u9ED8\u8BA4 remote \u8D77\u6B65");
      }
    } catch {
    }
  }
  async set(next) {
    this.state = { source: next.source, activeModel: next.activeModel };
    this.writeQueue = this.writeQueue.then(() => this.persist()).catch(() => {
    });
    await this.writeQueue;
  }
  async persist() {
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.state, null, 2), "utf8");
    await fs.rename(tmp, this.file);
  }
}
function remoteCeiling(cfg) {
  const e = cfg.embedding;
  return e.enabled && !!e.baseUrl && !!e.apiKey && !!e.model && e.dimensions > 0;
}
async function resolveInitialEmbedding(cfg, sourceStore, downloader, makeLocal, logger) {
  const state = sourceStore.get();
  if (state.source === "off") {
    return { svc: new NoopEmbeddingService(), dims: 0 };
  }
  if (state.source === "local") {
    if (!cfg.embedding.allowLocalModels) {
      logger?.warn("[memory] \u5D4C\u5165\u6E90\u4E3A local \u4F46\u90E8\u7F72\u5DF2\u7981\u7528\u672C\u5730\u6A21\u578B\uFF08allowLocalModels=false\uFF09\uFF0C\u672C\u6B21\u8FD0\u884C\u7EAF FTS");
      return { svc: new NoopEmbeddingService(), dims: 0, note: "\u90E8\u7F72\u914D\u7F6E\u5DF2\u7981\u7528\u672C\u5730\u5D4C\u5165\u6A21\u578B" };
    }
    const entry = state.activeModel ? catalogById(state.activeModel) : void 0;
    if (!entry) {
      logger?.warn(`[memory] \u5D4C\u5165\u6E90 local \u7684\u6A21\u578B ${state.activeModel} \u4E0D\u5728\u76EE\u5F55\uFF0C\u672C\u6B21\u8FD0\u884C\u7EAF FTS`);
      return { svc: new NoopEmbeddingService(), dims: 0, note: "\u542F\u7528\u7684\u6A21\u578B\u4E0D\u5728\u5185\u7F6E\u76EE\u5F55" };
    }
    if (!await downloader.isDownloaded(entry.id)) {
      logger?.warn(`[memory] \u672C\u5730\u6A21\u578B ${entry.id} \u6587\u4EF6\u7F3A\u5931\uFF08\u53EF\u80FD\u88AB\u6E05\u7406\uFF09\uFF0C\u672C\u6B21\u8FD0\u884C\u7EAF FTS`);
      return { svc: new NoopEmbeddingService(), dims: 0, note: "\u6A21\u578B\u6587\u4EF6\u7F3A\u5931\uFF0C\u8BF7\u91CD\u65B0\u4E0B\u8F7D" };
    }
    const svc2 = makeLocal(entry.id);
    if (!svc2) return { svc: new NoopEmbeddingService(), dims: 0, note: "\u672C\u5730\u670D\u52A1\u6784\u9020\u5931\u8D25" };
    return { svc: svc2, dims: entry.dims, providerInfo: { provider: "local", model: entry.id, dimensions: entry.dims } };
  }
  if (!remoteCeiling(cfg)) {
    return { svc: new NoopEmbeddingService(), dims: 0 };
  }
  const svc = new RemoteEmbeddingService({
    baseUrl: cfg.embedding.baseUrl,
    apiKey: cfg.embedding.apiKey,
    model: cfg.embedding.model,
    dimensions: cfg.embedding.dimensions,
    maxInputChars: cfg.embedding.maxInputChars,
    timeoutMs: cfg.embedding.timeoutMs,
    logger
  });
  return { svc, dims: cfg.embedding.dimensions, providerInfo: svc.getProviderInfo() };
}
function makeLocalServiceFactory(installer, downloader, logger, maxInputChars) {
  return (modelId) => {
    const entry = catalogById(modelId);
    if (!entry) return null;
    return new LocalEmbeddingService(entry, downloader.modelsDir(entry.id), {
      runtimeDir: installer.runtimeDir,
      logger,
      maxInputChars
    });
  };
}
class EmbeddingManager {
  sourceStore;
  installer;
  downloader;
  deps;
  current;
  localSvc = null;
  applyPhase = "idle";
  applyMessage = "";
  applyStartedAt = 0;
  applyBusy = false;
  reindex = {
    running: false,
    l1Done: 0,
    l1Total: 0,
    l0Done: 0,
    l0Total: 0,
    startedAt: 0,
    cancelled: false
  };
  reindexCancel = false;
  /** 停机标志：dispose 后应用链不再推进（防卸载后的孤儿重嵌/安装）。 */
  disposedFlag = false;
  /** 当前生效目标的 providerInfo（backfill/启动链的 meta 写入用——杜绝陈旧闭包）。 */
  currentInfo;
  /** 初始解析的降级说明（活切换成功后清空，防过期提示常驻）。 */
  activeNote;
  constructor(deps) {
    this.deps = deps;
    this.sourceStore = deps.sourceStore;
    this.installer = deps.installer;
    this.downloader = deps.downloader;
    this.current = deps.initial.svc;
    this.currentInfo = deps.initial.providerInfo;
    this.activeNote = deps.initial.note;
    if (deps.initial.providerInfo?.provider === "local") {
      this.localSvc = this.current;
      this.localSvc.startWarmup();
    }
  }
  /** 当前目标的 providerInfo（index.ts 的启动重嵌链/周期 backfill 写 meta 用）。 */
  currentProviderInfo() {
    return this.currentInfo;
  }
  /** 取消运行时安装（RPC：npm 卡死/用户主动放弃）。 */
  cancelRuntimeInstall() {
    return this.installer.cancel();
  }
  /** 当前生效服务（index.ts 初始建 store 用）。 */
  getService() {
    return this.current;
  }
  /** 构造绑定真实运行时 loader 的本地服务（deps.makeLocal 可注入，测试替换）。 */
  makeLocalService(modelId) {
    const factory = this.deps.makeLocal ?? makeLocalServiceFactory(this.installer, this.downloader, this.deps.logger, this.deps.cfg.embedding.maxInputChars);
    return factory(modelId);
  }
  /** 活切换请求：验证通过即接受，后台执行应用链（进度轮询可见）。 */
  requestSource(next) {
    if (this.applyBusy) return { accepted: false, error: "\u5207\u6362\u8FDB\u884C\u4E2D\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210" };
    if (next.source === "remote" && !remoteCeiling(this.deps.cfg)) {
      return { accepted: false, error: "\u90E8\u7F72\u672A\u914D\u7F6E\u8FDC\u7A0B\u5D4C\u5165\uFF08baseUrl/apiKey/model/dimensions \u6216 enabled\uFF09\uFF0C\u8FDC\u7A0B\u6863\u4E0D\u53EF\u9009" };
    }
    if (next.source === "local") {
      if (!this.deps.cfg.embedding.allowLocalModels) {
        return { accepted: false, error: "\u90E8\u7F72\u5DF2\u7981\u7528\u672C\u5730\u5D4C\u5165\u6A21\u578B\uFF08allowLocalModels=false\uFF09" };
      }
      if (!next.activeModel || !catalogById(next.activeModel)) {
        return { accepted: false, error: "\u8BF7\u9009\u62E9\u5185\u7F6E\u76EE\u5F55\u4E2D\u7684\u6A21\u578B" };
      }
    }
    const state = {
      source: next.source,
      activeModel: next.source === "local" ? next.activeModel : null
    };
    this.applyBusy = true;
    this.applyStartedAt = Date.now();
    this.applyMessage = "";
    void this.applyChain(state).finally(() => {
      this.applyBusy = false;
    });
    return { accepted: true };
  }
  /** 下载启动（串行队列忙时拒绝）；完成后自动做一次可加载性预热验证（D6）。 */
  startDownload(modelId) {
    if (!this.deps.cfg.embedding.allowLocalModels) {
      return { ok: false, error: "\u90E8\u7F72\u5DF2\u7981\u7528\u672C\u5730\u5D4C\u5165\u6A21\u578B" };
    }
    if (!catalogById(modelId)) return { ok: false, error: "\u672A\u77E5\u6A21\u578B" };
    if (this.downloader.isBusy()) return { ok: false, error: "\u5DF2\u6709\u4E0B\u8F7D\u4EFB\u52A1\u8FDB\u884C\u4E2D" };
    void this.downloader.start(modelId).then(async (p) => {
      if (p.phase !== "done") return;
      if (this.sourceStore.get().source === "local" && this.sourceStore.get().activeModel === modelId) {
        this.localSvc?.startWarmup();
        return;
      }
      const scratch = this.makeLocalService(modelId);
      if (!scratch) return;
      if (await this.installer.isReady()) {
        scratch.startWarmup();
        void scratch.waitForReady().then(
          () => scratch.close(),
          () => scratch.close()
        );
      }
    }).catch(() => {
    });
    return { ok: true };
  }
  cancelDownload() {
    return this.downloader.cancel();
  }
  async deleteModel(modelId) {
    const state = this.sourceStore.get();
    if (state.source === "local" && state.activeModel === modelId) {
      return { ok: false, error: "\u8BE5\u6A21\u578B\u6B63\u5728\u4F7F\u7528\u4E2D\uFF0C\u8BF7\u5148\u5207\u6362\u5D4C\u5165\u6E90" };
    }
    return this.downloader.deleteModel(modelId);
  }
  cancelReindex() {
    if (!this.reindex.running) return false;
    this.reindexCancel = true;
    return true;
  }
  /** 应用链/后台任务是否在跑（backfill 并发门禁用）。 */
  isBusy() {
    return this.applyBusy || this.reindex.running || this.downloader.isBusy();
  }
  /** 停机钩子（插件 dispose）：取消 npm 安装、下载与重嵌——不留后台孤儿任务。 */
  dispose() {
    this.disposedFlag = true;
    this.installer.cancel();
    this.downloader.cancel();
    this.cancelReindex();
    this.localSvc?.close();
  }
  async applyChain(next) {
    try {
      let svc;
      let providerInfo;
      if (next.source === "off") {
        this.applyPhase = "switching";
        svc = new NoopEmbeddingService();
        providerInfo = void 0;
        this.currentInfo = void 0;
      } else if (next.source === "remote") {
        this.applyPhase = "switching";
        svc = new RemoteEmbeddingService({
          baseUrl: this.deps.cfg.embedding.baseUrl,
          apiKey: this.deps.cfg.embedding.apiKey,
          model: this.deps.cfg.embedding.model,
          dimensions: this.deps.cfg.embedding.dimensions,
          maxInputChars: this.deps.cfg.embedding.maxInputChars,
          timeoutMs: this.deps.cfg.embedding.timeoutMs,
          logger: this.deps.logger
        });
        providerInfo = svc.getProviderInfo();
      } else {
        if (!await this.downloader.isDownloaded(next.activeModel)) {
          throw new Error("\u6A21\u578B\u6587\u4EF6\u4E0D\u5B8C\u6574\uFF08\u672A\u4E0B\u8F7D\u6216\u5DF2\u635F\u574F\uFF09\uFF0C\u8BF7\u5148\u5B8C\u6210\u4E0B\u8F7D");
        }
        if (!await this.installer.isReady()) {
          this.applyPhase = "installing-runtime";
          const ok = await this.installer.ensure();
          if (!ok) {
            throw new Error(`\u8FD0\u884C\u65F6\u5B89\u88C5\u5931\u8D25: ${this.installer.getProgress().error ?? "\u672A\u77E5\u539F\u56E0"}`);
          }
        }
        if (this.disposedFlag) throw new Error("\u63D2\u4EF6\u5DF2\u5378\u8F7D\uFF0C\u5207\u6362\u4E2D\u6B62");
        this.applyPhase = "warming";
        const local = this.makeLocalService(next.activeModel);
        if (!local) throw new Error("\u6A21\u578B\u4E0D\u5728\u76EE\u5F55");
        await local.waitForReady();
        svc = local;
        providerInfo = local.getProviderInfo();
        this.applyPhase = "switching";
      }
      let needsReindex = false;
      if (providerInfo) {
        const swap = this.deps.db.swapProvider(providerInfo);
        if (!swap.ok) throw new Error(swap.error ?? "\u5207\u6362\u5411\u91CF\u5F15\u64CE\u5931\u8D25");
        needsReindex = swap.needsReindex;
        this.deps.db.markEmbeddingSynced(providerInfo);
        this.currentInfo = providerInfo;
      }
      const oldLocal = this.localSvc;
      this.localSvc = next.source === "local" ? svc : null;
      this.current = svc;
      this.deps.l0.setEmbeddingService(svc);
      this.deps.l1.setEmbeddingService(svc);
      oldLocal?.close();
      let pendingNote = "";
      if (needsReindex) {
        if (this.disposedFlag) throw new Error("\u63D2\u4EF6\u5DF2\u5378\u8F7D\uFF0C\u91CD\u5D4C\u5165\u4E2D\u6B62");
        this.applyPhase = "reindexing";
        const result = await this.reindexNow();
        if (result.cancelled) {
          pendingNote = "\uFF1B\u91CD\u5D4C\u5165\u5DF2\u53D6\u6D88\uFF0C\u7F3A\u5931\u5411\u91CF\u7531\u5468\u671F\u4EFB\u52A1\u8865\u9F50";
          this.deps.logger.warn("[memory] \u91CD\u5D4C\u5165\u5DF2\u53D6\u6D88\uFF0C\u7F3A\u5931\u5411\u91CF\u5C06\u7531\u5468\u671F\u8865\u9F50\uFF08\u68C0\u7D22\u6682\u6309\u5173\u952E\u8BCD\u964D\u7EA7\uFF09");
        } else if (result.failedTotal > 0) {
          pendingNote = `\uFF1B${result.failedTotal} \u6761\u5411\u91CF\u5F85\u8865\u9F50\uFF08\u5468\u671F\u4EFB\u52A1\u4F1A\u8865\uFF09`;
        }
        if (result.error) throw new Error(result.error);
      }
      await this.sourceStore.set(next);
      this.activeNote = void 0;
      this.applyPhase = "done";
      this.applyMessage = next.source === "off" ? "\u5DF2\u5207\u6362\u4E3A\u5173\u952E\u8BCD\u68C0\u7D22" : "\u5207\u6362\u5B8C\u6210" + pendingNote;
    } catch (err) {
      this.applyPhase = "error";
      this.applyMessage = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`[memory] \u5D4C\u5165\u6E90\u5207\u6362\u5931\u8D25\uFF08\u72B6\u6001\u4FDD\u6301\u4E0D\u53D8\uFF09: ${this.applyMessage}`);
    }
  }
  async reindexNow() {
    this.reindexCancel = false;
    this.reindex = { running: true, l1Done: 0, l1Total: 0, l0Done: 0, l0Total: 0, startedAt: Date.now(), cancelled: false };
    let failedTotal = 0;
    try {
      const r1 = await this.deps.l1.reindex({
        onProgress: (done, total) => {
          this.reindex.l1Done = done;
          this.reindex.l1Total = total;
        },
        shouldCancel: () => this.reindexCancel
      });
      failedTotal += r1.failed;
      const r0 = await this.deps.l0.reindex({
        onProgress: (done, total) => {
          this.reindex.l0Done = done;
          this.reindex.l0Total = total;
        },
        shouldCancel: () => this.reindexCancel
      });
      failedTotal += r0.failed;
      const cancelled = !!(r1.cancelled || r0.cancelled);
      this.reindex.cancelled = cancelled;
      this.reindex.running = false;
      return { cancelled, failedTotal };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.reindex.running = false;
      this.reindex.error = message;
      return { cancelled: false, failedTotal, error: `\u91CD\u5D4C\u5165\u5931\u8D25: ${message}` };
    }
  }
  /** RPC 快照（设置页嵌入区块数据源；client 忙时 1s 轮询）。 */
  async snapshot() {
    const status = await this.downloader.listStatus();
    const models = MODEL_CATALOG.map((entry) => {
      const s = status.find((x) => x.id === entry.id);
      return {
        id: entry.id,
        name: entry.name,
        dims: entry.dims,
        contextTokens: entry.contextTokens,
        tags: entry.tags,
        description: entry.description,
        totalBytes: s?.totalBytes ?? 0,
        bytesOnDisk: s?.bytesOnDisk ?? 0,
        state: s?.state ?? "none"
      };
    });
    const state = this.sourceStore.get();
    return {
      source: state.source,
      activeModel: state.activeModel,
      ceilings: { remote: remoteCeiling(this.deps.cfg), local: this.deps.cfg.embedding.allowLocalModels },
      runtime: this.installer.getProgress(),
      models,
      download: this.downloader.getProgress(),
      apply: { phase: this.applyPhase, message: this.applyMessage, startedAt: this.applyStartedAt, busy: this.applyBusy },
      local: this.localSvc ? { state: this.localSvc.getState(), error: this.localSvc.getLoadError() } : null,
      reindex: { ...this.reindex },
      activeNote: this.activeNote
    };
  }
}
export {
  EmbeddingManager,
  EmbeddingSourceStore,
  makeLocalServiceFactory,
  remoteCeiling,
  resolveInitialEmbedding
};

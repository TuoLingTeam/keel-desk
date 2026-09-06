import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
function defaultWorkerPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "embedding-worker.cjs");
}
class RealWorkerChannel {
  worker;
  pending = /* @__PURE__ */ new Map();
  nextId = 1;
  terminated = false;
  crashed;
  crashCb;
  constructor(workerPath, workerData) {
    this.worker = new Worker(workerPath, { workerData });
    this.worker.on("message", (msg) => {
      if (msg && msg.type === "fatal") {
        this.failAll(`\u672C\u5730\u5D4C\u5165 worker \u81F4\u547D\u9519\u8BEF: ${msg.error ?? "\u672A\u77E5"}`);
        return;
      }
      const id = msg.id;
      if (typeof id !== "number") return;
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      entry.resolve(msg);
    });
    this.worker.on("error", (err) => this.failAll(`\u672C\u5730\u5D4C\u5165 worker \u7EBF\u7A0B\u9519\u8BEF: ${err.message}`));
    this.worker.on("exit", (code) => {
      if (!this.terminated) this.failAll(`\u672C\u5730\u5D4C\u5165 worker \u7EBF\u7A0B\u9000\u51FA\uFF08code=${code}\uFF09`);
    });
  }
  request(call) {
    if (this.terminated) return Promise.reject(new Error("\u5D4C\u5165 worker \u5DF2\u91CA\u653E"));
    if (this.crashed) return Promise.reject(new Error(this.crashed));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...call, id });
    });
  }
  terminate() {
    if (this.terminated) return;
    this.terminated = true;
    this.failAll("\u5D4C\u5165 worker \u5DF2\u91CA\u653E");
    void this.worker.terminate();
  }
  setOnCrash(cb) {
    this.crashCb = cb;
    if (this.crashed) cb(this.crashed);
  }
  failAll(error) {
    for (const [, entry] of this.pending) entry.reject(new Error(error));
    this.pending.clear();
    if (!this.terminated && !this.crashed) {
      this.crashed = error;
      this.crashCb?.(error);
    }
  }
}
class LocalEmbeddingService {
  state = "idle";
  loadError = null;
  channel;
  entry;
  logger;
  constructor(entry, modelDir, opts) {
    this.entry = entry;
    this.logger = opts.logger;
    const maxInputChars = opts.maxInputChars && opts.maxInputChars > 0 ? opts.maxInputChars : 5e3;
    this.channel = opts.channel ?? new RealWorkerChannel(opts.workerPath ?? defaultWorkerPath(), {
      runtimeDir: opts.runtimeDir,
      modelDir,
      pooling: entry.pooling,
      dtype: "q8",
      maxInputChars
    });
    this.channel.setOnCrash((error) => {
      if (this.state === "terminated") return;
      this.state = "failed";
      this.loadError = error;
      this.logger?.warn(`[memory] ${error}\uFF08\u672C\u5730\u5D4C\u5165\u8F6C\u5165 failed \u6001\uFF0C\u6362\u6E90\u6216\u91CD\u542F\u53EF\u6062\u590D\uFF09`);
    });
  }
  getDimensions() {
    return this.entry.dims;
  }
  getProviderInfo() {
    return { provider: "local", model: this.entry.id, dimensions: this.entry.dims };
  }
  isReady() {
    return this.state === "ready";
  }
  /** 状态（进度展示用）。 */
  getState() {
    return this.state;
  }
  getLoadError() {
    return this.loadError;
  }
  /** 后台预热：启动后让 worker 立即加载模型（幂等；失败态可重试）。 */
  startWarmup() {
    void this.waitForReady().catch(() => {
    });
  }
  /** 等待模型就绪（warmup 协议；applyChain 的 warming 阶段与测试用）。 */
  async waitForReady() {
    if (this.state === "ready") return;
    if (this.state === "terminated") {
      throw new Error("\u672C\u5730\u5D4C\u5165\u670D\u52A1\u5DF2\u91CA\u653E\uFF08\u5D4C\u5165\u6E90\u5DF2\u5207\u6362\uFF09\uFF1B\u672C\u5B9E\u4F8B\u4E0D\u53EF\u590D\u7528");
    }
    if (this.state !== "failed") this.state = "loading";
    const reply = await this.channel.request({ type: "warmup" });
    if (!reply.ok) {
      this.applyLoadFailure(reply.error);
      throw new Error(reply.error);
    }
    this.markReady();
  }
  async embed(text, callOpts) {
    const [vec] = await this.embedBatch([text], callOpts);
    return vec;
  }
  async embedBatch(texts, callOpts) {
    if (texts.length === 0) return [];
    if (this.state === "terminated") {
      throw new Error("\u672C\u5730\u5D4C\u5165\u670D\u52A1\u5DF2\u91CA\u653E\uFF08\u5D4C\u5165\u6E90\u5DF2\u5207\u6362\uFF09\uFF1B\u672C\u5B9E\u4F8B\u4E0D\u53EF\u590D\u7528");
    }
    if (this.state === "failed") {
      throw new Error(`\u672C\u5730\u5D4C\u5165\u6A21\u578B\u52A0\u8F7D\u5931\u8D25: ${this.loadError ?? "\u672A\u77E5\u539F\u56E0"}\uFF08\u91CD\u542F\u63D2\u4EF6\u6216\u91CD\u65B0\u4E0B\u8F7D\u6A21\u578B\u53EF\u91CD\u8BD5\uFF09`);
    }
    if (this.state !== "ready") this.state = "loading";
    const reply = await this.requestWithTimeout(
      { type: "embed", texts, priority: texts.length === 1 },
      callOpts?.timeoutMs
    );
    if (!reply.ok) {
      if (reply.stage === "load") this.applyLoadFailure(reply.error);
      else this.markReady();
      throw new Error(reply.error);
    }
    if (reply.type !== "embedded") throw new Error(`\u5D4C\u5165 worker \u8FD4\u56DE\u5F02\u5E38\u6D88\u606F\u7C7B\u578B: ${reply.type}`);
    this.markReady();
    for (const v of reply.vectors) {
      if (v.length !== this.entry.dims) {
        throw new Error(`\u672C\u5730\u5D4C\u5165\u7EF4\u5EA6\u4E0D\u5339\u914D\uFF1A\u671F\u671B ${this.entry.dims}\uFF0C\u5F97\u5230 ${v.length}`);
      }
    }
    return reply.vectors;
  }
  /** 释放 worker 线程与模型（嵌入源切走/关闭时调用；幂等）。terminated 后不可
   *  再复用——防止插件卸载/切走后残留的重嵌循环把模型重新加载常驻（内存泄漏）。 */
  close() {
    this.state = "terminated";
    this.loadError = null;
    this.channel.terminate();
  }
  /** 内层钳制（仅缩短）：超时放弃等待（迟到回复由通道按 id 丢弃），调用方降级。 */
  async requestWithTimeout(call, timeoutMs) {
    if (!(timeoutMs && timeoutMs > 0)) return this.channel.request(call);
    let timer;
    try {
      return await Promise.race([
        this.channel.request(call),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`\u672C\u5730\u5D4C\u5165\u8C03\u7528\u8D85\u65F6\uFF08${timeoutMs}ms\uFF09\uFF0C\u5DF2\u653E\u5F03\u7B49\u5F85`)), timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /** loading → ready 一次性日志（memory.log 时序可读性：启动到模型就绪的间隔）。 */
  markReady() {
    if (this.state === "ready") return;
    this.state = "ready";
    this.logger?.info(
      `[memory] \u672C\u5730\u5D4C\u5165\u6A21\u578B\u5C31\u7EEA: ${this.entry.id}\uFF08dims=${this.entry.dims}\uFF0Cpooling=${this.entry.pooling}\uFF09`
    );
  }
  applyLoadFailure(error) {
    this.state = "failed";
    this.loadError = error;
    this.logger?.warn(`[memory] \u672C\u5730\u5D4C\u5165\u6A21\u578B\u52A0\u8F7D\u5931\u8D25\uFF08${this.entry.id}\uFF09: ${error}`);
  }
}
export {
  LocalEmbeddingService
};

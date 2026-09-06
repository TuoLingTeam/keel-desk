import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const nodeRequire = createRequire(fileURLToPath(import.meta.url));
function loadUndici() {
  try {
    return nodeRequire("undici");
  } catch {
    return null;
  }
}
import { catalogById, catalogTotalBytes, MODEL_CATALOG } from "./model-catalog.js";
const DISK_HEADROOM = 1.2;
class ModelDownloadQueue {
  dataDir;
  opts;
  progress = null;
  busy = false;
  abort = null;
  /** 代理 dispatcher（按需创建；dispose 关闭连接池）。 */
  agent;
  /** 默认 fetch：优先 undici（可挂代理）；缺失时回退全局 fetch。 */
  defaultFetch;
  constructor(dataDir, opts) {
    this.dataDir = dataDir;
    this.opts = opts;
    const undici = loadUndici();
    let host = "";
    try {
      host = new URL(this.mirrorUrl()).host;
    } catch {
    }
    const proxy = resolveProxyUrl(opts.proxy, host);
    if (proxy && undici?.ProxyAgent) {
      try {
        this.agent = new undici.ProxyAgent(proxy);
        opts.logger?.info(`[memory] \u6A21\u578B\u4E0B\u8F7D\u8D70\u4EE3\u7406 ${maskProxyUrl(proxy)}\uFF08\u955C\u50CF\u76F4\u8FDE\u5728\u56FD\u5185\u7F51\u7EDC\u95F4\u6B47\u4E0D\u53EF\u8FBE\uFF09`);
      } catch (err) {
        opts.logger?.warn(
          `[memory] \u4EE3\u7406\u914D\u7F6E\u65E0\u6548\uFF0C\u5DF2\u5FFD\u7565\u5E76\u76F4\u8FDE\uFF08${maskProxyUrl(proxy)}\uFF09: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } else if (proxy && !undici?.ProxyAgent) {
      opts.logger?.warn("[memory] undici \u4E0D\u53EF\u7528\uFF0C\u6A21\u578B\u4E0B\u8F7D\u4E0D\u8D70\u4EE3\u7406\u3001\u6539\u7528\u5168\u5C40 fetch");
    }
    const undiciFetch = undici?.fetch;
    this.defaultFetch = ((u, init) => {
      if (undiciFetch) {
        const dispatch = this.agent;
        return undiciFetch(u, { ...init, ...dispatch ? { dispatcher: dispatch } : {} });
      }
      return fetch(u, init);
    });
  }
  /** 镜像根（无尾斜杠）。 */
  mirrorUrl() {
    return this.opts.mirror.replace(/\/+$/, "");
  }
  /** 释放代理连接池（插件 dispose 链调用；无代理时幂等无操作）。 */
  dispose() {
    void this.agent?.close().catch(() => {
    });
    this.agent = void 0;
  }
  /** 当前进度快照（无任务时 null）。 */
  getProgress() {
    return this.progress ? { ...this.progress } : null;
  }
  /** 是否有任务在跑（含校验阶段）。 */
  isBusy() {
    return this.busy;
  }
  modelsDir(id) {
    return path.join(this.dataDir, "models", id);
  }
  /** 全目录状态扫描（设置页模型卡数据源）。 */
  async listStatus() {
    const out = [];
    for (const entry of MODEL_CATALOG) {
      const dir = this.modelsDir(entry.id);
      let bytes = 0;
      let complete = true;
      let anyFile = false;
      for (const f of entry.files) {
        const size = await fileSize(path.join(dir, f.path));
        const partSize = await fileSize(path.join(dir, f.path + ".part"));
        if (size === f.size) {
          bytes += size;
          anyFile = true;
        } else if (partSize !== null) {
          bytes += partSize;
          complete = false;
          anyFile = true;
        } else if (size !== null) {
          bytes += size;
          complete = false;
          anyFile = true;
        } else {
          complete = false;
        }
      }
      out.push({
        id: entry.id,
        state: complete && anyFile ? "downloaded" : anyFile ? "partial" : "none",
        bytesOnDisk: bytes,
        totalBytes: catalogTotalBytes(entry)
      });
    }
    return out;
  }
  /** 单模型是否已完整下载（尺寸口径，不做哈希复验——下载完成时已验过）。 */
  async isDownloaded(id) {
    return (await this.listStatus()).find((s) => s.id === id)?.state === "downloaded";
  }
  /** 删除已下载模型（切走后释放磁盘；正在使用/下载中的拒绝）。 */
  async deleteModel(id) {
    const entry = catalogById(id);
    if (!entry) return { ok: false, error: "\u672A\u77E5\u6A21\u578B" };
    if (this.busy && this.progress?.modelId === id) return { ok: false, error: "\u8BE5\u6A21\u578B\u6B63\u5728\u4E0B\u8F7D" };
    try {
      await fs.rm(this.modelsDir(id), { recursive: true, force: true });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
  /** 启动下载（串行队列：忙时直接拒绝）。resolve 在任务终态（done/error/cancelled）。 */
  async start(id) {
    const entry = catalogById(id);
    if (!entry) throw new Error(`\u672A\u77E5\u6A21\u578B: ${id}`);
    return this.startEntry(entry);
  }
  /** 按给定目录项启动（测试缝：合成目录项驱动状态机，不触网）。 */
  async startEntry(entry) {
    if (this.busy) throw new Error("\u5DF2\u6709\u4E0B\u8F7D\u4EFB\u52A1\u8FDB\u884C\u4E2D\uFF08\u4E32\u884C\u961F\u5217\uFF0C\u8BF7\u7B49\u5F85\u6216\u53D6\u6D88\uFF09");
    this.busy = true;
    this.abort = new AbortController();
    const totalBytes = catalogTotalBytes(entry);
    this.progress = {
      modelId: entry.id,
      phase: "downloading",
      fileIndex: 0,
      fileCount: entry.files.length,
      fileReceived: 0,
      fileTotal: 0,
      overallReceived: 0,
      overallTotal: totalBytes,
      speedBps: 0,
      startedAt: Date.now()
    };
    try {
      await this.run(entry);
      this.progress.phase = "done";
      this.opts.logger?.info(`[memory] \u6A21\u578B ${entry.id} \u4E0B\u8F7D\u6821\u9A8C\u5B8C\u6210\uFF08${totalBytes} \u5B57\u8282\uFF09`);
      return { ...this.progress };
    } catch (err) {
      const cancelled = this.progress.phase === "cancelled";
      const message = err instanceof Error ? err.message : String(err);
      if (!cancelled) {
        this.progress.phase = "error";
        this.progress.error = message;
        this.opts.logger?.warn(`[memory] \u6A21\u578B ${entry.id} \u4E0B\u8F7D\u5931\u8D25: ${message}`);
      }
      return { ...this.progress };
    } finally {
      this.busy = false;
      this.abort = null;
    }
  }
  /** 取消当前任务：中断 fetch，保留 .part 断点。 */
  cancel() {
    if (!this.busy || !this.abort) return false;
    if (this.progress) this.progress.phase = "cancelled";
    this.abort.abort();
    return true;
  }
  async run(entry) {
    const prog = this.progress;
    const free = await this.freeBytes();
    if (free !== null) {
      const need = Math.ceil(catalogTotalBytes(entry) * DISK_HEADROOM);
      if (free < need) {
        const fmt = (n) => n >= 1e6 ? `${Math.round(n / 1e6)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`;
        throw new Error(`\u78C1\u76D8\u5269\u4F59\u7A7A\u95F4\u4E0D\u8DB3\uFF1A\u9700\u8981\u7EA6 ${fmt(need)}\uFF08\u542B 20% \u4F59\u91CF\uFF09\uFF0C\u5F53\u524D ${fmt(free)}`);
      }
    }
    const dir = this.modelsDir(entry.id);
    await fs.mkdir(path.join(dir, "onnx"), { recursive: true });
    let overall = 0;
    for (const f of entry.files) {
      if (await fileSize(path.join(dir, f.path)) === f.size) overall += f.size;
    }
    for (let i = 0; i < entry.files.length; i++) {
      if (prog.phase === "cancelled") throw new Error("\u5DF2\u53D6\u6D88");
      const f = entry.files[i];
      prog.fileIndex = i + 1;
      prog.fileTotal = f.size;
      const alreadyOk = await fileSize(path.join(dir, f.path)) === f.size;
      if (alreadyOk) {
        prog.fileReceived = f.size;
        continue;
      }
      overall += await this.downloadFile(entry, f, dir, (received) => {
        prog.fileReceived = received;
        prog.overallReceived = overall + received;
      });
      prog.overallReceived = overall;
    }
  }
  /** 下载单文件到最终路径（含续传与校验），返回该文件贡献的字节数。
   *  单文件失败自动重试（默认 2 次）+ **重试换缓存键**：镜像链路
   *  （Caddy×3 → CloudFront → Cloudflare）存在缓存对象污染窗口——同一时间窗内
   *  同一 URL 确定性拿到错误字节（2026-08-19 embeddinggemma generation_config.json
   *  连续错哈希的真实事故），普通重试会全打同一污染缓存；每次重试追加
   *  `?dshmem-retry=N` 参数绕开缓存键另取对象，窗口期也能自愈。
   *  - sha256 失配：downloadFileOnce 已删除断点 → 从零重下；
   *  - 数量不吻合/网络错误：断点保留 → Range 续传重试；
   *  - 取消：立即上抛不重试。 */
  async downloadFile(entry, f, dir, onBytes) {
    const delays = this.opts.retryDelaysMs ?? [1e3, 3e3];
    let lastErr;
    for (let attempt = 0; ; attempt++) {
      if (this.progress?.phase === "cancelled") throw new Error("\u5DF2\u53D6\u6D88");
      try {
        return await this.downloadFileOnce(entry, f, dir, attempt, onBytes);
      } catch (err) {
        lastErr = err;
        if (this.progress?.phase === "cancelled") throw err;
        if (attempt >= delays.length) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        this.opts.logger?.warn(
          `[memory] \u6587\u4EF6 ${f.path} \u7B2C ${attempt + 1} \u6B21\u5C1D\u8BD5\u5931\u8D25\uFF08${msg}\uFF09\uFF0C${delays[attempt]}ms \u540E\u81EA\u52A8\u91CD\u8BD5\uFF08\u6362\u7F13\u5B58\u952E\uFF09`
        );
        await new Promise((r) => setTimeout(r, delays[attempt]));
      }
    }
  }
  /** 单次尝试：续传探测 → fetch（attempt>0 追加缓存键参数）→ 落盘 → 尺寸与 sha256 校验 → rename。 */
  async downloadFileOnce(entry, f, dir, attempt, onBytes) {
    const finalPath = path.join(dir, f.path);
    const partPath = finalPath + ".part";
    const base = this.mirrorUrl();
    const cacheBust = attempt > 0 ? `?dshmem-retry=${attempt}` : "";
    const url = `${base}/${entry.repo}/resolve/${entry.revision}/${f.path}${cacheBust}`;
    const fetchImpl = this.opts.fetchImpl ?? this.defaultFetch;
    const prog = this.progress;
    let resumeFrom = 0;
    const partSize = await fileSize(partPath);
    if (partSize !== null && partSize < f.size) resumeFrom = partSize;
    else if (partSize === f.size) {
      const pre = await sha256File(partPath);
      if (pre === f.sha256) {
        await fs.rename(partPath, finalPath);
        return f.size;
      }
      await fs.rm(partPath, { force: true });
    } else if (partSize !== null) {
      await fs.rm(partPath, { force: true });
    }
    const headers = {};
    if (resumeFrom > 0) headers.range = `bytes=${resumeFrom}-`;
    let res = await fetchImpl(url, { headers, signal: this.abort?.signal });
    if (res.status === 416 && resumeFrom > 0) {
      await fs.rm(partPath, { force: true });
      resumeFrom = 0;
      delete headers.range;
      res = await fetchImpl(url, { headers, signal: this.abort?.signal });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}\uFF08${f.path}\uFF09`);
    const appending = res.status === 206 && resumeFrom > 0;
    if (!appending) resumeFrom = 0;
    const declared = Number(res.headers.get("content-length") ?? 0);
    const expectBytes = appending ? resumeFrom + declared : declared || f.size;
    const handle = await fs.open(partPath, appending ? "a" : "w");
    let received = resumeFrom;
    let lastTick = Date.now();
    let lastBytes = received;
    try {
      if (!res.body) throw new Error("\u54CD\u5E94\u65E0 body");
      const reader = res.body.getReader();
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done) break;
        if (prog.phase === "cancelled") throw new Error("\u5DF2\u53D6\u6D88");
        await handle.write(value);
        received += value.byteLength;
        const now = Date.now();
        if (now - lastTick > 200) {
          const inst = (received - lastBytes) / (now - lastTick) * 1e3;
          prog.speedBps = prog.speedBps * 0.6 + inst * 0.4;
          lastTick = now;
          lastBytes = received;
        }
        onBytes(Math.min(received, f.size));
        prog.fileTotal = expectBytes || f.size;
      }
    } finally {
      await handle.close();
    }
    if (received !== f.size) {
      throw new Error(`\u4E0B\u8F7D\u6570\u91CF\u4E0D\u543B\u5408\uFF1A\u671F\u671B ${f.size}\uFF0C\u6536\u5230 ${received}\uFF08${f.path}\uFF09`);
    }
    prog.phase = "verifying";
    const sha = await sha256File(partPath);
    if (sha !== f.sha256) {
      await fs.rm(partPath, { force: true });
      throw new Error(`sha256 \u6821\u9A8C\u5931\u8D25\uFF08${f.path}\uFF09\uFF0C\u5DF2\u5220\u9664\u65AD\u70B9\uFF0C\u8BF7\u91CD\u8BD5`);
    }
    if (prog.phase === "cancelled") throw new Error("\u5DF2\u53D6\u6D88");
    prog.phase = "downloading";
    await fs.rename(partPath, finalPath);
    return f.size;
  }
  async freeBytes() {
    if (this.opts.freeBytes) return this.opts.freeBytes();
    try {
      const statfs = (await import("node:fs/promises")).statfs;
      if (typeof statfs !== "function") return null;
      const s = await statfs(this.dataDir);
      return Number(BigInt(s.bavail) * BigInt(s.bsize));
    } catch {
      return null;
    }
  }
}
async function fileSize(p) {
  try {
    const s = await fs.stat(p);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}
function resolveProxyUrl(setting, host) {
  const value = (setting ?? "").trim();
  if (value.toLowerCase() === "none") return "";
  if (value) return value;
  const noProxy = process.env.NO_PROXY ?? process.env.no_proxy ?? "";
  if (noProxy.trim() === "*") return "";
  if (noProxy) {
    for (const raw of noProxy.split(",")) {
      const entry = raw.trim().replace(/^\./, "").toLowerCase();
      if (entry && (host.toLowerCase() === entry || host.toLowerCase().endsWith(`.${entry}`))) return "";
    }
  }
  const candidates = [
    process.env.HTTPS_PROXY,
    process.env.https_proxy,
    process.env.ALL_PROXY,
    process.env.all_proxy,
    process.env.HTTP_PROXY,
    process.env.http_proxy
  ];
  for (const c of candidates) {
    if (c && c.trim()) return c.trim();
  }
  return "";
}
function maskProxyUrl(proxy) {
  try {
    const u = new URL(proxy);
    return `${u.protocol}//${u.host}`;
  } catch {
    return "<invalid-url>";
  }
}
async function sha256File(p) {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  const stream = createReadStream(p);
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
export {
  ModelDownloadQueue,
  maskProxyUrl,
  resolveProxyUrl
};

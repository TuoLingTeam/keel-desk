import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
const PINNED_TRANSFORMERS_VERSION = "4.2.0";
class RuntimeInstaller {
  runtimeDir;
  target;
  logger;
  spawnImpl;
  /** 随包 lockfile 路径（测试可注入；默认取 dist 根下构建期拷入的资产）。 */
  lockfileSource;
  progress;
  child = null;
  current = null;
  /** 安装超时（npm 卡死不罕见：registry 停滞即永挂，applyBusy 会被锁死）。每次 spawn 独立计时。 */
  static INSTALL_TIMEOUT_MS = 10 * 6e4;
  constructor(dataDir, targetVersion, opts) {
    this.runtimeDir = path.join(dataDir, "runtime");
    this.target = targetVersion;
    this.logger = opts?.logger;
    this.lockfileSource = opts?.lockfileSource ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "runtime-package-lock.json");
    this.spawnImpl = opts?.spawnImpl ?? ((command, args, cwd) => {
      const child = spawn(command, args, {
        cwd,
        // Windows 上 .cmd 必须走 shell（Node 20+ 安全限制）；参数全部来自插件常量，无注入面
        shell: process.platform === "win32",
        windowsHide: true
      });
      const spawned = {
        onStdout(cb) {
          child.stdout?.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => l && cb(l)));
        },
        onStderr(cb) {
          child.stderr?.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => l && cb(l)));
        },
        // Windows shell:true 下 child 只是 cmd.exe，npm/node 孙进程不随 child.kill()
        // 终止（超时与取消都会"表面停止"）——taskkill /T 按进程树杀；启动失败回退裸 kill
        kill: () => {
          if (process.platform === "win32" && child.pid !== void 0) {
            const tk = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
            tk.on("error", () => child.kill());
          } else {
            child.kill();
          }
        },
        // 'error'（如 ENOENT：PATH 无 npm）只发 error 不发 close——不监听会永挂
        exited: new Promise((resolve) => {
          child.on("close", (code) => resolve(code));
          child.on("error", () => resolve(null));
        })
      };
      return spawned;
    });
    this.progress = {
      phase: "idle",
      targetVersion,
      installedVersion: null,
      startedAt: 0,
      elapsedMs: 0,
      lastLines: []
    };
  }
  /** 包内模块名（与钉死版本一起构成安装目标）。 */
  static packageName = "@huggingface/transformers";
  /** 进度快照。 */
  getProgress() {
    const elapsed = this.progress.phase === "installing" ? Date.now() - this.progress.startedAt : this.progress.elapsedMs;
    return { ...this.progress, lastLines: [...this.progress.lastLines], elapsedMs: elapsed };
  }
  pkgJsonPath() {
    return path.join(this.runtimeDir, "node_modules", RuntimeInstaller.packageName, "package.json");
  }
  /** 已就位版本（读 package.json；未安装返回 null）。 */
  async installedVersion() {
    try {
      const raw = await fs.readFile(this.pkgJsonPath(), "utf8");
      const pkg = JSON.parse(raw);
      return typeof pkg.version === "string" ? pkg.version : null;
    } catch {
      return null;
    }
  }
  /** 是否就绪（版本精确匹配目标）。 */
  async isReady() {
    return await this.installedVersion() === this.target;
  }
  /**
   * 确保运行时就位：版本匹配直接就绪；否则安装（忙时并 await 同一次任务）。
   * 返回是否就绪（失败/取消返回 false 并在 progress.error 说明原因）。
   */
  async ensure() {
    if (await this.isReady()) {
      this.progress.phase = "ready";
      this.progress.installedVersion = this.target;
      return true;
    }
    if (this.current) return this.current;
    this.current = this.installOnce();
    try {
      return await this.current;
    } finally {
      this.current = null;
    }
  }
  /**
   * 取消安装（kill 子进程；node_modules 残留无害，npm 幂等重装）。
   * 间隙兼容：ci 退出到回退 install 起跑之间 child 为 null——此时也置取消态，
   * runNpm 起跑前复查即不再起新进程（否则回退的 npm 会跑到自然结束且无法再取消）。
   */
  cancel() {
    if (this.progress.phase !== "installing") return false;
    this.progress.phase = "cancelled";
    this.child?.kill();
    return true;
  }
  pushLine(line) {
    const lines = this.progress.lastLines;
    lines.push(line.length > 300 ? line.slice(0, 300) + "\u2026" : line);
    if (lines.length > 5) lines.splice(0, lines.length - 5);
  }
  /** 跑一次 npm 子进程（采集尾行 + 超时 kill），返回退出码（null = 被杀死/启动失败）。 */
  async runNpm(args) {
    if (this.progress.phase === "cancelled") return null;
    const child = this.spawnImpl("npm", args, this.runtimeDir);
    this.child = child;
    child.onStdout((l) => this.pushLine(l));
    child.onStderr((l) => this.pushLine(l));
    const timeout = setTimeout(() => {
      this.pushLine("\u5B89\u88C5\u8D85\u65F6\uFF0810 \u5206\u949F\uFF09\uFF0C\u7EC8\u6B62\u5B50\u8FDB\u7A0B");
      child.kill();
    }, RuntimeInstaller.INSTALL_TIMEOUT_MS);
    const code = await child.exited;
    clearTimeout(timeout);
    this.child = null;
    return code;
  }
  /** 取消态判定。独立方法而非内联比较：cancel() 在 await 期间跨方法置位
   *  phase，TS 的属性流分析不跟踪这种突变，内联比较会被窄化误报"无重叠"。 */
  wasCancelled() {
    return this.progress.phase === "cancelled";
  }
  async installOnce() {
    await fs.mkdir(this.runtimeDir, { recursive: true });
    const manifest = {
      name: "dsh-memory-runtime",
      private: true,
      dependencies: { [RuntimeInstaller.packageName]: this.target }
    };
    await fs.writeFile(path.join(this.runtimeDir, "package.json"), JSON.stringify(manifest, null, 2));
    this.progress = {
      phase: "installing",
      targetVersion: this.target,
      installedVersion: await this.installedVersion(),
      startedAt: Date.now(),
      elapsedMs: 0,
      lastLines: []
    };
    this.logger?.info(`[memory] \u8FD0\u884C\u65F6\u5B89\u88C5\u5F00\u59CB: ${RuntimeInstaller.packageName}@${this.target} \u2192 ${this.runtimeDir}`);
    let code = null;
    let usedCi = false;
    try {
      const lock = await fs.readFile(this.lockfileSource, "utf8");
      await fs.writeFile(path.join(this.runtimeDir, "package-lock.json"), lock);
      this.pushLine(`npm ci\uFF08\u968F\u5305 lockfile \u9501\u5B9A\u4F9D\u8D56\u6811\uFF0C@${this.target}\uFF0C--ignore-scripts\uFF09`);
      usedCi = true;
      code = await this.runNpm(["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "notice"]);
    } catch {
    }
    if (this.wasCancelled()) {
      this.progress.elapsedMs = Date.now() - this.progress.startedAt;
      this.logger?.warn("[memory] \u8FD0\u884C\u65F6\u5B89\u88C5\u5DF2\u53D6\u6D88\uFF08\u6B8B\u7559\u65E0\u5BB3\uFF0C\u91CD\u88C5\u5E42\u7B49\uFF09");
      return false;
    }
    if (!usedCi || code !== 0) {
      if (usedCi) {
        this.pushLine("npm ci \u5931\u8D25\uFF08lockfile \u4E0E\u9489\u6B7B\u7248\u672C\u6F02\u79FB\uFF1F\uFF09\uFF0C\u56DE\u9000 npm install");
        this.logger?.warn("[memory] \u8FD0\u884C\u65F6 npm ci \u5931\u8D25\uFF0C\u56DE\u9000 npm install\uFF08\u4F20\u9012\u4F9D\u8D56\u4E0D\u518D\u53D7\u968F\u5305 lockfile \u9501\u5B9A\uFF09");
      }
      this.pushLine(`npm install ${RuntimeInstaller.packageName}@${this.target}\uFF08--ignore-scripts\uFF09`);
      code = await this.runNpm([
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel",
        "notice",
        `${RuntimeInstaller.packageName}@${this.target}`
      ]);
    }
    this.progress.elapsedMs = Date.now() - this.progress.startedAt;
    const version = await this.installedVersion();
    this.progress.installedVersion = version;
    if (this.wasCancelled()) {
      this.logger?.warn("[memory] \u8FD0\u884C\u65F6\u5B89\u88C5\u5DF2\u53D6\u6D88\uFF08\u6B8B\u7559\u65E0\u5BB3\uFF0C\u91CD\u88C5\u5E42\u7B49\uFF09");
      return false;
    }
    if (code === 0 && version === this.target) {
      this.progress.phase = "ready";
      this.logger?.info(`[memory] \u8FD0\u884C\u65F6\u5B89\u88C5\u5B8C\u6210: v${version}`);
      return true;
    }
    this.progress.phase = "error";
    this.progress.error = `npm \u9000\u51FA\u7801 ${code ?? "\u88AB\u6740\u6B7B"}${version ? `\uFF08\u5C31\u4F4D\u7248\u672C ${version}\uFF09` : "\uFF08\u6A21\u5757\u672A\u5C31\u4F4D\uFF09"}`;
    this.logger?.warn(`[memory] \u8FD0\u884C\u65F6\u5B89\u88C5\u5931\u8D25: ${this.progress.error}`);
    return false;
  }
}
export {
  PINNED_TRANSFORMERS_VERSION,
  RuntimeInstaller
};

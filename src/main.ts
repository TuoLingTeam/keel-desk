import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  type Theme,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";

type LaunchStage =
  | "locatingRuntime"
  | "checkingRuntime"
  | "verifyingRuntime"
  | "startingService"
  | "waitingForService"
  | "loadingWorkspace"
  | "failed";

interface LaunchStatus {
  phase: "starting" | "ready" | "failed";
  stage: LaunchStage;
  progress: number;
  detail: string;
  url: string | null;
}

interface StagePresentation {
  step: number;
  kicker: string;
  title: string;
  progressLabel: string;
}

interface HarnessThemeMessage {
  type: "deepseek-harness:theme";
  colorScheme: "light" | "dark";
}

const HARNESS_THEME_MESSAGE = "deepseek-harness:theme";
const HARNESS_THEME_REQUEST = "deepseek-harness:theme-request";
const HARNESS_RELAUNCHING_EVENT = "harness://relaunching";

// The macOS window keeps its native traffic lights, so the stylesheet needs to
// know which platform it is dressing before the title bar is first painted.
if (navigator.userAgent.includes("Mac OS X")) {
  document.body.dataset.platform = "macos";
}

const title = document.querySelector<HTMLElement>("#launch-title");
const kicker = document.querySelector<HTMLElement>("#launch-kicker");
const detail = document.querySelector<HTMLElement>("#launch-detail");
const progressLabel = document.querySelector<HTMLElement>("#progress-label");
const progressValue = document.querySelector<HTMLElement>("#progress-value");
const progressTrack = document.querySelector<HTMLElement>("#progress-track");
const progressFill = document.querySelector<HTMLElement>("#progress-fill");
const launchSteps = Array.from(
  document.querySelectorAll<HTMLElement>("[data-launch-step]"),
);
const error = document.querySelector<HTMLElement>("#launch-error");
const failure = document.querySelector<HTMLElement>("#launch-failure");
const stage = document.querySelector<HTMLElement>(".launch-stage");
const launchShell = document.querySelector<HTMLElement>(".launch-shell");
const harnessSurface = document.querySelector<HTMLElement>("#harness-surface");
const harnessFrame = document.querySelector<HTMLIFrameElement>("#harness-frame");
const retry = document.querySelector<HTMLButtonElement>("#retry");
const copyError = document.querySelector<HTMLButtonElement>("#copy-error");
const minimize = document.querySelector<HTMLButtonElement>("#window-minimize");
const maximize = document.querySelector<HTMLButtonElement>("#window-maximize");
const close = document.querySelector<HTMLButtonElement>("#window-close");
const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

let mountedHarnessUrl: string | null = null;
let mountedHarnessOrigin: string | null = null;
let harnessTheme: Theme | null = null;
let renderedProgress = 3;

const STAGE_PRESENTATION: Record<LaunchStage, StagePresentation> = {
  locatingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 准备运行时",
    title: "正在准备 Harness",
    progressLabel: "定位内置运行时",
  },
  checkingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 准备运行时",
    title: "正在检查运行环境",
    progressLabel: "读取便携运行时",
  },
  verifyingRuntime: {
    step: 0,
    kicker: "步骤 1/3 · 准备运行时",
    title: "正在验证 Harness",
    progressLabel: "验证运行时完整性",
  },
  startingService: {
    step: 1,
    kicker: "步骤 2/3 · 启动本地服务",
    title: "正在启动本地服务",
    progressLabel: "创建 Harness 进程",
  },
  waitingForService: {
    step: 1,
    kicker: "步骤 2/3 · 启动本地服务",
    title: "正在等待服务就绪",
    progressLabel: "等待随机端口响应",
  },
  loadingWorkspace: {
    step: 2,
    kicker: "步骤 3/3 · 载入工作区",
    title: "正在载入工作区",
    progressLabel: "连接 Harness 界面",
  },
  failed: {
    step: 0,
    kicker: "启动未完成",
    title: "Harness 启动失败",
    progressLabel: "启动中断",
  },
};

function resolveWindow(): TauriWindow | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

const appWindow = resolveWindow();

function renderTheme(theme: Theme | null): void {
  const dark = theme === "dark" || (theme === null && systemTheme.matches);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  document.body.setAttribute("data-ds-theme-ready", "");
}

function applyWindowTheme(theme: Theme | null): void {
  if (harnessTheme === null) renderTheme(theme);
}

function applyHarnessTheme(theme: Theme): void {
  harnessTheme = theme;
  renderTheme(theme);
}

function bindSystemTheme(): void {
  applyWindowTheme(systemTheme.matches ? "dark" : "light");
  systemTheme.addEventListener("change", ({ matches }) => {
    applyWindowTheme(matches ? "dark" : "light");
  });
}

/**
 * Harness 的主题偏好，由壳层在文档创建前写在 `<html>` 上。
 * 明确的 light/dark 优先于系统配色；`system` 或缺失时返回 null。
 */
function bootTheme(): Theme | null {
  const value = document.documentElement.dataset.dshBoot;
  return value === "dark" || value === "light" ? value : null;
}

async function bindWindowTheme(): Promise<void> {
  // 用户在 Harness 里选定的主题是权威来源；此时跟随系统会把启动画面
  // 画成另一种配色，等 Harness 就绪后再翻一次——那正是要消除的闪烁。
  const preferred = bootTheme();
  if (preferred !== null) {
    applyWindowTheme(preferred);
    return;
  }

  if (!appWindow) {
    bindSystemTheme();
    return;
  }

  try {
    applyWindowTheme(await appWindow.theme());
    await appWindow.onThemeChanged(({ payload }) => applyWindowTheme(payload));
  } catch {
    bindSystemTheme();
  }
}

function isHarnessThemeMessage(value: unknown): value is HarnessThemeMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<HarnessThemeMessage>;
  return message.type === HARNESS_THEME_MESSAGE
    && (message.colorScheme === "light" || message.colorScheme === "dark");
}

window.addEventListener("message", (event) => {
  if (
    mountedHarnessOrigin === null
    || event.origin !== mountedHarnessOrigin
    || event.source !== harnessFrame?.contentWindow
  ) return;

  if (isHarnessThemeMessage(event.data)) {
    applyHarnessTheme(event.data.colorScheme);
  } else if (event.data.type === "deepseek-harness:restart") {
    void invoke("restart_harness");
  }
});

async function syncMaximizedState(): Promise<void> {
  if (!appWindow) return;
  const maximized = await appWindow.isMaximized();
  document.body.classList.toggle("is-maximized", maximized);
  if (maximize) maximize.setAttribute("aria-label", maximized ? "还原" : "最大化");
}

async function runWindowAction(action: (window: TauriWindow) => Promise<void>): Promise<void> {
  if (!appWindow) return;
  try {
    await action(appWindow);
  } catch (reason) {
    console.error("Desktop window action failed", reason);
  }
}

function setProgress(value: number, allowDecrease = false): void {
  const bounded = Math.max(0, Math.min(100, Math.round(value)));
  renderedProgress = allowDecrease ? bounded : Math.max(renderedProgress, bounded);
  if (progressValue) progressValue.textContent = `${renderedProgress}%`;
  if (progressTrack) progressTrack.setAttribute("aria-valuenow", String(renderedProgress));
  if (progressFill) {
    progressFill.style.transform = `scaleX(${renderedProgress / 100})`;
  }
}

function renderSteps(activeStep: number, complete = false): void {
  launchSteps.forEach((element, index) => {
    element.classList.toggle("is-active", !complete && index === activeStep);
    element.classList.toggle("is-complete", complete || index < activeStep);
  });
}

function renderLaunchStatus(status: LaunchStatus): void {
  const presentation = STAGE_PRESENTATION[status.stage] ?? STAGE_PRESENTATION.locatingRuntime;
  document.body.dataset.launchStage = status.stage;
  if (kicker) kicker.textContent = presentation.kicker;
  if (title) title.textContent = presentation.title;
  if (detail) detail.textContent = status.detail;
  if (progressLabel) progressLabel.textContent = presentation.progressLabel;
  setProgress(status.progress);
  renderSteps(presentation.step);
}

function showFailure(message: string): void {
  if (kicker) kicker.textContent = "启动未完成";
  if (title) title.textContent = "Harness 启动失败";
  if (detail) detail.textContent = "请检查路径、构建产物和 Node.js 环境。";
  if (progressLabel) progressLabel.textContent = "启动中断";
  if (error) error.textContent = message;
  if (failure) failure.hidden = false;
  if (stage) stage.setAttribute("aria-busy", "false");
  document.body.classList.add("is-failed");
}

function mountHarness(rawUrl: string): void {
  if (!harnessFrame || !harnessSurface || mountedHarnessUrl === rawUrl) return;

  const url = new URL(rawUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    showFailure(`Harness 返回了无效的本地地址：${rawUrl}`);
    return;
  }

  mountedHarnessUrl = rawUrl;
  mountedHarnessOrigin = url.origin;
  harnessSurface.hidden = false;
  harnessFrame.dataset.loading = "true";
  harnessFrame.src = url.href;
}

harnessFrame?.addEventListener("load", () => {
  if (harnessFrame.dataset.loading !== "true") return;
  delete harnessFrame.dataset.loading;
  if (kicker) kicker.textContent = "步骤 3/3 · 工作区已就绪";
  if (title) title.textContent = "DeepSeek Harness 已就绪";
  if (detail) detail.textContent = "正在显示工作区…";
  if (progressLabel) progressLabel.textContent = "启动完成";
  setProgress(100);
  renderSteps(2, true);
  if (stage) stage.setAttribute("aria-busy", "false");
  if (launchShell) launchShell.setAttribute("aria-hidden", "true");
  document.body.classList.add("is-harness-ready");
  if (mountedHarnessOrigin !== null) {
    harnessFrame.contentWindow?.postMessage(
      { type: HARNESS_THEME_REQUEST },
      mountedHarnessOrigin,
    );
  }
});

async function pollLaunch(): Promise<void> {
  try {
    const status = await invoke<LaunchStatus>("launch_status");
    renderLaunchStatus(status);
    if (status.phase === "failed") {
      showFailure(status.detail);
      return;
    }
    if (status.phase === "ready") {
      if (status.url) mountHarness(status.url);
      else showFailure("Harness 已就绪，但没有返回本地页面地址。");
      return;
    }
    window.setTimeout(pollLaunch, 180);
  } catch (reason) {
    showFailure(String(reason));
  }
}

interface ModelUsage {
  model: string;
  requests: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cost: number | null;
}

interface UsageSnapshotPayload {
  balance: {
    currency: string;
    total: string;
    granted: string;
    toppedUp: string;
    available: boolean;
  } | null;
  balanceError: string | null;
  today: {
    requests: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    billedTokens: number;
    cacheHitRatio: number | null;
    cost: number | null;
    byModel: ModelUsage[];
  };
  usageError: string | null;
  fetchedAt: number;
  hasKey: boolean;
}

const USAGE_INTERVAL_KEY = "deepseek-harness:usage-interval";
const USAGE_INTERVAL_DEFAULT = 60;

const usageMeter = document.querySelector<HTMLElement>("#usage-meter");
const usagePanel = document.querySelector<HTMLElement>("#usage-panel");
const usageSummary = document.querySelector<HTMLButtonElement>("#usage-summary");
const usageIntervalInput = document.querySelector<HTMLInputElement>("#usage-interval");
const usageModels = document.querySelector<HTMLElement>("#usage-models");

let usageTimer: number | undefined;
let usageStamp: number | undefined;

const usageText = (id: string, value: string): void => {
  const node = document.querySelector<HTMLElement>(`#${id}`);
  if (node) node.textContent = value;
};

const usageNote = (id: string, message: string | null): void => {
  const node = document.querySelector<HTMLElement>(`#${id}`);
  if (!node) return;
  node.textContent = message ?? "";
  node.hidden = message === null;
};

/** 金额统一两位小数，缺价时给出「—」而不是假装是 0。 */
function money(value: number | null | undefined, currency = "CNY"): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const symbol = currency === "CNY" ? "¥" : `${currency} `;
  return `${symbol}${value.toFixed(2)}`;
}

function countTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function renderUsageModels(rows: ModelUsage[]): void {
  if (!usageModels) return;
  usageModels.replaceChildren();
  for (const row of rows) {
    const line = document.createElement("div");
    line.className = "usage-model-row";
    const name = document.createElement("span");
    name.textContent = row.model;
    const figures = document.createElement("span");
    const billed = row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens;
    figures.textContent = `${row.requests} 次 · ${countTokens(billed)} · ${money(row.cost)}`;
    line.append(name, figures);
    usageModels.append(line);
  }
}

function renderUsage(snapshot: UsageSnapshotPayload): void {
  const { balance, today } = snapshot;
  const currency = balance?.currency ?? "CNY";

  const dot = document.querySelector<HTMLElement>("#usage-dot");
  if (dot) {
    dot.dataset.state = balance === null ? "error" : balance.available ? "ok" : "error";
  }

  const total = balance === null ? null : Number.parseFloat(balance.total);
  usageText("usage-balance", money(total, currency));
  usageText("usage-hero", balance === null ? "—" : `${currency} ${balance.total}`);
  usageText("usage-topped-up", balance === null ? "—" : `${currency} ${balance.toppedUp}`);
  usageText("usage-granted", balance === null ? "—" : `${currency} ${balance.granted}`);
  usageText("usage-available", balance === null ? "—" : balance.available ? "可用" : "不可用");
  usageNote(
    "usage-balance-error",
    snapshot.hasKey
      ? snapshot.balanceError
      : "未找到 API Key：请在 Harness 里配置 DeepSeek 凭据后重试。",
  );

  usageText("usage-today-cost", money(today.cost));
  usageText("usage-today-requests", String(today.requests));
  usageText("usage-today-tokens", countTokens(today.billedTokens));
  usageText("usage-cache", percent(today.cacheHitRatio));

  usageText("usage-cost-detail", money(today.cost));
  usageText("usage-requests-detail", `${today.requests} 次`);
  usageText("usage-billed-detail", today.billedTokens.toLocaleString("zh-CN"));
  usageText(
    "usage-cache-detail",
    `${percent(today.cacheHitRatio)} · ${countTokens(today.cacheReadTokens)}`,
  );
  usageText("usage-input-detail", countTokens(today.inputTokens));
  usageText("usage-output-detail", countTokens(today.outputTokens));
  usageNote("usage-usage-error", snapshot.usageError);
  renderUsageModels(today.byModel);

  usageStamp = snapshot.fetchedAt;
  renderUsageStamp();
  if (usageMeter) usageMeter.hidden = false;
}

function renderUsageStamp(): void {
  if (usageStamp === undefined) return;
  const seconds = Math.max(0, Math.round((Date.now() - usageStamp) / 1000));
  const ago = seconds < 60 ? `${seconds} 秒前` : `${Math.round(seconds / 60)} 分钟前`;
  usageText("usage-stamp", `更新于 ${ago}`);
}

async function refreshUsage(): Promise<void> {
  try {
    renderUsage(await invoke<UsageSnapshotPayload>("usage_snapshot"));
  } catch (reason) {
    console.error("Usage snapshot failed", reason);
    usageNote("usage-usage-error", String(reason));
    if (usageMeter) usageMeter.hidden = false;
  }
}

function usageInterval(): number {
  const stored = Number.parseInt(localStorage.getItem(USAGE_INTERVAL_KEY) ?? "", 10);
  if (!Number.isFinite(stored)) return USAGE_INTERVAL_DEFAULT;
  return Math.min(3600, Math.max(15, stored));
}

/** 重排自动刷新循环；间隔改动即时生效并持久化。 */
function scheduleUsage(): void {
  if (usageTimer !== undefined) window.clearInterval(usageTimer);
  const seconds = usageInterval();
  if (usageIntervalInput) usageIntervalInput.value = String(seconds);
  usageTimer = window.setInterval(() => {
    void refreshUsage();
  }, seconds * 1000);
}

function toggleUsagePanel(open: boolean): void {
  if (!usagePanel || !usageSummary) return;
  usagePanel.hidden = !open;
  usageSummary.setAttribute("aria-expanded", String(open));
  if (open) void refreshUsage();
}

usageSummary?.addEventListener("click", () => {
  toggleUsagePanel(usagePanel?.hidden === true);
});

document.querySelector("#usage-close")?.addEventListener("click", () => {
  toggleUsagePanel(false);
});

document.querySelector("#usage-refresh")?.addEventListener("click", () => {
  void refreshUsage();
});

usageIntervalInput?.addEventListener("change", () => {
  const seconds = Math.min(3600, Math.max(15, Number.parseInt(usageIntervalInput.value, 10) || USAGE_INTERVAL_DEFAULT));
  localStorage.setItem(USAGE_INTERVAL_KEY, String(seconds));
  scheduleUsage();
});

// 点面板以外的地方或按 Esc 收起，和其他浮层的习惯一致。
document.addEventListener("click", (event) => {
  if (usagePanel?.hidden !== false) return;
  if (event.target instanceof Node && usageMeter?.contains(event.target)) return;
  toggleUsagePanel(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && usagePanel?.hidden === false) toggleUsagePanel(false);
});

window.setInterval(renderUsageStamp, 15_000);

/**
 * Return to the launch screen and follow a freshly spawned Harness. The tray's
 * "restart backend" gives the new run a different loopback port, and polling
 * has already stopped by the time the previous one became ready.
 */
function followRelaunch(): void {
  mountedHarnessUrl = null;
  mountedHarnessOrigin = null;
  harnessTheme = null;
  renderedProgress = 0;
  setProgress(3, true);
  renderSteps(0);
  if (harnessSurface) harnessSurface.hidden = true;
  if (failure) failure.hidden = true;
  if (launchShell) launchShell.removeAttribute("aria-hidden");
  if (stage) stage.setAttribute("aria-busy", "true");
  document.body.classList.remove("is-harness-ready", "is-failed");
  void pollLaunch();
}

void listen(HARNESS_RELAUNCHING_EVENT, followRelaunch);

minimize?.addEventListener("click", () => {
  void runWindowAction((window) => window.minimize());
});

maximize?.addEventListener("click", () => {
  void runWindowAction(async (window) => {
    await window.toggleMaximize();
    await syncMaximizedState();
  });
});

close?.addEventListener("click", () => {
  void runWindowAction((window) => window.close());
});

retry?.addEventListener("click", () => window.location.reload());

copyError?.addEventListener("click", async () => {
  await navigator.clipboard.writeText(error?.textContent ?? "");
  if (copyError) copyError.textContent = "已复制";
});

if (appWindow) {
  void syncMaximizedState();
  void appWindow.onResized(() => {
    void syncMaximizedState();
  });
}

void bindWindowTheme();
void pollLaunch();
scheduleUsage();
void refreshUsage();

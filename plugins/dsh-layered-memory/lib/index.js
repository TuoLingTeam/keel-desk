import * as path from "node:path";
import { memorySchema, resolveDataDir } from "./config.js";
import { registerBenchControl } from "./bench-control.js";
import { registerCapture } from "./hooks/capture.js";
import { registerRecall } from "./hooks/recall.js";
import { MemoryRunner } from "./pipeline/runner.js";
import { RebuildController } from "./pipeline/rebuild.js";
import { registerMemoryRpc, PLUGIN_VERSION } from "./stats.js";
import { registerLiveSettings } from "./settings.js";
import { NoopEmbeddingService } from "./store/embedding.js";
import {
  EmbeddingManager,
  EmbeddingSourceStore,
  makeLocalServiceFactory,
  resolveInitialEmbedding
} from "./store/embedding-source.js";
import { ModelDownloadQueue } from "./store/download-queue.js";
import { PINNED_TRANSFORMERS_VERSION, RuntimeInstaller } from "./store/runtime-installer.js";
import { ensureDir } from "./store/io.js";
import { L0Store } from "./store/l0.js";
import { L1Store } from "./store/l1.js";
import { PersonaStore } from "./store/persona.js";
import { MemoryDb } from "./store/sqlite.js";
import { SceneStore } from "./store/scenes.js";
import { SessionModeStore } from "./store/session-modes.js";
import { StateStore } from "./store/state.js";
import { registerMemoryTools } from "./tools/index.js";
import { errDetail, withFileLog } from "./util/filelog.js";
import { buildRouteChain, resolveModelRoute, invalidateEffortCache } from "./llm.js";
import { effectiveCfg } from "./pipeline/runner.js";
import { initTokenCost, resetTokenCost } from "./token-cost.js";
const name = "dsh-memory-plugin";
const inject = ["llm", "tools", "systemPrompt"];
const Config = memorySchema;
async function apply(ctx, config) {
  let logger = {
    debug: (m) => ctx.logger.debug(m),
    info: (m) => ctx.logger.info(m),
    warn: (m) => ctx.logger.warn(m),
    error: (m) => ctx.logger.error(m)
  };
  const dataDir = resolveDataDir(config);
  const fileLogger = withFileLog(dataDir, logger);
  logger = fileLogger;
  ctx.on("llm/adapters-updated", () => invalidateEffortCache());
  let storageOk = true;
  try {
    await ensureDir(dataDir);
  } catch (err) {
    storageOk = false;
    logger.error(
      `[memory] \u6570\u636E\u76EE\u5F55\u4E0D\u53EF\u5199\uFF0C\u8BB0\u5FC6\u529F\u80FD\u505C\u7528: ${dataDir} (${err instanceof Error ? err.message : String(err)})`
    );
  }
  const live = registerLiveSettings(ctx, logger);
  let disposed = false;
  const modes = new SessionModeStore(dataDir, config.family, logger);
  if (storageOk) {
    try {
      await modes.init();
    } catch (err) {
      logger.warn(`[memory] \u4F1A\u8BDD\u6863\u4F4D\u8F7D\u5165\u5931\u8D25\uFF08\u964D\u7EA7\u4E3A\u9ED8\u8BA4\u6863\u5185\u5B58\u6001\uFF09: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const sourceStore = new EmbeddingSourceStore(dataDir, logger);
  const installer = new RuntimeInstaller(dataDir, PINNED_TRANSFORMERS_VERSION, { logger });
  const downloader = new ModelDownloadQueue(dataDir, {
    mirror: config.embedding.mirror,
    logger,
    proxy: config.embedding.proxy
  });
  const makeLocalService = makeLocalServiceFactory(installer, downloader, logger, config.embedding.maxInputChars);
  let initial = { svc: new NoopEmbeddingService(), dims: 0 };
  let embedManagerRef;
  if (storageOk) {
    try {
      await sourceStore.init();
      initial = await resolveInitialEmbedding(config, sourceStore, downloader, makeLocalService, logger);
    } catch (err) {
      logger.warn(`[memory] \u5D4C\u5165\u6E90\u521D\u59CB\u89E3\u6790\u5931\u8D25\uFF08\u964D\u7EA7\u7EAF FTS\uFF09: ${errDetail(err)}`);
    }
  }
  const currentProviderInfo = () => embedManagerRef?.currentProviderInfo() ?? initial.providerInfo;
  const embed = initial.svc;
  const db = new MemoryDb(path.join(dataDir, "memory.db"), initial.dims, logger);
  initTokenCost(db, config.tokenCost.retentionDays);
  ctx.effect(() => () => db.close());
  let dbInit = { needsReindex: false };
  if (storageOk) {
    try {
      dbInit = db.init(initial.providerInfo);
      if (db.isDegraded()) {
        storageOk = false;
        logger.error("[memory] \u68C0\u7D22\u5E93\u521D\u59CB\u5316\u5931\u8D25\uFF08schema/FTS \u4E0D\u53EF\u7528\uFF09\uFF0C\u8BB0\u5FC6\u529F\u80FD\u505C\u7528");
      }
    } catch (err) {
      storageOk = false;
      logger.error(
        `[memory] \u68C0\u7D22\u5E93\u6253\u5F00\u5931\u8D25\uFF0C\u8BB0\u5FC6\u529F\u80FD\u505C\u7528: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const stores = {
    l0: new L0Store(dataDir, db, embed, logger),
    l1: new L1Store(dataDir, db, embed, config.recall.strategy, logger, config.recall.decayHalfLifeDays),
    // L2/L3 分族隔离：各自目录与文件（scenes/chat|work、persona-chat|work.md）
    scenes: {
      chat: new SceneStore(dataDir, "chat", logger),
      work: new SceneStore(dataDir, "work", logger)
    },
    persona: {
      chat: new PersonaStore(dataDir, "chat", logger),
      work: new PersonaStore(dataDir, "work", logger)
    },
    state: new StateStore(StateStore.pathFor(dataDir))
  };
  if (storageOk) {
    try {
      await Promise.all([
        stores.l0.init(),
        stores.l1.init(),
        stores.scenes.chat.init(),
        stores.scenes.work.init(),
        stores.persona.chat.init(),
        stores.persona.work.init()
      ]);
    } catch (err) {
      storageOk = false;
      logger.error(
        `[memory] \u5B58\u50A8\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u8BB0\u5FC6\u529F\u80FD\u505C\u7528: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  const caps = db.getCapabilities();
  if (storageOk && config.recall.strategy !== "keyword" && !caps.vectorSearch) {
    logger.warn(
      `[memory] \u68C0\u7D22\u7B56\u7565 ${config.recall.strategy} \u9700\u8981\u5411\u91CF\u80FD\u529B\uFF08embedding \u672A\u542F\u7528/\u4E0D\u53EF\u7528\uFF09\uFF0C\u672C\u6B21\u8FD0\u884C\u6309 keyword\uFF08FTS5 BM25\uFF09\u68C0\u7D22`
    );
  }
  logger.info(
    `[memory] \u6570\u636E\u76EE\u5F55: ${dataDir}\uFF08v${PLUGIN_VERSION}\uFF0C\u9ED8\u8BA4\u6863=${config.family}\uFF0C\u68C0\u7D22: FTS=${caps.ftsSearch} \u5411\u91CF=${caps.vectorSearch}${storageOk ? "" : "\uFF0C\u5B58\u50A8\u4E0D\u53EF\u7528\u5DF2\u505C\u7528\u6355\u83B7/\u84B8\u998F"}\uFF09`
  );
  try {
    const cfgView = effectiveCfg(config, live);
    const route = await resolveModelRoute(ctx, cfgView);
    const chain = buildRouteChain(route, cfgView.llm.fallbacks, cfgView.llm.reasoningEffort);
    logger.info(
      `[memory] \u84B8\u998F\u6A21\u578B\u8DEF\u7531: ${route.provider}/${route.model}${chain.length > 1 ? `\uFF08+${chain.length - 1} \u56DE\u9000\uFF09` : ""}`
    );
  } catch (err) {
    logger.warn(`[memory] \u84B8\u998F\u6A21\u578B\u8DEF\u7531\u89E3\u6790\u5931\u8D25: ${errDetail(err)}`);
  }
  if (storageOk && initial.providerInfo && !db.isDegraded()) {
    const info = initial.providerInfo;
    if (dbInit.needsReindex) {
      if (caps.vectorSearch) {
        void (async () => {
          try {
            if (disposed || embedManagerRef?.isBusy()) return;
            const shouldCancel = () => disposed || !!embedManagerRef?.isBusy();
            const r1 = await stores.l1.reindex({ shouldCancel });
            const r0 = await stores.l0.reindex({ shouldCancel });
            const missingAfter = db.countL1VecMissing(db.getVecSkipSet("l1")) + db.countL0VecMissing(db.getVecSkipSet("l0"));
            if (r1.failed === 0 && r0.failed === 0 && missingAfter === 0) {
              db.markEmbeddingSynced(currentProviderInfo() ?? info);
              const skipNote = r1.skipped + r0.skipped > 0 ? `\uFF0C\u8DF3\u8FC7\u4E0D\u53EF\u5D4C\u5165 ${r1.skipped + r0.skipped} \u6761` : "";
              logger.info(
                `[memory] \u5411\u91CF\u91CD\u5EFA\u5B8C\u6210\uFF1AL1 ${r1.written} \u6761\uFF0CL0 ${r0.written} \u6761${skipNote}\uFF08\u539F\u56E0\uFF1A${dbInit.reason ?? "\u914D\u7F6E\u53D8\u5316"}\uFF09`
              );
            } else {
              logger.warn(
                `[memory] \u5411\u91CF\u91CD\u5EFA\u672A\u5B8C\u6210\uFF08L1 \u5931\u8D25 ${r1.failed}\uFF0CL0 \u5931\u8D25 ${r0.failed}\uFF0C\u5269\u7F3A ${Math.max(missingAfter, 0)} \u6761\uFF09\uFF0C\u4E0B\u6B21\u542F\u52A8/\u8865\u9F50\u5468\u671F\u91CD\u8BD5`
              );
            }
          } catch (err) {
            logger.warn(`[memory] \u5411\u91CF\u91CD\u5EFA\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }
    } else {
      db.markEmbeddingSynced(currentProviderInfo() ?? info);
    }
    {
      const backfill = () => {
        void (async () => {
          try {
            if (disposed) return;
            const infoNow = currentProviderInfo();
            const capsNow = db.getCapabilities();
            if (!infoNow || !capsNow.vectorSearch) return;
            if (embedManagerRef?.isBusy()) return;
            const l1Missing = db.countL1VecMissing(db.getVecSkipSet("l1")) > 0;
            const l0Missing = db.countL0VecMissing(db.getVecSkipSet("l0")) > 0;
            if (!l1Missing && !l0Missing) return;
            const shouldCancel = () => disposed || !!embedManagerRef?.isBusy();
            const r1 = await stores.l1.reindex({ shouldCancel });
            const r0 = await stores.l0.reindex({ shouldCancel });
            const missingAfter = db.countL1VecMissing(db.getVecSkipSet("l1")) + db.countL0VecMissing(db.getVecSkipSet("l0"));
            if (r1.failed === 0 && r0.failed === 0 && missingAfter === 0) {
              db.markEmbeddingSynced(infoNow);
              logger.info(
                `[memory] \u5411\u91CF\u8865\u9F50\u5B8C\u6210\uFF1AL1 ${r1.written} \u6761\uFF0CL0 ${r0.written} \u6761\uFF08\u8DF3\u8FC7\u4E0D\u53EF\u5D4C\u5165 ${r1.skipped + r0.skipped} \u6761\uFF09`
              );
            } else if (r1.failed > 0 || r0.failed > 0) {
              logger.warn(`[memory] \u5411\u91CF\u8865\u9F50\u672A\u5B8C\u6210\uFF08L1 \u5931\u8D25 ${r1.failed}\uFF0CL0 \u5931\u8D25 ${r0.failed}\uFF09\uFF0C\u4E0B\u4E2A\u5468\u671F\u91CD\u8BD5`);
            }
          } catch (err) {
            logger.warn(`[memory] \u5411\u91CF\u8865\u9F50\u5931\u8D25: ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      };
      ctx.effect(() => {
        const timer = setInterval(backfill, 30 * 6e4);
        const first = setTimeout(backfill, 6e4);
        return () => {
          clearInterval(timer);
          clearTimeout(first);
        };
      });
    }
  }
  const embedManager = storageOk && !db.isDegraded() ? new EmbeddingManager({
    dataDir,
    cfg: config,
    db,
    l0: stores.l0,
    l1: stores.l1,
    sourceStore,
    installer,
    downloader,
    initial,
    logger,
    makeLocal: makeLocalService
  }) : void 0;
  embedManagerRef = embedManager;
  const runner = new MemoryRunner(ctx, config, stores, logger, live, modes);
  await runner.init();
  modes.setModeChangeHandler((sessionId, oldMode, newMode) => runner.onModeChange(sessionId, oldMode, newMode));
  runner.startIdleTimer();
  const rebuild = storageOk && !db.isDegraded() ? new RebuildController(ctx, config, stores, db, runner, logger, live) : void 0;
  let flushL0;
  if (storageOk) {
    flushL0 = registerCapture(ctx, config, runner, stores.l0, logger, live, modes);
  }
  const recall = registerRecall(ctx, config, stores, logger, live, modes, dataDir);
  runner.setAfterRun(recall.invalidateProfile);
  registerMemoryTools(ctx, config, stores, logger, modes, live);
  registerMemoryRpc(
    ctx,
    config,
    stores,
    logger,
    {
      degraded: () => !storageOk || db.isDegraded(),
      pending: () => runner.pendingCount
    },
    live,
    modes,
    dataDir,
    rebuild,
    embedManager,
    // 悬浮卡信息区数据源（session-stats 热路径端点；全部内存读 + 索引 COUNT，零文件 I/O）
    {
      recallStats: (sid) => recall.stats(sid),
      memoryOccupancy: (sid) => recall.occupancy(sid),
      profileEstimate: (sid) => recall.estimateProfileTokens(sid),
      recallEstimate: (sid) => recall.estimateRecallTokens(sid),
      runnerView: (sid, mode) => runner.sessionView(sid, mode),
      l0Count: (sid) => stores.l0.countBySession(sid),
      capabilities: () => db.getCapabilities(),
      // 工作台洞察聚合（runtime-insights；进程内注册表读取，同样零文件 I/O）
      recallStatsAll: () => recall.statsAll()
    }
  );
  if (config.benchControl && rebuild) {
    const disposeBench = registerBenchControl(ctx, rebuild, modes, logger);
    ctx.effect(() => () => disposeBench());
  }
  logger.info(
    `[memory] L0~L3 \u5206\u5C42\u84B8\u998F\u8BB0\u5FC6\u63D2\u4EF6\u5C31\u7EEA\uFF08L1 \u8BB0\u5FC6 ${storageOk ? stores.l1.size : 0} \u6761 | \u6355\u83B7=${storageOk && config.capture.enabled} | \u84B8\u998F=${storageOk && config.extract.enabled} | \u53EC\u56DE=${config.recall.enabled}\uFF09`
  );
  ctx.effect(() => () => {
    disposed = true;
    runner.stop();
    embedManager?.dispose();
    downloader.dispose();
    return (async () => {
      await flushL0?.();
      db.close();
      resetTokenCost();
    })();
  });
}
export {
  Config,
  apply,
  inject,
  name
};

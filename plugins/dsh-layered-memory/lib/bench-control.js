import { snapshotDistillUsage } from "./llm-usage.js";
const BENCH_CONTROL_SERVICE = "dsh-memory-bench";
function registerBenchControl(ctx, rebuild, modes, logger) {
  const surface = {
    rebuildStart: () => rebuild.start(),
    rebuildStatus: () => rebuild.getStatus(),
    setSessionMode: (sessionId, mode) => modes.set(sessionId, mode),
    getSessionMode: (sessionId) => modes.get(sessionId),
    getDistillUsage: () => snapshotDistillUsage()
  };
  const dispose = ctx.provide(BENCH_CONTROL_SERVICE, surface);
  logger.info("[memory] bench \u63A7\u5236\u670D\u52A1\u5DF2\u63D0\u4F9B\uFF08dsh-memory-bench\uFF0C\u4EC5\u57FA\u51C6/\u8C03\u8BD5\u90E8\u7F72\uFF09");
  return dispose;
}
export {
  BENCH_CONTROL_SERVICE,
  registerBenchControl
};

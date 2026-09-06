import { appendFileSync, existsSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const ROTATE_FAIL_LIMIT = 5;
const SIZE_CHECK_INTERVAL = 32;
function errDetail(err) {
  if (err instanceof Error) return `${err.message} @ ${err.stack?.split("\n")[1]?.trim() ?? err.name}`;
  return String(err);
}
function withFileLog(dataDir, logger) {
  const logPath = join(dataDir, "memory.log");
  let rotateFailures = 0;
  let writesSinceCheck = 0;
  const write = (level, msg) => {
    try {
      if (writesSinceCheck++ % SIZE_CHECK_INTERVAL === 0 && existsSync(logPath) && statSync(logPath).size > MAX_LOG_BYTES) {
        try {
          renameSync(logPath, `${logPath}.1`);
          rotateFailures = 0;
        } catch {
          if (++rotateFailures >= ROTATE_FAIL_LIMIT) {
            writeFileSync(logPath, "");
            rotateFailures = 0;
          }
        }
      }
      appendFileSync(logPath, `${(/* @__PURE__ */ new Date()).toISOString()} [${level}] ${msg}
`);
    } catch {
    }
  };
  return {
    debug: (m) => logger.debug?.(m),
    info: (m) => {
      logger.info(m);
      write("info", m);
    },
    warn: (m) => {
      logger.warn(m);
      write("warn", m);
    },
    error: (m) => {
      logger.error(m);
      write("error", m);
    }
  };
}
export {
  SIZE_CHECK_INTERVAL,
  errDetail,
  withFileLog
};

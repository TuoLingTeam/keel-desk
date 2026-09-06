import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}
async function atomicWriteText(file, content) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await fs.writeFile(tmp, content, "utf-8");
    const fh = await fs.open(tmp, "r+");
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {
    });
    throw err;
  }
}
async function atomicWriteJson(file, value) {
  await atomicWriteText(file, JSON.stringify(value, null, 2));
}
async function readJsonIfExists(file) {
  try {
    const raw = await fs.readFile(file, "utf-8");
    return JSON.parse(raw);
  } catch {
    return void 0;
  }
}
async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return void 0;
  }
}
async function appendJsonl(file, lines) {
  if (lines.length === 0) return;
  await ensureDir(path.dirname(file));
  const payload = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
  await fs.appendFile(file, payload, "utf-8");
}
async function readJsonl(file) {
  try {
    const raw = await fs.readFile(file, "utf-8");
    const out = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
      }
    }
    return out;
  } catch {
    return [];
  }
}
function nowIso() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function dayKey(ts) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}
export {
  appendJsonl,
  atomicWriteJson,
  atomicWriteText,
  dayKey,
  ensureDir,
  nowIso,
  readJsonIfExists,
  readJsonl,
  readTextIfExists
};

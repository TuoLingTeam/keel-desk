window.__ModuleLoader__.load({ id: "dsh-attachment", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/dsh-attachments/src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  internals: () => internals
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var CLIENT_BUNDLE_ID = "dsh-attachment";
var AUTO_DRAFT_MARKER = "\u2063";
var ATTACHMENT_SOURCE_FIELD = "dshAttachments";
var ROUTE_PREFIX = "/dsh-attachments/files";
var NATIVE_IMAGE_TYPES = /* @__PURE__ */ new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
var DraftFiles = class {
  rows = /* @__PURE__ */ new Map();
  listeners = /* @__PURE__ */ new Map();
  snapshot(sessionId) {
    return this.rows.get(sessionId) ?? EMPTY_FILES;
  }
  subscribe(sessionId, listener) {
    let group = this.listeners.get(sessionId);
    if (group === void 0) {
      group = /* @__PURE__ */ new Set();
      this.listeners.set(sessionId, group);
    }
    group.add(listener);
    return () => {
      group?.delete(listener);
      if (group?.size === 0) this.listeners.delete(sessionId);
    };
  }
  add(sessionId, file) {
    this.rows.set(sessionId, [...this.snapshot(sessionId), file]);
    this.publish(sessionId);
  }
  update(sessionId, localId, patch) {
    this.rows.set(sessionId, this.snapshot(sessionId).map((file) => file.localId === localId ? { ...file, ...patch } : file));
    this.publish(sessionId);
  }
  remove(sessionId, localId) {
    const next = this.snapshot(sessionId).filter((file) => file.localId !== localId);
    if (next.length === 0) this.rows.delete(sessionId);
    else this.rows.set(sessionId, [...next]);
    this.publish(sessionId);
  }
  committed(sessionId, ids) {
    const next = this.snapshot(sessionId).filter((file) => file.id === void 0 || !ids.has(file.id));
    if (next.length === 0) this.rows.delete(sessionId);
    else this.rows.set(sessionId, [...next]);
    this.publish(sessionId);
  }
  publish(sessionId) {
    for (const listener of this.listeners.get(sessionId) ?? []) listener();
  }
};
var EMPTY_FILES = Object.freeze([]);
var drafts = new DraftFiles();
function useFiles(sessionId) {
  const subscribe = (0, import_react.useCallback)((listener) => drafts.subscribe(sessionId, listener), [sessionId]);
  const snapshot = (0, import_react.useCallback)(() => drafts.snapshot(sessionId), [sessionId]);
  return (0, import_react.useSyncExternalStore)(subscribe, snapshot, snapshot);
}
function copy() {
  const zh = navigator.language.toLowerCase().startsWith("zh");
  return zh ? {
    remove: "\u79FB\u9664",
    uploading: "\u4E0A\u4F20\u4E2D\u2026",
    failed: "\u4E0A\u4F20\u5931\u8D25",
    folderReadFailed: "\u8BFB\u53D6\u6587\u4EF6\u5939\u5931\u8D25",
    download: "\u4E0B\u8F7D\u6587\u4EF6",
    attached: "\u9644\u4EF6",
    folder: "\u6587\u4EF6\u5939",
    files: (count) => `${String(count)} \u4E2A\u6587\u4EF6`
  } : {
    remove: "Remove",
    uploading: "Uploading\u2026",
    failed: "Upload failed",
    folderReadFailed: "Failed to read folder",
    download: "Download file",
    attached: "Attachments",
    folder: "Folder",
    files: (count) => `${String(count)} files`
  };
}
var labels = copy();
function endpoint(sessionId, id) {
  const suffix = id === void 0 ? "" : `/${encodeURIComponent(id)}`;
  return `${ROUTE_PREFIX}${suffix}?sessionId=${encodeURIComponent(sessionId)}`;
}
function nativeImage(file) {
  return NATIVE_IMAGE_TYPES.has(file.type);
}
function partitionDroppedFiles(files) {
  const nativeImages = [];
  const genericFiles = [];
  for (const file of files) {
    if (nativeImage(file)) nativeImages.push(file);
    else genericFiles.push(file);
  }
  return { nativeImages, genericFiles };
}
function extension(name) {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "FILE" : name.slice(dot + 1, dot + 6).toUpperCase();
}
function filenameStem(name) {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}
async function fileFromEntry(entry) {
  return await new Promise((resolve, reject) => {
    entry.file(resolve, reject);
  });
}
async function directoryEntries(entry) {
  const reader = entry.createReader();
  const output = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) return output;
    output.push(...batch);
  }
}
function childName(parent, name) {
  return parent === "" ? name : `${parent}/${name}`;
}
async function directoryMembers(entry, parent = "") {
  const output = [];
  for (const child of await directoryEntries(entry)) {
    const path = childName(parent, child.name || "attachment");
    if (child.isDirectory) {
      const directory = child;
      output.push({ kind: "directory", path });
      output.push(...await directoryMembers(directory, path));
    } else if (child.isFile) {
      const file = await fileFromEntry(child);
      output.push({ kind: "file", path, file });
    }
  }
  return output;
}
async function sourceFromEntry(entry) {
  if (entry.isDirectory) {
    return {
      kind: "directory",
      entry,
      name: entry.name || "folder"
    };
  }
  if (!entry.isFile) return null;
  const file = await fileFromEntry(entry);
  return { kind: "file", file, name: file.name || entry.name || "attachment" };
}
function captureDropItems(transfer) {
  const captured = [];
  for (const item of [...transfer.items]) {
    if (item.kind !== "file") continue;
    let entry = null;
    try {
      entry = item.webkitGetAsEntry();
    } catch {
    }
    captured.push({ entry, file: item.getAsFile() });
  }
  if (captured.length > 0) return captured;
  return [...transfer.files].map((file) => ({ entry: null, file }));
}
function pluginOwnsDrop(items) {
  return items.some((item) => item.entry?.isDirectory === true || item.file !== null && !nativeImage(item.file));
}
async function collectDrop(items) {
  const sources = [];
  const errors = [];
  for (const item of items) {
    try {
      if (item.entry?.isDirectory === true) {
        const source = await sourceFromEntry(item.entry);
        if (source !== null) sources.push(source);
      } else if (item.file !== null) {
        sources.push({
          kind: "file",
          file: item.file,
          name: item.file.webkitRelativePath || item.file.name || "attachment"
        });
      } else if (item.entry?.isFile === true) {
        const source = await sourceFromEntry(item.entry);
        if (source !== null) sources.push(source);
      }
    } catch (error) {
      errors.push({ name: item.entry?.name || item.file?.name || "folder", error });
    }
  }
  return { sources, errors };
}
async function requestFileUpload(sessionId, source) {
  const query = new URLSearchParams({
    sessionId,
    name: source.file.name || "attachment",
    mediaType: source.file.type || "application/octet-stream"
  });
  const response = await fetch(`${ROUTE_PREFIX}?${query.toString()}`, {
    method: "POST",
    headers: { "content-type": source.file.type || "application/octet-stream" },
    body: source.file
  });
  const payload = await response.json();
  if (!response.ok || !payload.ok || payload.file === void 0) {
    throw new Error(payload.error || `HTTP ${String(response.status)}`);
  }
  return payload.file;
}
async function requestDirectoryUpload(sessionId, source, onCreated) {
  const createQuery = new URLSearchParams({
    sessionId,
    kind: "directory",
    name: source.name || "folder",
    mediaType: "inode/directory"
  });
  const createdResponse = await fetch(`${ROUTE_PREFIX}?${createQuery.toString()}`, { method: "POST" });
  const createdPayload = await createdResponse.json();
  if (!createdResponse.ok || !createdPayload.ok || createdPayload.file?.id === void 0) {
    throw new Error(createdPayload.error || `HTTP ${String(createdResponse.status)}`);
  }
  const id = createdPayload.file.id;
  onCreated(id);
  try {
    const members = await directoryMembers(source.entry);
    for (let offset = 0; offset < members.length; offset += UPLOAD_CONCURRENCY) {
      await Promise.all(members.slice(offset, offset + UPLOAD_CONCURRENCY).map(async (member) => {
        const query = new URLSearchParams({
          sessionId,
          kind: member.kind,
          path: member.path
        });
        const response = await fetch(`${ROUTE_PREFIX}/${encodeURIComponent(id)}?${query.toString()}`, {
          method: "PUT",
          ...member.kind === "file" ? {
            headers: { "content-type": member.file?.type || "application/octet-stream" },
            body: member.file
          } : {}
        });
        const payload = await response.json();
        if (!response.ok || !payload.ok) throw new Error(payload.error || `HTTP ${String(response.status)}`);
      }));
    }
    const finalizeResponse = await fetch(endpoint(sessionId, id), { method: "PATCH" });
    const finalized = await finalizeResponse.json();
    if (!finalizeResponse.ok || !finalized.ok || finalized.file === void 0) {
      throw new Error(finalized.error || `HTTP ${String(finalizeResponse.status)}`);
    }
    return finalized.file;
  } catch (error) {
    await fetch(endpoint(sessionId, id), { method: "DELETE" }).catch(() => {
    });
    throw error;
  }
}
async function upload(sessionId, source, localId) {
  try {
    const file = source.kind === "directory" ? await requestDirectoryUpload(sessionId, source, (id) => {
      drafts.update(sessionId, localId, { id });
    }) : await requestFileUpload(sessionId, source);
    drafts.update(sessionId, localId, {
      id: file.id,
      kind: file.kind === "directory" ? "directory" : "file",
      status: "ready",
      size: file.size,
      mediaType: file.mediaType,
      fileCount: file.fileCount
    });
  } catch (error) {
    drafts.update(sessionId, localId, {
      status: "error",
      error: `${source.kind === "directory" ? `${labels.folderReadFailed}: ` : ""}${error instanceof Error ? error.message : String(error)}`
    });
  }
}
var uploadQueue = [];
var activeUploads = 0;
var UPLOAD_CONCURRENCY = 4;
function runUploadQueue() {
  while (activeUploads < UPLOAD_CONCURRENCY) {
    const task = uploadQueue.shift();
    if (task === void 0) return;
    activeUploads += 1;
    void task().finally(() => {
      activeUploads -= 1;
      runUploadQueue();
    });
  }
}
function scheduleUpload(task) {
  uploadQueue.push(task);
  runUploadQueue();
}
function intake(sessionId, sources) {
  for (const source of sources) {
    const localId = crypto.randomUUID();
    drafts.add(sessionId, {
      localId,
      kind: source.kind,
      name: source.name || "attachment",
      mediaType: source.kind === "directory" ? "inode/directory" : source.file.type || "application/octet-stream",
      size: source.kind === "directory" ? 0 : source.file.size,
      status: "uploading"
    });
    scheduleUpload(() => upload(sessionId, source, localId));
  }
}
function reportDropErrors(sessionId, errors) {
  for (const row of errors) {
    drafts.add(sessionId, {
      localId: crypto.randomUUID(),
      kind: "file",
      name: row.name,
      mediaType: "application/octet-stream",
      size: 0,
      status: "error",
      error: `${labels.folderReadFailed}: ${row.error instanceof Error ? row.error.message : String(row.error)}`
    });
  }
}
async function hostState(sessionId, id) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(endpoint(sessionId, id), { method: "HEAD", cache: "no-store" });
      if (response.ok) return response.headers.get("x-dsh-attachment-state") ?? void 0;
    } catch {
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 75 * (attempt + 1)));
  }
  return void 0;
}
async function reconcileCommitted(sessionId) {
  const ready = drafts.snapshot(sessionId).filter(
    (file) => file.status === "ready" && file.id !== void 0
  );
  const states = await Promise.all(ready.map(async (file) => ({ file, state: await hostState(sessionId, file.id) })));
  const committed = new Set(states.filter((row) => row.state === "reserved" || row.state === "committed").map((row) => row.file.id));
  if (committed.size > 0) drafts.committed(sessionId, committed);
  return committed.size;
}
function redispatchImages(files) {
  if (files.length === 0 || typeof DataTransfer === "undefined") return;
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  document.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
}
function clearNativeDropOverlay(dataTransfer) {
  if (dataTransfer === null || typeof DragEvent === "undefined") return;
  document.body.dispatchEvent(new DragEvent("dragleave", {
    bubbles: true,
    clientX: 0,
    clientY: 0,
    dataTransfer
  }));
}
function AttachmentDropOverlay() {
  (0, import_react.useEffect)(() => {
    const mask = document.createElement("div");
    mask.className = "dsh-attachments-drop";
    mask.setAttribute("aria-hidden", "true");
    document.body.append(mask);
    return () => {
      mask.remove();
    };
  }, []);
  return null;
}
function FileGlyph() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("svg", { viewBox: "0 0 20 20", width: "20", height: "20", "aria-hidden": true, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("rect", { x: "4", y: "2.75", width: "12", height: "14.5", rx: "2.25", fill: "none", stroke: "currentColor", strokeWidth: "1.5" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M7 7.25h6M7 10h6M7 12.75h4", fill: "none", stroke: "currentColor", strokeWidth: "1.35", strokeLinecap: "round" })
  ] });
}
function FolderGlyph() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("svg", { viewBox: "0 0 20 20", width: "20", height: "20", "aria-hidden": true, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("path", { d: "M2.75 6.25A2.25 2.25 0 0 1 5 4h3l1.4 1.5H15A2.25 2.25 0 0 1 17.25 7.75v6A2.25 2.25 0 0 1 15 16H5a2.25 2.25 0 0 1-2.25-2.25v-7.5Z", fill: "none", stroke: "currentColor", strokeWidth: "1.5", strokeLinejoin: "round" }) });
}
function FileCard({ file, sessionId, draft, onRemove }) {
  const kind = file.kind === "directory" ? "directory" : "file";
  const href = kind === "directory" || file.id === void 0 ? void 0 : endpoint(sessionId, file.id);
  const suffix = kind === "directory" ? labels.folder : extension(file.name);
  const state = file.status === "uploading" ? labels.uploading : file.status === "error" ? `${labels.failed}${file.error === void 0 ? "" : `\uFF1A${file.error}`}` : void 0;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-attachments-file-card", "data-kind": kind, "data-status": file.status, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-attachments-file-icon", children: kind === "directory" ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FolderGlyph, {}) : /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FileGlyph, {}) }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-attachments-file-copy", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-attachments-file-name", title: file.name, children: kind === "directory" ? file.name : filenameStem(file.name) }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-attachments-file-meta", children: [
        suffix,
        kind === "directory" && file.fileCount !== void 0 ? ` \xB7 ${labels.files(file.fileCount)}` : "",
        state === void 0 ? "" : ` \xB7 ${state}`
      ] })
    ] }),
    draft && onRemove !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)("button", { className: "dsh-attachments-file-action", type: "button", onClick: onRemove, "aria-label": `${labels.remove} ${file.name}`, children: "\xD7" }) : href === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime.jsx)("a", { className: "dsh-attachments-file-action", href, download: file.name, title: labels.download, "aria-label": `${labels.download} ${file.name}`, children: "\u2193" })
  ] });
}
function AttachmentDock({ sessionId, session, input, inputActions }) {
  const files = useFiles(sessionId);
  const dock = (0, import_react.useRef)(null);
  const previousCount = (0, import_react.useRef)(files.length);
  const currentDraft = (0, import_react.useRef)(input.draft);
  currentDraft.current = input.draft;
  const [dragging, setDragging] = (0, import_react.useState)(false);
  const depth = (0, import_react.useRef)(0);
  const locked = session.removed === true || input.phase === "submitting" || input.phase === "adjudicating";
  (0, import_react.useLayoutEffect)(() => {
    const grew = files.length > previousCount.current;
    previousCount.current = files.length;
    if (!grew) return;
    const rail = dock.current?.parentElement;
    if (rail !== null && rail !== void 0) rail.scrollLeft = rail.scrollWidth - rail.clientWidth;
  }, [files.length]);
  const remove = (0, import_react.useCallback)((file) => {
    drafts.remove(sessionId, file.localId);
    if (file.id !== void 0) void fetch(endpoint(sessionId, file.id), { method: "DELETE" });
    const remaining = drafts.snapshot(sessionId);
    if (!remaining.some((candidate) => candidate.status === "ready") && input.draft === AUTO_DRAFT_MARKER) {
      inputActions.setDraft("");
    }
  }, [input.draft, inputActions, sessionId]);
  (0, import_react.useEffect)(() => {
    if (!files.some((file) => file.status === "ready") || input.draft !== "" && input.draft !== AUTO_DRAFT_MARKER) return;
    let active = true;
    void reconcileCommitted(sessionId).then((count) => {
      if (!active || count === 0) return;
      const readyRemain = drafts.snapshot(sessionId).some((file) => file.status === "ready");
      if (!readyRemain && currentDraft.current === AUTO_DRAFT_MARKER) inputActions.setDraft("");
    });
    return () => {
      active = false;
    };
  }, [files, input.draft, inputActions, sessionId]);
  (0, import_react.useEffect)(() => {
    if (!locked && files.some((file) => file.status === "ready") && input.draft.trim() === "") {
      inputActions.setDraft(AUTO_DRAFT_MARKER);
    }
  }, [files, input.draft, inputActions, locked]);
  (0, import_react.useEffect)(() => {
    const hasFiles = (event) => [...event.dataTransfer?.types ?? []].includes("Files");
    const reset = () => {
      depth.current = 0;
      setDragging(false);
    };
    const enter = (event) => {
      if (!hasFiles(event)) return;
      depth.current += 1;
      setDragging(true);
    };
    const over = (event) => {
      if (!hasFiles(event) || event.dataTransfer === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = locked ? "none" : "copy";
    };
    const leave = (event) => {
      if (!hasFiles(event)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const drop = (event) => {
      if (!hasFiles(event) || event.dataTransfer === null) return;
      reset();
      const captured = captureDropItems(event.dataTransfer);
      if (!pluginOwnsDrop(captured)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      clearNativeDropOverlay(event.dataTransfer);
      if (locked) {
        return;
      }
      void collectDrop(captured).then(({ sources, errors }) => {
        const nativeImages = [];
        const genericFiles = [];
        for (const source of sources) {
          if (source.kind === "file" && nativeImage(source.file)) nativeImages.push(source.file);
          else genericFiles.push(source);
        }
        intake(sessionId, genericFiles);
        reportDropErrors(sessionId, errors);
        if (nativeImages.length > 0) redispatchImages(nativeImages);
      });
    };
    document.addEventListener("dragenter", enter, true);
    document.addEventListener("dragover", over, true);
    document.addEventListener("dragleave", leave, true);
    document.addEventListener("drop", drop, true);
    window.addEventListener("dragend", reset);
    return () => {
      document.removeEventListener("dragenter", enter, true);
      document.removeEventListener("dragover", over, true);
      document.removeEventListener("dragleave", leave, true);
      document.removeEventListener("drop", drop, true);
      window.removeEventListener("dragend", reset);
    };
  }, [locked, sessionId]);
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_jsx_runtime.Fragment, { children: [
    files.length > 0 && /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { ref: dock, className: "dsh-attachments-file-dock", "data-attachment-content": "", role: "group", "aria-label": labels.attached, children: files.map((file) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(FileCard, { file, sessionId, draft: true, onRemove: () => {
      remove(file);
    } }, file.localId)) }),
    dragging && /* @__PURE__ */ (0, import_jsx_runtime.jsx)(AttachmentDropOverlay, {})
  ] });
}
var AttachmentHistory = (0, import_react.memo)(function AttachmentHistory2({ sessionId, node }) {
  const data = node.data;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-attachments-history-row", role: "group", "aria-label": labels.attached, children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-attachments-history-stack", children: data.files.map((file) => /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
    FileCard,
    {
      file: { ...file, kind: file.kind === "directory" ? "directory" : "file", localId: file.id, status: "ready" },
      sessionId,
      draft: false
    },
    file.id
  )) }) });
});
function filesOfEvent(event) {
  if (event?.type !== "user/message") return [];
  const files = event.data?.source?.[ATTACHMENT_SOURCE_FIELD];
  if (!Array.isArray(files)) return [];
  return files.filter((file) => file && typeof file.id === "string" && typeof file.name === "string" && typeof file.mediaType === "string" && Number.isFinite(file.size) && (file.kind === void 0 || file.kind === "file" || file.kind === "directory"));
}
var attachmentDefinition = {
  kind: "dsh-attachments",
  target: "chat",
  match(event) {
    const files = filesOfEvent(event);
    return files.length === 0 ? null : { id: String(event.data.id), role: "start" };
  },
  start(_context, match) {
    const event = match.event;
    return {
      seq: event.seq,
      time: event.time,
      messageId: String(event.data.id),
      files: filesOfEvent(event)
    };
  },
  update(context) {
    return context.state;
  },
  buildViewNode(context) {
    if (context.state === void 0) return null;
    return {
      key: context.key,
      kind: "dsh-attachments",
      id: context.id,
      target: "chat",
      anchorSeq: context.state.seq + 0.01,
      location: context.start?.location ?? { kind: "unresolved" },
      visibility: "visible",
      data: context.state
    };
  }
};
var STYLES = String.raw`
.dsh-attachments-file-dock{display:flex;flex:0 0 auto;align-items:center;gap:10px}
.dsh-attachments-file-card{position:relative;box-sizing:border-box;display:flex;align-items:center;gap:10px;width:224px;height:56px;flex:0 0 224px;padding:7px 28px 7px 7px;overflow:hidden;border:1px solid var(--dsw-alias-border-l2-darkmode-thin,#d9dce1);border-radius:12px;background:var(--dsw-specific-input-major,var(--dsw-alias-bg-layer-1,#fff));color:var(--dsw-alias-label-primary,#111)}
.dsh-attachments-file-card[data-status=error]{border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.dsh-attachments-file-icon{display:grid;place-items:center;width:40px;height:40px;flex:0 0 40px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2,#f3f4f6));color:var(--dsw-alias-label-secondary,#6b7280)}
.dsh-attachments-file-copy{display:flex;min-width:0;flex:1;flex-direction:column;gap:2px}.dsh-attachments-file-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;font-weight:650;line-height:19px}.dsh-attachments-file-meta{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;line-height:16px}
.dsh-attachments-file-action{position:absolute;top:4px;right:4px;z-index:1;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-button-contrast-fill,#fff);color:var(--dsw-alias-label-primary-inverted,#111);font-size:14px;font-weight:600;line-height:1;text-decoration:none;cursor:pointer;opacity:.96}.dsh-attachments-file-action:hover{transform:scale(1.06);opacity:1}
.dsh-attachments-drop{position:fixed;inset:10px;z-index:2147483647;box-sizing:border-box;border:2px dashed var(--dsw-alias-label-primary,#111);border-radius:18px;background:transparent;pointer-events:none;animation:dsh-attachments-drop-in .14s ease-out}@keyframes dsh-attachments-drop-in{from{opacity:0}to{opacity:1}}
.dsh-attachments-history-row{display:flex;justify-content:flex-end;padding:0 0 8px}.dsh-attachments-history-stack{display:flex;max-width:min(72%,620px);flex-wrap:wrap;justify-content:flex-end;gap:8px}
@media(prefers-reduced-motion:reduce){.dsh-attachments-drop{animation:none}.dsh-attachments-file-action:hover{transform:none}}@media(max-width:700px){.dsh-attachments-history-stack{max-width:90%}.dsh-attachments-file-card{width:200px;flex-basis:200px}}
`;
function installStyles() {
  const existing = document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`);
  if (existing !== null) return () => {
  };
  const style = document.createElement("style");
  style.dataset.plugin = CLIENT_BUNDLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}
var inject = ["slots", "conversationEvents"];
function apply(ctx) {
  ctx.effect(installStyles, "dsh-attachments: styles");
  ctx.conversationEvents.register(attachmentDefinition);
  ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
    name: "conversation.chat.node",
    key: "dsh-attachments"
  }, AttachmentHistory));
  ctx.slots.inject("conversation.input.attachments", () => ctx.slots.register({
    name: "conversation.input.attachments",
    id: "dsh-attachments-files",
    order: -10
  }, AttachmentDock));
}
var internals = {
  attachmentDefinition,
  directoryMembers,
  filesOfEvent,
  collectDrop,
  nativeImage,
  partitionDroppedFiles,
  pluginOwnsDrop
};
return module.exports; } });
//# sourceMappingURL=client.js.map

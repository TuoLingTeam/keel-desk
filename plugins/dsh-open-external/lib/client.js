window.__ModuleLoader__.load({ id: "dsh-open-external", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// plugins/dsh-open-external/src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  internals: () => internals,
  isExternalHttp: () => isExternalHttp
});
module.exports = __toCommonJS(client_exports);
var OPEN_COMMAND = "plugin:opener|open_url";
var PARENT_OPEN_MESSAGE = "dsh-open-external";
function openExternal(url) {
  const internals2 = window.__TAURI_INTERNALS__;
  const invoke = internals2?.invoke;
  if (typeof invoke === "function") {
    void Promise.resolve(invoke(OPEN_COMMAND, { url })).catch(() => {
      fallback(url);
    });
    return;
  }
  fallback(url);
}
function fallback(url) {
  try {
    if (window.parent !== window) {
      window.parent.postMessage({ type: PARENT_OPEN_MESSAGE, url }, "*");
      return;
    }
  } catch {
  }
  try {
    window.open(url, "_blank", "noopener,noreferrer");
  } catch {
  }
}
function isExternalHttp(href) {
  if (!/^https?:\/\//i.test(href)) return false;
  try {
    return new URL(href).origin !== window.location.origin;
  } catch {
    return false;
  }
}
function installExternalLinkOpener() {
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const start = event.target;
    const anchor = start !== null && typeof start.closest === "function" ? start.closest("a[href]") : null;
    if (anchor === null) return;
    const href = anchor.href;
    if (!isExternalHttp(href)) return;
    event.preventDefault();
    event.stopPropagation();
    openExternal(href);
  };
  document.addEventListener("click", onClick, true);
  return () => {
    document.removeEventListener("click", onClick, true);
  };
}
var inject = [];
function apply(ctx) {
  ctx.effect(installExternalLinkOpener, "dsh-open-external: intercept external links");
}
var internals = { isExternalHttp };
return module.exports; } });
//# sourceMappingURL=client.js.map

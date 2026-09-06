window.__ModuleLoader__.load({ id: "dsh-retry", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// plugins/dsh-retry/src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  internals: () => internals
});
module.exports = __toCommonJS(client_exports);
var import_react = require("react");
var import_jsx_runtime = require("react/jsx-runtime");
var NS = "dsh-retry";
var CLIENT_BUNDLE_ID = "dsh-retry";
var ROUTE_PREFIX = "/dsh-retry";
var DEFAULT_MAX_RETRIES = 99999;
var zh = {
  "title": "\u6A21\u578B\u8BF7\u6C42\u91CD\u8BD5\u6B21\u6570",
  "desc": "\u5355\u6B21\u6A21\u578B\u8BF7\u6C42\u5931\u8D25\u540E\u6700\u591A\u81EA\u52A8\u91CD\u8BD5\u591A\u5C11\u6B21\uFF08\u5BF9\u6240\u6709\u6A21\u578B\u751F\u6548\uFF09\u3002\u9ED8\u8BA4 99999 \u2248 \u4E00\u76F4\u91CD\u8BD5\uFF1B\u586B 0 \u8868\u793A\u4E0D\u91CD\u8BD5\u3002",
  "unit": "\u6B21"
};
var en = {
  "title": "Model request retries",
  "desc": "How many times a failed model request retries automatically (applies to every model). Default 99999 \u2248 retry forever; 0 disables retries.",
  "unit": "times"
};
function fallbackTranslate(key) {
  const dict = typeof navigator !== "undefined" && navigator.language.startsWith("zh") ? zh : en;
  return dict[key] ?? key;
}
function RetryCountRow({ t: injected }) {
  const t = injected ?? fallbackTranslate;
  const [value, setValue] = (0, import_react.useState)(DEFAULT_MAX_RETRIES);
  const [draft, setDraft] = (0, import_react.useState)(String(DEFAULT_MAX_RETRIES));
  const [invalid, setInvalid] = (0, import_react.useState)(false);
  const loaded = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    let alive = true;
    void fetch(`${ROUTE_PREFIX}`, { cache: "no-store" }).then((response) => response.json()).then((data) => {
      if (!alive || data == null || typeof data.maxRetries !== "number") return;
      loaded.current = true;
      setValue(data.maxRetries);
      setDraft(String(data.maxRetries));
    }).catch(() => {
    });
    return () => {
      alive = false;
    };
  }, []);
  const commit = () => {
    const trimmed = draft.trim();
    const next = Number(trimmed);
    if (trimmed === "" || !Number.isSafeInteger(next) || next < 0) {
      setInvalid(true);
      setDraft(String(value));
      window.setTimeout(() => {
        setInvalid(false);
      }, 1200);
      return;
    }
    setInvalid(false);
    if (next === value) {
      setDraft(String(next));
      return;
    }
    setValue(next);
    setDraft(String(next));
    void fetch(`${ROUTE_PREFIX}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ maxRetries: next })
    }).catch(() => {
    });
  };
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-retry-row", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-retry-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-retry-title", children: t("title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("div", { className: "dsh-retry-desc", children: t("desc") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "dsh-retry-control", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        "input",
        {
          type: "number",
          min: 0,
          step: 1,
          inputMode: "numeric",
          className: `dsh-retry-input${invalid ? " dsh-retry-input-invalid" : ""}`,
          value: draft,
          "aria-label": t("title"),
          onChange: (event) => {
            setDraft(event.target.value);
          },
          onBlur: commit,
          onKeyDown: (event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.target.blur();
            }
          }
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-retry-unit", children: t("unit") })
    ] })
  ] });
}
var STYLES = String.raw`
.dsh-retry-row{display:flex;align-items:center;justify-content:space-between;gap:16px;min-width:0}
.dsh-retry-text{display:flex;flex:1 1 auto;min-width:0;flex-direction:column;gap:2px}
.dsh-retry-title{color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;font-weight:500}
.dsh-retry-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:17px}
.dsh-retry-control{flex:none;display:inline-flex;align-items:center;gap:6px}
.dsh-retry-input{box-sizing:border-box;width:110px;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;text-align:right;font-variant-numeric:tabular-nums}
.dsh-retry-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsh-retry-input-invalid{border-color:var(--dsw-alias-state-error-primary)}
.dsh-retry-unit{color:var(--dsw-alias-label-tertiary);font-size:12px}
`;
function installStyles() {
  if (document.querySelector(`style[data-plugin="${CLIENT_BUNDLE_ID}"]`) !== null) return () => {
  };
  const style = document.createElement("style");
  style.dataset.plugin = CLIENT_BUNDLE_ID;
  style.textContent = STYLES;
  document.head.appendChild(style);
  return () => {
    style.remove();
  };
}
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-retry: dictionaries");
  ctx.effect(installStyles, "dsh-retry: styles");
  ctx.slots.inject("settings.general.item", () => ctx.slots.register(
    { name: "settings.general.item", id: "dsh-retry", order: 50, locale: NS },
    RetryCountRow
  ));
}
var internals = { RetryCountRow };
return module.exports; } });
//# sourceMappingURL=client.js.map

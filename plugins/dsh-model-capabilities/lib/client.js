window.__ModuleLoader__.load({ id: "dsh-model-capability", factory: (require) => { var module = { exports: {} }; var exports = module.exports;
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

// plugins/dsh-model-capabilities/src/client.tsx
var client_exports = {};
__export(client_exports, {
  apply: () => apply,
  inject: () => inject,
  internals: () => internals
});
module.exports = __toCommonJS(client_exports);
var import_jsx_runtime = require("react/jsx-runtime");
var CLIENT_BUNDLE_ID = "dsh-model-capability";
var NS = "dsh-model-capability";
var en = {
  label: "Input modalities",
  hint: "Used by Harness to validate attachments before sending.",
  inherit: "Inherit provider default",
  text: "Text",
  image: "Image",
  textImage: "Text + image"
};
var zh = {
  label: "\u8F93\u5165\u7C7B\u578B",
  hint: "\u7528\u4E8E Harness \u5728\u53D1\u9001\u9644\u4EF6\u524D\u5224\u65AD\u6A21\u578B\u80FD\u529B\u3002",
  inherit: "\u7EE7\u627F\u63D0\u4F9B\u65B9\u9ED8\u8BA4\u503C",
  text: "\u6587\u672C",
  image: "\u56FE\u7247",
  textImage: "\u6587\u672C + \u56FE\u7247"
};
var DEFAULT_SELECTION = "text-image";
function selectionOf(value) {
  if (!Array.isArray(value) || value.length === 0) return DEFAULT_SELECTION;
  const text = value.includes("text");
  const image = value.includes("image");
  if (text && image) return "text-image";
  if (image) return "image";
  if (text) return "text";
  return "inherit";
}
function patchForSelection(selection) {
  switch (selection) {
    case "inherit":
      return { input: void 0 };
    case "text":
      return { input: ["text"] };
    case "image":
      return { input: ["image"] };
    case "text-image":
      return { input: ["text", "image"] };
  }
}
function ModelInputField({ model, index, disabled, update, t }) {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("label", { className: "dsh-model-capability-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "dsh-model-capability-copy", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-model-capability-label", children: t("label") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-model-capability-hint", children: t("hint") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "dsh-model-capability-select-wrap", children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(
      "select",
      {
        className: "dsh-model-capability-select",
        value: selectionOf(model.input),
        "aria-label": `${t("label")} ${String(index + 1)}`,
        disabled,
        onChange: (event) => {
          update(patchForSelection(event.target.value));
        },
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "inherit", children: t("inherit") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "text", children: t("text") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "text-image", children: t("textImage") }),
          /* @__PURE__ */ (0, import_jsx_runtime.jsx)("option", { value: "image", children: t("image") })
        ]
      }
    ) })
  ] });
}
var STYLES = `
.dsh-model-capability-field{grid-column:1/-1;display:flex;align-items:center;justify-content:space-between;gap:14px;min-width:0;padding:8px 0 0;border-top:1px solid var(--dsw-alias-border-l2)}
.dsh-model-capability-copy{display:flex;flex:1 1 auto;min-width:0;flex-direction:column;gap:1px}.dsh-model-capability-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:500}.dsh-model-capability-hint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.dsh-model-capability-select-wrap{position:relative;flex:0 1 220px;min-width:160px}.dsh-model-capability-select{box-sizing:border-box;width:100%;height:32px;padding:0 32px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;appearance:none;background-color:var(--dsw-alias-bg-layer-1);background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M3 4.5L6 7.5L9 4.5' stroke='%2381858C' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 10px center;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}
.dsh-model-capability-select:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}.dsh-model-capability-select:disabled{cursor:default;opacity:.6}
@media(max-width:560px){.dsh-model-capability-field{align-items:stretch;flex-direction:column;gap:6px}.dsh-model-capability-select-wrap{flex-basis:auto;width:100%}}
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
var inject = ["slots", "locale"];
function apply(ctx) {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-model-capability: dictionaries");
  ctx.effect(installStyles, "dsh-model-capability: styles");
  ctx.slots.inject("settings.models.model.fields", () => ctx.slots.register({
    name: "settings.models.model.fields",
    id: "input-modalities",
    order: 0,
    locale: NS
  }, ModelInputField));
}
var internals = { selectionOf, patchForSelection };
return module.exports; } });
//# sourceMappingURL=client.js.map

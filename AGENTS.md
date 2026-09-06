# AGENTS.md

给在本仓库（DeepSeek Harness Desktop）工作的所有 Agent 的硬性约定。

## 📦 发布打包（铁律）

1. **所有打包产物必须放进 `/Volumes/编程工具/发布包/`**，不要留在 `src-tauri/target/` 或 `dist/` 就完事。
2. 命名：`DeepSeek-Harness-Desktop-<版本>-macos-<arch>.<dmg|app.zip>`，每个产物**都要附同名 `.sha256`**。版本取 `package.json` 的 `version`，arch 用 `arm64`。
3. **打包必须用「自包含（静态链接）的官方 Node」**，不能用 Homebrew 的 `node`（会在 smoke 阶段 `dyld: Library not loaded: @rpath/libnode.*.dylib` 失败，打出来的 app 也起不来）。可直接借用已装 app 里那个：`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node`。

一键打包命令（已含所有绕过）：

```bash
cd /Volumes/编程工具/deepseek-harness-desktop && \
npm_config_verify_deps_before_run=false npm_config_confirm_modules_purge=false DSH_TELEMETRY_DISABLED=1 \
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node" scripts/build-release.mjs
```

- 两个 `npm_config_*=false`：关掉 pnpm 非 TTY 下的依赖自愈（否则 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`）。
- `.app` 在 `src-tauri/target/release/bundle/macos/`；`.dmg` 最后一步偶发 `hdiutil 卸载 资源忙` 失败，但 `.app` 已完整，可用 `hdiutil` 自建 dmg。

## 📖 完整教程（务必先读）

**打包 / 发布 / 安装 / 故障排查的完整步骤见 [`docs/RELEASE-PACKAGING.md`](docs/RELEASE-PACKAGING.md)。**
同一份也放在发布目录 `/Volumes/编程工具/发布包/打包发布教程.md`。

# CLAUDE.md

本仓库（DeepSeek Harness Desktop）的 Agent 约定与 [`AGENTS.md`](AGENTS.md) 一致，这里只放最要紧的。

## 📦 发布打包（铁律）

- **所有打包产物放进 `/Volumes/编程工具/发布包/`**，命名 `DeepSeek-Harness-Desktop-<版本>-macos-<arch>.<dmg|app.zip>` + 同名 `.sha256`。
- **必须用自包含（静态链接）的官方 Node 打包**，不能用 Homebrew 的 node（否则 `dyld: Library not loaded: @rpath/libnode.*.dylib`）。借用已装 app 里那个即可。

一键命令：

```bash
cd /Volumes/编程工具/deepseek-harness-desktop && \
npm_config_verify_deps_before_run=false npm_config_confirm_modules_purge=false DSH_TELEMETRY_DISABLED=1 \
"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/node" scripts/build-release.mjs
```

## 📖 完整教程

打包 / 发布 / 安装 / 故障排查见 **[`docs/RELEASE-PACKAGING.md`](docs/RELEASE-PACKAGING.md)**（同一份也在 `/Volumes/编程工具/发布包/打包发布教程.md`）。

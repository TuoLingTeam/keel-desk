# Marketplace submission / 插件市场提交

本文件记录 npm 包 `dsh-model-capability` 向 `awesome-dsh-plugin` 提交时需要复制的资料。
插件本体仍以独立仓库维护，`marketplace/` 中的文件只是提交模板。

## Catalog entry / 目录条目

将 [`marketplace/WJZ-P__dsh-model-capabilities.yml`](marketplace/WJZ-P__dsh-model-capabilities.yml)
复制到市场仓库中的：

```text
data/plugins/WJZ-P__dsh-model-capabilities.yml
```

随后在市场仓库执行：

```sh
npm ci
node scripts/generate-readme.mjs
```

## Project icon / 项目图标

插件包通过 `package.json#icon` 声明项目图标：

```text
https://raw.githubusercontent.com/WJZ-P/dsh-model-capabilities/main/assets/markdown/model-capability.svg
```

市场目录 YAML 当前只接收 `url`、`name`、`category`、`description`、`tarball`，因此图标 URL 保存在包 manifest 与 PR 资料中，避免写入会被校验拒绝的未知字段。

## Screenshots / 截图

当前 README 与市场示例已使用第一张截图；展开后的选项列表可继续作为第二张可选截图：

```text
assets/screenshots/01-model-input-selector.png
assets/screenshots/02-model-input-options.png
```

- 第一张展示模型编辑区域及“输入类型”字段，已保存并纳入 npm 包；
- 第二张展示展开后的输入类型选项；
- 截图中应隐藏 API Key、账号信息及本机路径；
- 第一张已推送到 `main`，把仓库内
  [`marketplace/screenshots.entry.json`](marketplace/screenshots.entry.json)
  的条目合并到市场仓库的 `data/screenshots.json`：

```json
{
  "https://github.com/WJZ-P/dsh-model-capabilities": [
    "https://raw.githubusercontent.com/WJZ-P/dsh-model-capabilities/main/assets/screenshots/01-model-input-selector.png"
  ]
}
```

## Final checks / 最终检查

- 仓库创建时间达到市场要求；
- 默认分支至少包含 10 个有效提交；
- GitHub Topic 包含 `dsh-plugin`；
- `package.json` 同时声明 `dsh.bundle` 与 Web `dsh.client`；
- GitHub Actions、市场 lint 与站点构建全部通过；
- PR 描述可从 [`marketplace/PR_BODY.md`](marketplace/PR_BODY.md) 复制。

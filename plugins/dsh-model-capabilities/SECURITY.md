# Security Policy / 安全策略

## Supported versions / 支持版本

Security fixes are maintained for the latest `1.0.x` release and the current
`main` branch.

安全修复覆盖最新的 `1.0.x` 版本及当前 `main` 分支。

## Reporting a vulnerability / 报告安全问题

Use the repository's **Security → Report a vulnerability** form when it is
available. If the form is not visible, open an issue that only asks the
maintainer for a private contact channel; keep exploit details and credentials
out of the public issue.

优先使用仓库中的 **Security → Report a vulnerability** 表单。若页面暂未显示该表单，
请仅创建一个请求私下沟通渠道的 Issue，并避免在公开 Issue 中附带利用细节或凭据。

Please include the affected plugin and Harness versions, browser, operating
system, a minimal reproduction, and the expected impact.

请附上受影响的插件与 Harness 版本、浏览器、操作系统、最小复现及预期影响。

## Configuration boundary / 配置边界

The plugin only contributes the model `input` field through Harness's public
settings slot. Reports involving unauthorized configuration changes, unsafe
rendering, or persistence outside the selected model row are especially useful.

插件仅通过 Harness 的公开设置扩展点提交模型 `input` 字段。越权修改配置、不安全渲染，
或写入当前模型条目之外的数据等问题均属于重点关注范围。

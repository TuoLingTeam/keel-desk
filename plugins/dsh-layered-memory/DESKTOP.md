# Desktop 接入

本目录是 [dsh-layered-memory](https://github.com/JunNanLYS/dsh-layered-memory) 在 DeepSeek Harness Desktop 上的复刻：

- Host 半边走 `lib/index.mjs`（L0–L3 捕获 / 蒸馏 / 召回 / RPC）
- Client 半边走 `lib/client.js`（设置 → 记忆工作台 + 输入栏记忆芯片）
- 适配 DSH `0.1.0-rc.5`：`rpc.handle('/rpc', handler, { authority: 'loopback' })`
- 输入栏从 `InputZone.session.sessionId` 取会话，而不是裸字符串
- 设置页卡片分层靠 `--dsw-alias-bg-layer-2`，不再给内容卡描边

数据目录默认 `$DSH_HOME/memory`。`sqlite-vec` / jieba / undici 缺失时自动降级（纯 FTS、无代理下载），不拖垮宿主。

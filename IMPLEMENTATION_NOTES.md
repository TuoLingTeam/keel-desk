# 实施说明 / Implementation Notes

针对 `deepseek-harness-desktop-需求与验收.md` 的落地记录：改了哪些文件、为什么这样改、
怎么复现构建、以及哪些验收项还需要人眼确认。

- 仓库：`/Volumes/编程工具/deepseek-harness-desktop`
- 交付产物：`/Volumes/编程工具/DeepSeek Harness.app`（macOS arm64，ad-hoc 签名）

---

## 0. 先读这两条

**① 机器上同时存在三个 Harness，测的时候极易搞混。**

| 位置 | 是什么 | 含不含本次改动 |
|---|---|---|
| `/Volumes/编程工具/DeepSeek Harness.app` | 本次交付 | **含** |
| `/Applications/DeepSeek Harness.app` | 8月15 下载的 v1.0.0 | 不含 |
| `/opt/homebrew/bin/dsh`（全局 npm 包 v0.1.0-rc.7） | 独立安装 | 不含 |

三者**图标与窗口标题完全相同**，且共用 `~/.dsh`，因此会显示同一批会话——只看界面无法分辨。
验收前请退出并删除 `/Applications` 里那个旧版，否则很容易对着旧版说「没实现」。

**② 需求文档 §7 引用的旧实现已经不存在。**
`/Volumes/编程工具/dsh-desktop/`（含 `plugins/dsh-image-ocr/` 的 Swift 源码与安装脚本）
在全部卷、home 目录和废纸篓中均已找不到，只剩编译好的 `/opt/homebrew/bin/dsh-ocr`。
因此 OCR 助手是**照着二进制的行为重写**的，不是迁移；已逐行比对确认输出一致（见 §4）。

---

## 1. 安装与构建（§1）

```bash
git clone https://github.com/WJZ-P/deepseek-harness-desktop.git
cd deepseek-harness-desktop
pnpm install
pnpm run plugin:sync      # 必须先跑：harness:prepare 依赖 plugins/ 已存在
pnpm run harness:prepare
```

### ⚠ 必须用官方 Node 构建发行包，不能用 Homebrew 的 Node

`scripts/build-release.mjs` 把**当前运行构建的那个 node 可执行文件**直接复制进应用包
（第 399 行 `copyFile(process.execPath, nodePath)`）。Homebrew 的 node 是动态链接的：

```
@rpath/libnode.147.dylib
/opt/homebrew/opt/llhttp/lib/libllhttp.9.4.dylib
/opt/homebrew/opt/libuv/lib/libuv.1.dylib
/opt/homebrew/opt/ada-url/lib/libada.3.dylib
```

这些 dylib 不会被一起复制，于是打出来的包一启动就死在
`dyld: Library not loaded: @rpath/libnode.147.dylib`。
官方 nodejs.org 的二进制是静态的（只依赖系统框架），必须用它：

```bash
curl -sSL -o /tmp/node.tar.gz https://nodejs.org/dist/v26.0.0/node-v26.0.0-darwin-arm64.tar.gz
tar xzf /tmp/node.tar.gz -C /tmp
export PATH="/tmp/node-v26.0.0-darwin-arm64/bin:$PATH"

pnpm run build
```

产物在 `src-tauri/target/release/bundle/macos/DeepSeek Harness.app`，用 `ditto` 复制到目标位置
（`cp -R` 会丢扩展属性，破坏 ad-hoc 签名）：

```bash
ditto "src-tauri/target/release/bundle/macos/DeepSeek Harness.app" \
      "/Volumes/编程工具/DeepSeek Harness.app"
```

### ⚠ 往 `bundledPlugins` 里加插件时，发行打包有三个坑（dev 模式一个都碰不到）

2026-08-20 加入 `dsh-manager` 与 `dsh-infinite-gen-1` 后，`pnpm run build` 连续失败三次，
而 `pnpm tauri dev` 全程正常——因为下面三段代码只在发行路径上执行：

1. **`stageBundledPlugins` 原本硬性要求插件有 `lib/`**。手写插件（一个 `index.js`
   加若干资源）没有 `lib/`，直接 `ENOENT`。现已改为：有 `lib/` 走原逻辑，没有就整目录
   拷贝（排除 `node_modules`/`.git`）。
2. **冒烟 overlay 与运行时 overlay 挂载方式不一致**。`smokeRuntime` 用裸包名，而
   `src-tauri/src/harness.rs` 的 `desktop_overlay_content` 对需要被 desktop-bridge 发现
   浏览器半边的插件用 `file:` URL，且 desktop-bridge **只收集 `file:` 条目**。两边不一致
   时冒烟校验永远找不到那个 bundle。**改任意一侧都必须同步另一侧。**
3. **纯 Host 插件不会出现在浏览器 boot manifest 里**。`dsh-infinite-gen-1` 的
   `package.json` 只声明 `dsh.bundle`、没有 `dsh.client`，按设计就不进那份清单；用
   `body.includes(...)` 去校验它是个永远不成立的条件。这类插件应改为校验发行运行时里
   `plugins/<id>/index.js` 确实存在。

### ⚠ DMG 打包会被同名已挂载卷卡住

`pnpm run build` 最后一步做 DMG 时若系统里已挂载了叫 `DeepSeek Harness` 的卷，会失败在
`hdiutil: couldn't unmount ... 资源忙`。**`.app` 此时已经构建完成**，不影响交付；
要出 DMG 就先 `hdiutil detach "/Volumes/DeepSeek Harness"`。

### ⚠ `pnpm tauri dev` 在 macOS 上原本跑不起来（已修）

两处，都改在 `vite.config.ts`：

1. Vite 端口硬编码 821 且 `strictPort`，而 macOS 不允许非 root 绑定 1024 以下端口，
   直接 `EACCES`。现在可用 `DSH_DESKTOP_DEV_PORT` 覆盖，默认仍是 821（不影响 Windows/Linux）：
   ```bash
   DSH_DESKTOP_DEV_PORT=1821 pnpm tauri dev \
     --config '{"build":{"devUrl":"http://localhost:1821"}}'
   ```
2. Vite 的 watcher 原本会监视整个仓库，包含 1.3 GB 的 `harness/`；一旦重新构建 Harness
   就会把 dev server 拖垮（实测直接退出）。现已把 `harness/`、`plugins/` 加入 `ignored`。

---

## 2. 无边框窗口与标题栏（§2）

新项目原本**只**具备 2.1、2.2；托盘、关到托盘、窗口状态持久化、macOS 交通灯**都不存在**，
窗口控制按钮是 Windows 风格摆在右侧的。

| 需求 | 落地方式 | 文件 |
|---|---|---|
| 2.3 macOS 交通灯 | macOS 改用 `decorations: true` + `titleBarStyle: "Overlay"` + `hiddenTitle`（Tauri 中等价于 Electron 的 `hiddenInset`），显示系统原生交通灯；壳层自绘的三个按钮在 macOS 隐藏，标题栏左侧留 78px | `src-tauri/tauri.macos.conf.json`、`src/styles.css`、`src/main.ts` |
| 2.4 关闭到托盘 | `WindowEvent::CloseRequested` → `prevent_close()` + `hide()`；仅托盘「退出」与 Cmd+Q 真正退出 | `src-tauri/src/lib.rs` |
| 2.6 位置/大小持久化 | 官方 `tauri-plugin-window-state`，`POSITION\|SIZE\|MAXIMIZED\|FULLSCREEN` | `src-tauri/src/lib.rs` |
| 5.3 托盘四项 | 显示窗口 / 重启后端 / 开机自启 / 退出 | `src-tauri/src/tray.rs`（新增） |

两个值得记住的点：

- **`StateFlags::VISIBLE` 故意没开**。开了的话「关到托盘再退出」会把「隐藏」也存下来，
  下次启动直接不显示窗口，等于应用打不开。
- **2.6 要求的「显示器拔掉后回退」是插件自带的**：`restore_state` 会遍历当前所有显示器，
  只有保存的坐标仍与某块屏幕相交时才恢复位置，否则交给系统摆放。不需要自己写越界逻辑。
- **托盘「退出」与关闭按钮靠 `ExitIntent` 区分**：`RunEvent::ExitRequested` 带 `code`
  时是显式退出（托盘退出 / Cmd+Q / 注销），放行；`code` 为空说明只是最后一个窗口关了，
  `prevent_exit()` 让应用留在托盘。

托盘图标是单独的 macOS 模板图 `src-tauri/icons/tray-template.png`（88×88，只用 alpha，
菜单栏自行着色），**不随 `pnpm tauri icon` 重新生成**。它由 `src/assets/whale-icon-dark.svg`
经 `qlmanage` 渲染后裁切而来。

### 应用图标

已换成用户提供的 `.icns`。源文件现在是 `app-icon.png`（1024×1024，自带 macOS 圆角栅格），
`app-icon.svg` 已删除——它原本是 README 记录的图标源，留着会让下一个人重新生成出旧图标。

```bash
pnpm tauri icon app-icon.png
```

---

## 3. 侧栏「设置」右侧的主题切换（§3）

**需求文档里写的 `sidebar.settings` 槽位不能用。** 它是 `kind: 'single'` 且已被
`ui-settings-general` 的 `SettingsRoot` 占用，往里注册不是「加一个按钮」，而是**顶掉整个设置
按钮和它的设置面板**（槽位目录里标着 `replaceRisk: 'shadows-shipped-ui'`）。
而现成的 `sidebar.footer.action` 是**独立一行、排在设置上方**的，不满足「同一行、其右侧」。

所以新增了一个槽位：

- `settings.trigger.action`（`kind: 'list'`）声明在 `ui-settings` 的槽位契约里，
  由 `SettingsRoot` 在设置按钮所在的那一行渲染。宽栏时并排在右侧，折叠成窄栏时
  变成竖排的 36×36 圆形按钮。
- 按钮组件 `ThemeToggle.tsx` 放在 `ui-settings-general`——**不能放 ui-theme**：
  ui-theme 依赖 ui-sidebar 会形成 `ui-sidebar → ui-layout → ui-theme` 的循环，
  构建的拓扑排序会直接报错。ui-settings-general 已经（经 ui-sidebar）间接依赖 ui-theme，
  加这条直接依赖是无环的。

走的是官方主题机制，因此 3.3、3.5 是白拿的：

- 读 `ctx.theme.getTheme().active.colorScheme`，写 `ctx.theme.setTheme(...)`，
  订阅 `theme/change`。因此与「设置 → 外观」双向同步，不需要两边互相知道对方存在。
- 持久化由 ui-theme 负责，落在 Host 的 `settings.yaml`（namespace `ui-theme`，
  字段 `preference`），**不是 localStorage**。
- 图标表示「点了会变成什么」：浅色显示月亮，深色显示太阳。
- 注册是 composition-conditional 的（`ctx.inject(['theme'], …)`）：没有主题插件的部署
  设置行保持原样，不会因为缺服务而整个设置壳挂不上。

改动文件：`ui-settings/src/client/contract/slots.ts`、
`ui-settings-general/src/client/{SettingsRoot.tsx,SettingsRoot.module.css,ThemeToggle.tsx,ThemeToggle.module.css,index.ts,locales.ts,shell-contract.ts}`。

---

## 4. 模型不支持图片也能发图 / 读图（§4）

### 需求文档对数据结构的描述是错的

文档说图片块是 `{type:"image", mediaType, data:base64}`。实际不是：

```ts
export interface ImageBlock {
  type: 'image'
  attachment: ImageAttachmentRef   // 只有引用，字节在 ctx.attachments 里
}
```

字节要 `await attachments.readImage(ref)` 才拿得到，而且 `Message` 是深冻结的，
不能就地改，只能重建。

### 拦截点与四道闸门

拒绝图片的地方**有四处**，不是一处：

| # | 位置 | 处理 |
|---|---|---|
| 1 | `llm-deepseek/src/serialize.ts` 适配器序列化 | 序列化前把图片折成文字 |
| 2 | `tool-fs/src/read-image.ts` 工具能力闸 | 无图片模态时改走 OCR 文本，不再报错 |
| 3 | `apiproxy` 切换模型预检 | 见下：靠如实声明模态一次性解决 |
| 4 | `apiproxy` 上传预检 | 同上 |

3 和 4 没有单独去改。DeepSeek 适配器原本硬编码 `inputModalities: ['text']`，
**且这条负声明是承重的**——源码注释写明：声明「未知」会让 Host 接受并持久化图片，
而序列化器随后必然拒绝，把会话彻底卡死。

因此做法是：**先让序列化器真的能处理图片，再如实声明 `['text', 'image']`**。
声明是动态的（`inputModalities()` 每次现算）：只有当 `resolveImageText` 这个解析器真的
挂上了（即 `ctx.attachments` 存在）才声明图片能力，否则仍旧只声明 `text`、仍旧拒绝图片。
这样声明永远不会超出实际能力，闸门 3、4 自然放行。

### OCR 模块

新包 `harness/packages/util/image-ocr`（`@deepseek-ai/dsh-image-ocr`）：

- `createImageOcr()` → `recognize({data, mediaType, signal})`
- 引擎顺序：**macOS Vision（`dsh-ocr`）优先 → tesseract 回退**
- **按内容 sha256 缓存**（§4.5），并发同图请求合并成一次识别
- 三种边界都返回可读说明而不是静默丢图（§4.6）：`empty` / `too-large` / `unavailable`
- `describeImageForModel(outcome, label)` 统一生成给模型看的文字块

实测（真实引擎，`/tmp/ocr-test/sample-mixed.png` 中英混排）：

```
first:  627.951ms      engine: vision
second:   0.085ms      cached on repeat: true      ← 同图重复约快 7400 倍
forced fallback engine: tesseract
no engines: {"kind":"unavailable","detail":"no OCR engine succeeded (vision: not installed; tesseract: not installed)"}
blank image: {"kind":"empty","detail":"vision found no text in this image"}
```

### OCR 助手（§4.4）

源码与安装脚本：`harness/native/dsh-ocr/`（`src/main.swift` + `install.sh`）。
放在 `native/` 是跟随本仓已有的原生助手惯例（`native/landlock-run`）。

```bash
cd harness/native/dsh-ocr
./install.sh                 # 编译并装进 Homebrew 前缀（或 /usr/local）
./install.sh --build-only    # 只产出 ./build/dsh-ocr
PREFIX=~/.local ./install.sh
```

CLI 契约刻意做得很小，方便 Node 侧 `execFile`：

```
dsh-ocr <image-path>     # 识别结果按阅读顺序逐行写 stdout
                         # 退出码 0=已识别(可能为空) 2=用法错 3=图片无法解码 4=Vision 失败
DSH_OCR_LANGUAGES=zh-Hans,ja,en-US   # 可覆盖识别语言
```

与旧二进制 `/opt/homebrew/bin/dsh-ocr` 的输出在测试图上**逐字一致**（含 `A7K9QX`、
`DSH-2026-0820-1174` 这类 tesseract 会认错的串）。Vision 不保证返回顺序，所以按
包围盒重建了阅读顺序（先按行分组，再行内从左到右）。

### read_image（§4.3）

原来的 `assertImageCapableRoute` 改成 `resolveImageRouteMode`，返回 `'image' | 'text'`：
声明了图片模态的路由照旧拿到图片块；没声明的（含能力未知）拿到 OCR 文字，
**不再抛「does not declare image input」**。
`ImageReadValue` 多了可选的 `text` 字段，`render` 依据它决定输出图片块还是文字块——
`render` 必须是纯函数，所以 OCR 在 `execute` 里做完再塞进 value。

---

## 5. 验证情况

```bash
# harness 单元测试（改动涉及的包）
cd harness
npx vitest run packages/client/ui-settings-general packages/client/ui-settings \
               packages/client/ui-sidebar packages/client/ui-theme        # 462 passed
npx vitest run packages/llm/llm-deepseek packages/fs/tool-fs packages/util/image-ocr  # 482 passed

# 类型
npx tsc -b tsconfig.host.json
npx tsc -b tsconfig.client.json

# 桌面壳
cargo check --manifest-path src-tauri/Cargo.toml
npx tsc --noEmit
```

新增测试：`packages/util/image-ocr/tests/image-ocr.spec.ts`（12）、
`packages/llm/llm-deepseek/tests/image-fold.spec.ts`（9）、
`packages/client/ui-settings-general/tests/theme-toggle.client.spec.tsx`（6）。

修改了 `tool-fs/tests/read-image.spec.ts` 里三条断言：它们原本断言「无图片模态时报错」，
而 §4.3 要求的正是把这个行为改掉，现在改为断言「返回文字、不含图片块、不报错」。

### ⚠ 还没人眼确认的验收项

以下无法在无 GUI 权限的情况下自证，需要在**新 app** 里过一遍：

- §2.2 标题栏拖拽 / 双击最大化；§2.3 交通灯位置与点击；§2.5 主题联动
- §2.4 点关闭后进程仍在、可从托盘恢复；§5.3 托盘四项
- §2.6 移动+改尺寸 → 完全退出 → 重启后位置尺寸保持
- §4.1/4.2 会话中附加图片能发出、模型能复述图中文字
- §5.4 会话日志导出

（本机未授予 Cursor「屏幕录制」权限，`screencapture` 返回
`could not create image from display`，因此没法自动截图核对。）

---

## 6. 冷咖啡 ColdBrew 四模型破甲集成（§新增）

### 需求

把 `https://github.com/3641397194-wq/gpt5.6-claude-grok4.6-deepseekv4pro`
（冷咖啡四模型工作台）集成进桌面版：

1. 输入框内新增「冷咖啡破甲」开关——**只能在新会话（无消息）时开启/关闭**，
   开启后按当前选择的模型名自动匹配对应 profile，并注入该 profile 的系统提示词；
2. 桌面环境管理面板换成「冷咖啡 ColdBrew 四模型工作台」；
3. 修复面板里「立即应用并重启」按钮无效的问题。

### 落地方式

| 需求 | 落地 | 文件 |
|---|---|---|
| 拉取并 vendor 项目 | 整仓（去 .git）拷入 `coldbrew/`；四个 profile 提示词由原仓 profile_engine 生成后放入插件资源 | `coldbrew/`、`desktop-plugins/dsh-manager/src/profiles/*.md` |
| 按会话注入系统提示词 | `dsh-manager` host 注册 `systemPrompt.section('coldbrew:session-profile', order 150)`，text 提供器按 `AssembleContext.scope.id`（=agent=会话）读 `coldbrew-sessions.json`，开启且模型命中时返回对应 profile 正文，否则返回空串（不贡献内容） | `desktop-plugins/dsh-manager/src/index.mjs` |
| 模型名 → profile | `matchProfileId()`：gpt/codex/o1/o3→codex；claude→claude；grok→grok；其余（含 deepseek-v4-*）→deepseek | 同上 |
| webServer API | `/api/coldbrew/profiles`（GET）、`/api/coldbrew/profile/:id`（POST 默认开启）、`/api/coldbrew/session/:id`（GET/POST 会话开关）；状态落盘 `coldbrew-sessions.json`，profile 默认写入 `desktop-settings.json` 的 `coldbrew.profiles` | 同上 |
| 工具 | `coldbrew_profiles` 工具返回四个 profile 元数据+正文（与 `infinite_gen1_profile` 同型） | 同上 |
| 输入框开关 | client 注册 `conversation.input.left` 槽位 `ColdBrewToggle`：`session.blank===true` 才可切换；通过 `modelDirectories` 服务读当前模型，展示将匹配的 profile；切换 POST 到 host | `desktop-plugins/dsh-manager/src/client.tsx` |
| 面板换新 | `settings.section` 的 `desktop-manager` 面板改为冷咖啡四模型工作台：四个 profile 卡片（默认开关）+ 后端运行状态 + 重启 | 同上 |
| 重启按钮修复 | 面板重启走 `window.parent.postMessage({type:'deepseek-harness:restart'})` → `src/main.ts` → `invoke('restart_harness')`；Rust 命令此前**漏发 `HARNESS_RELAUNCHING_EVENT`**（托盘路径有发），导致 launcher 页不知道要重新轮询 `launch_status`，后端换了端口但 iframe 仍指向旧端口 → 表现为点击无反应。现在命令补发该事件，与托盘路径一致 | `src-tauri/src/lib.rs` |

### 构建与验证

```bash
pnpm run plugin:build        # 重建 dsh-manager（host+client+profiles 拷入 lib/profiles/）
node scripts/test-plugins.mjs
node --test desktop-plugins/dsh-manager/test/host.test.mjs   # 4 passed
cargo check --manifest-path src-tauri/Cargo.toml
```

用 harness 源码 + 手工 overlay 起本地 web 实例验证：
`/api/coldbrew/profiles`、`/api/coldbrew/session/:id`（GET/POST）、
`/api/coldbrew/profile/:id` 均正常；`matchProfileId` 9/9 用例通过；
systemPrompt section 文本提供器 mock 验证：开启+grok→Grok 正文、关闭→空串、无 scope→空串。

### 待确认

- `dsh-model-capabilities/test/client.test.mjs` 有一条**既有失败**（selectionOf 期望
  `inherit` 实际 `text-image`），与本次改动无关（该插件目录未动过），提交时原样保留。
- 面板与输入框开关的实际视觉效果需在新 app 里人眼过一遍。

# DSH 桌面端（DSH Desktop）

一个 Windows 桌面客户端：**装到一台全新电脑上，双击就能用上 DeepSeek Harness（dsh）**，
不需要事先安装 Node、npm 或命令行版 dsh。

- 首次启动自动准备运行环境：内置 Node → 自动获取 npm → 自动安装 `@deepseek-ai/dsh`
- 自动检查并升级 dsh 版本（用的是国内可直连的 npmmirror 镜像）
- 界面就是 dsh 官方的 Web UI，客户端只负责把本地服务拉起来并托管在一个原生窗口里

## 给最终用户

### 安装

1. 双击 `DSH-Desktop-Setup-0.1.0-x64.exe`
2. 选择安装位置（支持只装给当前用户，不需要管理员权限）
3. 装完自动创建桌面与开始菜单快捷方式「DSH 桌面端」

安装过程本身不联网、不下载运行时；**运行环境是在第一次启动时准备的**。

### 启动过程

首次启动带一个百分比进度条，依次经过：

| 阶段 | 说明 | 耗时（参考） |
| --- | --- | --- |
| 检查运行环境 | 读本地已安装版本、查镜像最新版 | < 1s（进度 0→8%） |
| 安装 / 更新 dsh | 首次约 517 个包 | 首次约 30s（进度 10→78%） |
| 启动服务 | 拉起本地 `dsh web`，端口由系统分配 | 约 12s（进度 80→98%） |
| 打开界面 | 载入 Web UI | 立即（100%） |

也就是「全新电脑从零到可用」大约 80 秒。装过之后再次启动通常十几秒进界面。

安装阶段没有精确的进度事件，进度条是按耗时估算的爬升；服务启动阶段同理。
引导页右侧有「显示日志」，任何一步卡住都能直接看到原因。

### 关闭窗口时的行为

默认**最小化到托盘**：关掉窗口服务继续在后台跑，双击托盘图标即可唤回。
首次隐藏时会弹一次系统通知提醒，不会让你以为应用被关掉了。

改成「退出应用」（关窗口同时停掉本地服务）有两种方式：

- 托盘右键 →「关闭窗口时」→「退出应用」
- 引导页上的「关闭窗口时…」按钮，弹出的对话框里可以勾选「记住我的选择，不再询问」

托盘右键菜单还提供：打开主界面、重新启动 dsh 服务、检查更新、打开日志目录、退出。

### 登录 / 凭据

DSH_HOME 默认用 `~/.dsh`，和命令行版 dsh 共用同一份会话、配置与凭据：
如果这台机器上已经用命令行登录过，桌面端直接就是登录态。
想隔离，把环境变量 `DSH_DESKTOP_HOME` 指到别的目录即可。

### 更新

- **dsh 运行时**：**每次启动都会主动检查，发现新版本直接装上再启动服务**，不需要你点确认。
  运行期间每 30 分钟再检查一次，这时发现新版本会先问一句（避免打断正在进行的会话），
  同一个版本只会问一次。
- **客户端自身**：发布方托管一个含 `latest.yml` 的 HTTP 目录后，用环境变量
  `DSH_DESKTOP_UPDATE_FEED=<目录地址>` 指定即可；未配置时只检查 dsh，不会报错。

## 文件位置

| 内容 | 路径 |
| --- | --- |
| 程序安装目录 | 用户自选，默认 `%LOCALAPPDATA%\Programs\dsh-desktop` |
| 数据目录 | `%APPDATA%\dsh-desktop` |
| dsh 运行时 | `%APPDATA%\dsh-desktop\runtime` |
| 应用设置 | `%APPDATA%\dsh-desktop\settings.json`（关闭行为、镜像、更新检查间隔） |
| 日志 | `%APPDATA%\dsh-desktop\logs` |
| DSH_HOME | `~/.dsh`（可用 `DSH_DESKTOP_HOME` 覆盖） |
| 命令行入口 | `%APPDATA%\dsh-desktop\dsh.cmd` |

卸载程序**不会**删除数据目录，会话与登录状态会保留。想彻底清理，手动删掉
`%APPDATA%\dsh-desktop` 即可。

## 给开发者

### 环境准备

```powershell
npm install                    # 只装 electron 与 electron-builder
npm run electron               # 下载并解压 Electron 到 build/electron-dist
npm run icon                   # 由 assets/logo.png 生成 build/icon.ico
```

`npm run electron` 与 `npm run icon` 都是零额外依赖的脚本：前者显式下载解压 Electron
（不依赖 postinstall 静默成功），后者自带 PNG 解码与面积平均缩放，直接产出
16/32/48/64/128/256 六档 ICO。

### 常用命令

```powershell
npm run check        # 纯逻辑校验：版本比较、就绪行解析（不启动任何进程）
npm run self-test    # 真实端到端：装运行时 → 启动 dsh → 鉴权握手 → 停止
npm run dist         # 打 NSIS 安装包，产物在 release/
```

### 目录结构

```
src/
  main.js        主进程：窗口、菜单、启动状态机、IPC
  preload.js     引导页与主进程之间的最小桥（不向渲染进程暴露 Node）
  dsh.js         托管 dsh web 子进程：启动、就绪识别、日志、停止
  runtime.js     查找/安装/升级 dsh 运行时；内置 npm 下载与 tar 解压
  updater.js     版本检查（dsh 运行时 + 客户端自身）
  config.js      路径、环境变量、设置读写
  ui/            引导页（logo、状态、日志、重试/更新按钮）
scripts/
  fetch-electron.js   显式下载解压 Electron
  make-icon.js        logo.png → 多尺寸 icon.ico
  check-logic.js      纯逻辑校验
  self-test.js        无 GUI 端到端自检
  capture-window.ps1  截图（开发排查用）
  extract-exe-icon.ps1 从成品 exe 取图标，确认图标正确
```

### 实现上必须注意的四点

1. **`dsh web` 必须加 `--expose-internals`**。dsh 的 HMR 加载器优先用它直接取 Node
   内部 ESM loader；否则回退到 `node-addon-require-builtin`，而那个原生插件在
   Electron 内嵌的 Node 里用不了（`no compatible GetAlignedPointerFromEmbedderData
   symbol found`），启动会直接失败。
2. **子进程的 `cwd` 是 `DSH_HOME`，目录必须先建出来**。全新电脑上它并不存在，而
   Windows 下不存在的 cwd 会让 `spawn` 直接抛 `ENOENT`。
3. **子进程 stdio 采用「管道优先、失败回退文件」**。stdout 重定向到文件是块缓冲，
   就绪那一行（`dsh web: <url>`）会迟迟不落盘；但某些受限环境又不允许给子进程建管道，
   所以两条路都要有。
4. **打包后 `process.execPath` 是 `DSH 桌面端.exe`**，不是 `electron.exe`。这段路径
   解析必须同时兼容开发态与打包态，否则只有成品会踩坑。

### 托盘与退出

- 窗口的 `close` 事件里判断 `closeAction`：为 `tray` 时 `preventDefault()` 并 `hide()`，
  否则放行给默认的关闭流程。
- 真正退出统一走 `quitApp()`（置 `quitting = true` 再 `app.quit()`），否则会被
  `close` 处理器拦住变成「隐藏」。
- `before-quit` 里先 `event.preventDefault()` 停子进程，停完再 `app.quit()`；
  `stop()` 自带 8s + 5s 硬上限，退出流程不会被卡住。
- 托盘图标用独立的 `build/icon-32.png`（`npm run icon` 会一并生成），
  直接拿 ICO 给 `Tray` 在部分环境下会显示异常。

### 关于 Web 鉴权

`dsh web` 启动时会打印带一次性 token 的地址。浏览器访问该地址会拿到一个
HttpOnly Cookie 并 303 跳到干净的 `/`；之后的请求都靠 Cookie。所以：

- 应用里直接 `loadURL(带 token 的地址)` 即可，窗口会自然完成握手；
- 用脚本校验可用性时，**不能**只发一次不带 Cookie 的请求（那必然是 401），
  要复刻「拿 token 换 Cookie → 带 Cookie 请求」两步。

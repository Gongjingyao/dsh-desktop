# DSH 桌面端（DSH Desktop）

一个 Windows 桌面客户端：**装到一台全新电脑上，双击就能用上 DeepSeek Harness（dsh）**，
不需要事先安装 Node、npm 或命令行版 dsh。

- 首次启动自动准备运行环境：内置 Node → 自动获取 npm → 自动安装 `@deepseek-ai/dsh`
- 自动检查并升级 dsh 版本（用的是国内可直连的 npmmirror 镜像）
- 界面就是 dsh 官方的 Web UI，客户端只负责把本地服务拉起来并托管在一个原生窗口里

## 给最终用户

### 安装

1. 双击 `DSH-Desktop-Setup-0.1.1-x64.exe`
2. 选择安装位置（支持只装给当前用户，不需要管理员权限）
3. 装完自动创建桌面与开始菜单快捷方式「DSH 桌面端」

升级直接双击新包覆盖安装即可（同一 appId，安装器会先静默卸载旧程序文件），
不需要手动卸载；程序外的数据（`%APPDATA%\dsh-desktop`、`~/.dsh`）都会保留，
包括已装好的 dsh 运行时——升级后第一次启动不用重新下载。
安装前请先从托盘菜单**真正退出**客户端：关窗口只是最小化到托盘、进程还在，
exe 被占用会让升级失败。

安装过程本身不联网、不下载运行时；**运行环境是在第一次启动时准备的**。

### 启动过程

**启动路径不依赖网络。** 本地已经装好 dsh 时，客户端会立刻拉起本地服务，版本检查放到
界面出来之后在后台做——断网、镜像不通都只影响"能不能检查更新"，不会拖慢启动、更不会
让启动失败。

| 阶段 | 说明 | 耗时（参考） |
| --- | --- | --- |
| 准备运行环境 | 读本地已装版本（不联网） | 立即（进度 0→30%） |
| 安装 / 更新 dsh | 只在本地没有可用运行时（首次），或你点了「立即更新」时才会联网 | 首次约 30s（进度 10→78%） |
| 启动服务 | 拉起本地 `dsh web`，端口由系统分配 | 取决于 dsh 自身，见下 |
| 打开界面 | 载入 Web UI | 立即（100%） |

也就是「全新电脑从零到可用」大约 80 秒；装过之后再次启动，客户端自己的开销只有几百毫秒，
剩下的时间全是 dsh 自身启动。日志里会把这两段分开记：

```
dsh 已就绪：http://127.0.0.1:57219/?token=…（服务启动 6.2s，本次启动共 6.4s）
```

如果"服务启动"这一段很长，那是 dsh 运行时自己的启动耗时（插件树、会话目录），
客户端无法再压缩；客户端能保证的是不在这上面再加时间。

安装阶段没有精确的进度事件，进度条是按耗时估算的爬升；服务启动阶段同理。
引导页右侧有「显示日志」，任何一步卡住都能直接看到原因。

### 关闭窗口时的行为

默认**最小化到托盘**：关掉窗口服务继续在后台跑，双击托盘图标即可唤回。
首次隐藏时会弹一次系统通知提醒，不会让你以为应用被关掉了（只弹这一次，也只有一个提醒）。

改成「退出应用」（关窗口同时停掉本地服务）有两种方式：

- 托盘右键 →「关闭窗口时」→「退出应用」
- 引导页上的「关闭窗口时…」按钮，弹出的对话框里可以勾选「记住我的选择，不再询问」

托盘右键菜单还提供：打开主界面、重新启动 dsh 服务、检查更新、查看余额、打开日志目录、退出。

### 登录 / 凭据

DSH_HOME 默认用 `~/.dsh`，和命令行版 dsh 共用同一份会话、配置与凭据：
如果这台机器上已经用命令行登录过，桌面端直接就是登录态。
想隔离，把环境变量 `DSH_DESKTOP_HOME` 指到别的目录即可。

### 查看账户余额

菜单「维护 → 查看余额…」或托盘右键「查看余额…」，会直接查一次 DeepSeek 账户余额并弹窗显示
总余额 / 充值余额 / 赠金余额、账户状态，以及这次用的是哪份密钥、查询时间；弹窗上有「刷新」。

密钥不用另配一份，客户端按这个顺序找（与 dsh 自己的凭据优先级一致）：

1. 启动环境变量 `DEEPSEEK_API_KEY`
2. `~/.dsh/.credentials.yaml` 的 `refs` 段（在 dsh 界面「设置 → 模型」填一次就会写进这里）
3. `~/.dsh/.env`

查不到密钥时会直接告诉你去哪儿填，并能一键打开凭据目录。密钥只用于这次请求，不写日志、不落盘。

### 命令行窗口不会闪

新机器上第一次启动、以及每次升级 dsh 之后，客户端都会给运行时补一个「隐藏子进程控制台
窗口」的补丁（`src/runtime-patch.js`，幂等）：dsh 本身跑在没有控制台的 GUI 进程里，
不补的话 agent 每跑一条命令，Windows 都会给它新建并弹出一个黑框。

补丁只在**进程创建的显示状态**上动手（`STARTF_USESHOWWINDOW | SW_HIDE`），不改变子进程
有没有控制台——后者（`CREATE_NO_WINDOW` / Node 的 `windowsHide`）在受限令牌的沙箱下会让
子进程直接起不来（`STATUS_DLL_INIT_FAILED`）。dsh 上游把这两处改好之后，这个补丁会自动
跳过（检测到标记就什么都不做），届时删掉 `src/runtime-patch.js` 与 `main.js` 里那行调用即可。

### 更新

- **dsh 运行时**：界面就绪后在后台检查；发现新版本会问一句「立即更新 / 稍后」
  （更新要重启本地服务，不能悄悄打断你正在进行的会话），同一个版本只问一次。
  运行期间每 30 分钟再检查一次，同样是问一句。首次安装、以及你点「立即更新」时才联网下载。
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
npm run check        # 纯逻辑校验：版本比较、就绪行解析、余额凭据与格式化（不启动任何进程）
npm run check-exit   # 退出路径校检：真实拉起 dsh 再停掉，断言停止在秒级内完成
npm run check-balance # 余额功能真机校验：用本机凭据真的查一次 /user/balance
npm run self-test    # 真实端到端：装运行时 → 启动 dsh → 鉴权握手 → 停止
npm run dist         # 打 NSIS 安装包，产物在 release/
```

### 目录结构

```
src/
  main.js        主进程：窗口、菜单、启动状态机、IPC
  runtime-patch.js  给已装运行时补「隐藏控制台窗口」（幂等，dsh 升级后自动补回）
  preload.js     引导页与主进程之间的最小桥（不向渲染进程暴露 Node）
  dsh.js         托管 dsh web 子进程：启动、就绪识别、日志、停止
  runtime.js     查找/安装/升级 dsh 运行时；内置 npm 下载与 tar 解压
  updater.js     版本检查（dsh 运行时 + 客户端自身）
  balance.js     账户余额：找密钥（环境变量/凭据文件/.env）+ 调 /user/balance + 展示格式化
  config.js      路径、环境变量、设置读写
  ui/            引导页（logo、状态、日志、重试/更新按钮）
scripts/
  fetch-electron.js   显式下载解压 Electron
  make-icon.js        logo.png → 多尺寸 icon.ico
  check-logic.js      纯逻辑校验
  check-balance.js    余额查询真机校验（用本机凭据真的查一次）
  check-exit.js       退出路径校检（真起 dsh 再停掉，量停止耗时）
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
3. **子进程 stdio 采用「管道优先、失败回退文件」**。stdout 重定向到文件时，就绪那一行
   （`dsh web: <url>`）不一定及时落盘；但某些受限环境又不允许给子进程建管道，所以两条路
   都要有。注意：**文件回退路径下子进程的行已经写进日志文件了，父进程不能再往同一个文件
   写回去**，否则就是"读出来 → 写回去 → 又被读出来"的自增殖循环（日志每轮翻倍）。
4. **打包后 `process.execPath` 是 `DSH 桌面端.exe`**，不是 `electron.exe`。这段路径
   解析必须同时兼容开发态与打包态，否则只有成品会踩坑。

### 托盘与退出

- 窗口的 `close` 事件里判断 `closeAction`：为 `tray` 时 `preventDefault()` 并 `hide()`，
  否则放行给默认的关闭流程。
- 真正退出统一走 `quitApp()`（置 `quitting = true` 再 `app.quit()`），否则会被
  `close` 处理器拦住变成「隐藏」；重复点击由 `quitting` 挡掉，`before-quit` 里的收尾
  由 `shutdownInFlight` 保证只跑一次。
- `before-quit` 先 `preventDefault()`，收起窗口与托盘图标（让"点了退出"立刻有反馈），
  再停子进程，停完重放 `app.quit()`。
- `stop()` **按进程存活来判断是否结束，不等 `close` 事件**：`close` 还要求 stdio 全部
  关闭，可能被 dsh 派生的、持有同一批管道的工作进程拖住。Windows 上直接
  `taskkill /T /F` 杀整棵树（宽限期为 0：不带 `/F` 的 taskkill 对无窗口的控制台进程
  必然失败），taskkill 被安全软件/权限拒绝时退回 `child.kill()`。
- 托盘图标用独立的 `build/icon-32.png`（`npm run icon` 会一并生成），
  直接拿 ICO 给 `Tray` 在部分环境下会显示异常。
- 「最小化到托盘」的提示只走系统通知一个通道：老的 `tray.displayBalloon` 会跟它一起
  弹两个，而且展开任务栏折叠区时 Windows 还会把气泡重播一次。

### 关于 Web 鉴权

`dsh web` 启动时会打印带一次性 token 的地址。浏览器访问该地址会拿到一个
HttpOnly Cookie 并 303 跳到干净的 `/`；之后的请求都靠 Cookie。所以：

- 应用里直接 `loadURL(带 token 的地址)` 即可，窗口会自然完成握手；
- 用脚本校验可用性时，**不能**只发一次不带 Cookie 的请求（那必然是 401），
  要复刻「拿 token 换 Cookie → 带 Cookie 请求」两步。

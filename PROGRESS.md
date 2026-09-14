# DSH Desktop 交付说明

**交付物**：`release\DSH-Desktop-Setup-0.1.1-x64.exe`（101,429,522 字节 ≈ 96.7 MB，NSIS 安装包）
**状态**：已完成并验证通过。0.1.1 = 首个提交之后累积的全部改动（启动慢 / 托盘退出 / 重复托盘提醒 /
日志自增殖 + 运行时「隐藏控制台窗口」补丁），加上本轮新增的「查看余额」；版本号按你的要求统一记为
0.1.1。与 0.1.0 是同一 appId 的同一个产品，新包可直接覆盖安装。

## 它做了什么

装到一台全新 Windows 电脑上，双击就能用 DeepSeek Harness：

1. 首次启动自动准备运行环境 —— 用应用自带的 Node（Electron 内嵌）→ 从 npmmirror
   下载 npm → 安装 `@deepseek-ai/dsh` 到 `%APPDATA%\dsh-desktop\runtime`
2. 拉起本地 `dsh web` 服务，把官方 Web UI 装进原生窗口；启动全程有百分比进度条
3. **启动路径不依赖网络**：本地已装好 dsh 就直接起服务；新版本改为界面出来后在后台问一句
4. 关窗口默认最小化到托盘（服务继续跑，双击托盘唤回），可改为退出应用
5. 桌面 / 开始菜单快捷方式、窗口与任务栏图标均为上传的 logo

## 本轮新增：查看余额（客户端里直接查 DeepSeek 账户余额）

**需求**：在客户端里能看账户余额。

**做法**：`src/balance.js` 只做三件事——找密钥、调接口、整理成展示结构；主进程只在菜单里接两个入口。
接口是 DeepSeek 官方的 `GET /user/balance`，基址沿用 dsh 的 `$DEEPSEEK_BASE_URL`（默认
`https://api.deepseek.com`）。密钥不另存一份，直接沿用 dsh 自己那份，优先级也与
`dsh-credentials-local` 一致：

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 启动环境变量 `DEEPSEEK_API_KEY` | 与 dsh 的解析顺序一致（它优先级最高） |
| 2 | `<DSH_HOME>/.credentials.yaml` 的 `refs` 段 | dsh 设置界面里填的 Key 就写在这里 |
| 3 | `<DSH_HOME>/.env` | 命令行版 dsh 的老习惯 |

入口是「维护 → 查看余额…」和托盘右键「查看余额…」，弹原生对话框：总余额 / 充值余额 / 赠金余额 /
账户状态 / 密钥来源 / 查询时间，并带一个「刷新」按钮。窗口藏在托盘里时不用模态父窗口，改用独立
对话框——挂在隐藏窗口上的消息框用户根本看不见。

三种情况都分开说清了：没配密钥 → 告诉你去哪儿填，还能一键打开凭据目录；网络或接口出错 → 显示具体
原因与本次查询地址；正常 → 余额明细。密钥只进请求头，日志里只记「查成功 + 币种」，金额与密钥都不落盘。

**验证**（都是真跑出来的）：

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 真机查一次余额 | `npm run check-balance`：真读 `~/.dsh/.credentials.yaml`、真联网 | PASS，`总余额 ¥49.22`，密钥来源标注为凭据文件 |
| 菜单接线与弹窗内容 | 用假 electron 跑**真实的 `main.js`**（脚本：`_selftest/check-balance-ui.js`，自检目录已被 gitignore），拦下菜单模板与 `showMessageBox` 参数后点一次菜单 | PASS：应用菜单与托盘菜单里都有「查看余额…」；弹窗标题「账户余额」、正文含充值/赠金明细与密钥来源、按钮为「刷新/关闭」；弹窗文案不含 API Key |
| 纯逻辑 | `npm run check` 新增 8 项 | PASS：凭据文件只解析 `refs` 段（不误读 `records`）、dotenv 解析、余额返回体解析、字段缺失不当成账户不可用、金额格式化、弹窗文案、密钥查找顺序（环境变量 > 凭据文件 > `.env` > 无） |
| 打包产物 | 解开 `release\win-unpacked\resources\app.asar` 比对 | PASS：`src/balance.js` / `src/main.js` / `src/config.js` 与仓库**逐字节一致**，包内版本 0.1.1，17 个文件里 `assets/icon-32.png`、`src/ui/*` 都在 |

> **没能验证的一条**：真实窗口里点一次菜单。本会话起的图形进程留不住——沙箱里 Chromium 建 Mojo
> 命名管道直接被拒（`FATAL: platform_channel.cc Check failed: 拒绝访问 (0x5)`），放开沙箱后进程
> 也在 1 秒内退出，实测连 `notepad` 都留不住窗口（说明这个会话没有可用的交互桌面），与代码无关。
> 所以这一条用上面那个「假 electron 跑真 main.js」的接线校验代替；实际弹窗请装完后点一下确认。

## 更早一轮：启动慢 / 托盘退出没反应 / 重复托盘提醒 / 日志自增殖

### 1. 非首次运行也要等很久

**根因**（`%APPDATA%\dsh-desktop\logs\app.log` 取证）：`bootSequence` 把"联网查最新版"
放在起服务之前，查完才 spawn dsh。`updater.checkRuntime()` 是 HTTPS 请求，两个镜像各
15s 超时，镜像不通时要等满 30s；断网时直接抛错 → 引导页显示"启动失败"，而本地明明有
一份能用的运行时（日志里 18:07 那条"无法获取最新版本（已尝试 2 个镜像）"就是现场）。
查到新版本时更重：先跑完整套 `npm install` 才肯起服务。

**改法**：启动路径不再碰网络。本地运行时可用（`installedVersion()` + 入口文件存在）就
直接起服务，版本检查挪到界面就绪之后在后台做；查到新版本只弹一句询问
（`promptRuntimeUpdate`，与手动检查、周期检查三处共用），用户点了才联网安装。
窗口加载与 dsh 启动改为并行，不再互相等 1~2 秒。

日志把两段耗时分清楚了，慢在哪一眼能看出来：

```
dsh 已就绪：http://127.0.0.1:57219/?token=…（服务启动 6.2s，本次启动共 6.4s）
```

### 2. 托盘右键「退出」点了没反应 / 要点第二次

**根因**（日志取证 + 本地实验）：`dsh.stop()` 每次都走
`taskkill`（不带 `/F`）→ 等满 8s → `/F` → 再等 5s。不带 `/F` 的 taskkill 只给有窗口的
进程发 WM_CLOSE，而 dsh 是 `CREATE_NO_WINDOW` 起来的控制台进程，永远收不到，那 8s 必然
白等（日志里"未在 8s 内退出，强制结束"就是它）。更要命的是等待条件用的是子进程的
`close` 事件——`close` 还要求 stdio 全部关闭，dsh 会派生持有同一批管道的工作进程，
`close` 因此可能几秒后才来；两次点击之间的十几秒空窗就是这么来的。

**改法**：

- 判断"死没死"改成探测进程本身（`process.kill(pid, 0)` 轮询），**不等 `close` 事件**；
- Windows 宽限期直接为 0（不做注定失败的优雅尝试）：`taskkill /T /F` 杀整棵进程树，
  受限环境里 taskkill 被拒（Access denied）时退回 `child.kill()` 兜底；
- 新增 `#finishChild()` 做幂等收尾，并让"迟到的 close"不会清掉新进程的状态
  （顺带修掉「重新启动 dsh 服务」可能因为旧引用没清而静默不重启的问题）；
- 退出时先收窗口、销毁托盘图标，再停服务：点了退出立刻有视觉反馈。

### 3. 关闭窗口后出现两次「已最小化到托盘」提醒

**根因**：`notifyHiddenToTray()` 同时发了系统通知（`Notification`）**和**老的托盘气泡
（`tray.displayBalloon`）——两个通道各弹一次；展开任务栏折叠区时 Windows 还会把气泡重播。

**改法**：删掉 `displayBalloon`，只留系统通知（它还能点开窗口）。

### 4. 量启动耗时时又抓到一个真 bug：文件回退路径的日志自增殖

`#spawnChild` 在管道不可用时会回退到"子进程输出重定向进日志文件、父进程轮询读取"。
原来的 `#recordLine()` 把从文件里读出来的每一行**又写回同一个文件**，于是形成
"读出来 → 写回去 → 下一轮又被读出来"的循环：日志文件每次轮询都翻倍、CPU 与磁盘跟着烧。
用户 9-17 那份日志里同一行重复出现、同一时间戳的启动头写了两次，就是这个循环的现场。

**改法**：文件方式下这一行本来就是子进程写进日志文件的，父进程不再重复落盘
（`if (!this.fileStdio) this.appender?.write(...)`）。实测同一次启动的日志文件从
"每 300ms 增长"变成固定的 4 行 341 字节。

### 验证与测量（都是真跑出来的）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 退出（停服务）耗时 | `npm run check-exit`：真起 dsh 再 stop() | 1.5s（受限环境里 taskkill 被拒、走兜底路径；老实现是 8s+5s），子进程无孤儿 |
| dsh 服务启动耗时 | 同一脚本，隔离的 DSH_HOME | 5.5 ~ 6.8s（真实 `~/.dsh` 的副本也是 6.4s → 与 home 里的数据量无关） |
| 版本检查那一步的代价 | 单独测 `runtime.fetchLatestVersion()` | 网络通时 0.2s；不通时两个镜像各 15s 超时（app.log 18:07 有现场） |
| 纯逻辑 | `npm run check` | 12 项全过 |

> 说明：客户端这一侧现在只剩"窗口加载 + spawn dsh"，都是几百毫秒级。若日志里
> `服务启动` 仍然很长，那是 dsh 自身启动耗时（用上面的脚本可以复现），不属于客户端。

### 5. 每跑一条命令桌面闪一下黑框（已做成客户端自动补丁，随安装包发布）

**根因**：桌面端里的 dsh 跑在 GUI 子系统进程（Electron-as-Node）里、**没有可继承的控制台**；
Windows 在这种父进程下 CreateProcess 一个控制台子进程（pwsh.exe）时，会给它**新建并显示**
一个控制台窗口 —— 于是每调用一次 pwsh 就闪一下黑框。证据：在 pwsh 里量
`GetConsoleWindow()` + `IsWindowVisible()`，补丁前是 `hwnd=1051666 / visible=True`。

具体位置：`@deepseek-ai/dsh-win32-process` 建进程时只填了 `cb: 104`、`dwFlags: 256`
（STARTF_USESTDHANDLES）和三个标准句柄，**没有给控制台窗口指定显示状态**。

**改法**：客户端每次启动、以及装/更新运行时之后，都会调
`src/runtime-patch.js` 的 `ensureRuntimeConsoleHidden()` 给运行时补上这一位（幂等，
改的就是 `%APPDATA%\dsh-desktop\runtime\node_modules\@deepseek-ai\dsh-win32-process\lib\index.js`
里两处 `encodeStartupInfo`：`spawnPipedProcess` 与 `spawnJobProcess`）：

```js
const STARTF_USESHOWWINDOW = 1;
const SW_HIDE = 0;
// ...
dwFlags: 256 | STARTF_USESHOWWINDOW, wShowWindow: SW_HIDE,
```

**为什么不用 `CREATE_NO_WINDOW`**（也就是 Node 的 `windowsHide: true`）：它会让子进程
**没有控制台**，而 `dsh-sandbox-windows-acl` 的源码注释明确写了"受限令牌下
CREATE_NO_WINDOW / CREATE_NEW_CONSOLE 的子进程会 STATUS_DLL_INIT_FAILED"。
隐藏窗口不动控制台，既解决闪窗又不碰这条已知边界。A/B 实测确认过：本机 pwsh 走的是
受限令牌 + Job 的路径（`spawnJobProcess`），给这条路径上 CREATE_NO_WINDOW 虽然当下也能跑，
但没必要冒那个风险。

**放在客户端而不是手改运行时的原因**：dsh 升级会重装 `runtime/node_modules`，手改一次
下次升级就没了；补丁做进客户端 + 每次启动校验，升级后会自动补回来。上游把这两处修好之后，
补丁检测到标记会直接跳过，删掉 `src/runtime-patch.js` 与 `main.js` 里那行调用即可。

**验证**（`GetConsoleWindow()` + `IsWindowVisible()`，改完立即生效——每条命令都是新起
runner 进程读这个文件，不需要重启客户端）：

| 场景 | 补丁前 | 补丁后 |
| --- | --- | --- |
| 前台命令自身 | `hwnd=1051666 / visible=True` | `hwnd=525496 / visible=False` |
| 嵌套 pwsh 5.1 / cmd 中转 | 各自新建可见控制台 | 继承同一个 `hwnd=525496`，不可见 |
| 后台任务 | `hwnd=855552 / visible=True` | `hwnd=591032 / visible=False` |

功能回归：stdout/stderr、UTF-8 中文、`cmd /c exit 7` → `[exit code: 7]`、后台任务、
`git` 等控制台工具全部正常。

补丁模块本身的验证（`npm run check` 里带了单测，另外做了一次真机端到端）：

| 项目 | 结果 |
| --- | --- |
| 单测：上游文件被改成隐藏窗口（两处 dwFlags，且不误伤结构体的 `dwFlags: "uint32"`） | PASS |
| 单测：重复执行不再改动（幂等） | PASS |
| 单测：没有 STARTUPINFO / 陌生文件 → 不动它 | PASS |
| 端到端：把运行时还原成上游原样 → 调 `ensureRuntimeConsoleHidden()` | 第一次 `patched`（日志有记录）、第二次 `already`；产物 `node --check` 通过 |
| 端到端：补丁产物生效后量窗口 | `hwnd=3869710 / visible=False` |

### 上一版装到本机后的验收测试（都是这台机器上跑出来的）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 装的确实是新包 | 安装目录 exe + `resources/app.asar` | ProductVersion 0.1.1；`src/main.js` / `src/dsh.js` / `src/runtime-patch.js` 与仓库**逐字节一致**；asar 内无 `displayBalloon` 调用 |
| 启动路径不依赖网络 | `app.log` | `本地已有 dsh 0.1.5-rc.1，直接启动（版本检查放到界面就绪之后）`，随后按新格式打出耗时 |
| 客户端自身开销 | `app.log` 时间戳 | 首行日志到「开始启动服务」在同一秒内；其余时间都记进「服务启动」 |
| 服务启动耗时 | `app.log` / 隔离测量 | 装完第一次启动 29.2s；同一运行时隔离测只要 **6.2s** → 与"安装后首次运行被 Defender 扫 246MB exe + 安装刚写完盘的繁忙"相符，不是客户端加的 |
| 退出耗时 | `app.log` + `npm run check-exit` | 真实退出 `收到退出请求` → `本地服务已停止，应用退出` 相隔 **1s**（旧实现 8s+5s）；隔离测量 stop=1577ms、无孤儿进程 |
| 关闭窗口→托盘 | 给主窗口发 WM_CLOSE | 窗口隐藏、进程存活、服务继续跑；再启动一次客户端即唤回窗口 |
| 闪窗 | `GetConsoleWindow()` + `IsWindowVisible()` | 前台 `visible=False`；嵌套 powershell 继承同一 hwnd、同样不可见 |
| 功能回归 | 同上 | UTF-8 中文、`cmd /c exit 9` → 9、cwd、文件读写全部正常 |

> 「只提示一次」的额度在第一次关窗口时就用掉了——想再看一次单条提醒，重启客户端后再关窗口。
> 托盘右键 →「退出」的实测（会顺带结束正在进行的会话）留给用户自己按需验证。



## 本轮新增（第二次迭代）

| 需求 | 实现 | 验证 |
| --- | --- | --- |
| 关闭窗口可选「最小化到托盘 / 退出应用」 | 托盘右键「关闭窗口时」+ 引导页「关闭窗口时…」对话框（可勾选记住选择），存在 `settings.json` 的 `closeAction` | 两种取值各跑一遍：`tray` 关窗后进程存活、窗口隐藏且可唤回；`quit` 关窗后进程数归 0 |
| 启动时主动检查并直接更新 | `bootSequence({ autoUpdate: true })`：查到新版直接 `npm install` 再启动服务 | 日志确认"已是最新"分支；更新分支复用同一套安装逻辑（自检已覆盖安装成功路径） |
| 启动进度条显示百分比 | 引导页改为百分比进度条（0→100%），分阶段上报 | 实测进度序列 `80 → 81 → … → 98 → 100`，单调不减 |

附带加了两个实用项：托盘菜单的「设置开机自启动」，以及主进程日志落盘
（`%APPDATA%\dsh-desktop\logs\app.log`）——GUI 进程的 stdout 抓不到，排查问题全靠它。

## 验证结果（都是真实跑出来的）

| 验证项 | 方式 | 结果 |
| --- | --- | --- |
| 全新安装 dsh 运行时 | 自检里把 runtime 清空后重跑 | 下载 npm 12.0.2 + 安装 517 个包，成功 |
| 启动服务并拿到地址 | 真实拉起 `dsh web` | 已装运行时约 **10s** 进界面；从零约 80s |
| Web 鉴权握手 | 复刻浏览器：token → 303 + Cookie → 带 Cookie 请求 | HTTP 200，27660 字节 |
| 启动进度百分比 | 自检断言进度单调递增到 100 | `80 → … → 98 → 100` |
| 版本比较 / 就绪行解析 | `npm run check` | 12 项全过 |
| 图标正确 | 从成品 exe 里提取图标查看 | 与 logo 一致 |
| 打包版完整启动 | 直接运行 `release\win-unpacked\DSH 桌面端.exe` | 窗口标题 `DeepSeek Harness`，官方 UI 正常加载 |
| 关闭到托盘 | 向窗口发 WM_CLOSE 后查进程与窗口状态 | 进程仍 5 个、窗口已隐藏；`ShowWindow` 可唤回 |
| 关闭即退出 | 同上，`closeAction=quit` | 进程数归 0，日志有停止记录 |
| 托盘图标打包 | 检查 asar 内容 | `assets\icon-32.png` 已在包内 |

## 本轮抓到的两个真 bug

1. **`closeAction` 设置读不出来**：PowerShell 写出的 JSON 带 BOM，而 `JSON.parse`
   遇到 BOM 直接抛错，导致**整份设置**悄悄回退成默认值。现在读取时先剥掉 `\uFEFF`。
2. **托盘图标没进安装包**：最初生成到 `build/`，而 `build/` 是 electron-builder 的
   构建资源目录、不进 asar，打包后 `Tray` 拿到不存在的路径并静默跳过。
   已改到 `assets/icon-32.png`（`npm run icon` 会一并生成）。

教训：这两类问题都只在**打包后的真实运行**里才暴露，dev 模式下完全正常。

## 更早一轮修掉的三个缺陷（保留备查）

1. **打包后找不到 Node 运行时**：dev 下 `process.execPath` 是 `build\electron-dist\electron.exe`，
   打包后是 `DSH 桌面端.exe`。按候选路径查找，兼容两种形态。
2. **全新电脑上 spawn ENOENT**：子进程 `cwd` 是 `DSH_HOME`，该目录在全新机器上不存在。
   现在启动前先建目录。
3. **启动就绪行读不到**：`dsh web` 的 stdout 重定向到文件时是块缓冲，`dsh web: <url>`
   迟迟不落盘。改为「管道优先、失败回退文件 + 轮询」。

另外：`--expose-internals`（Electron 内嵌 Node 里 HMR 加载器必需，否则启动即失败）、
停止子进程的 8s + 5s 硬上限（退出流程不会被卡住）。

## 本环境无法验证、你一用就知道的部分

- **托盘图标位置**：Windows 默认把新图标收进任务栏折叠区（点 ∨ 展开可见）。
  图标已确认打进包、`Tray` 创建无报错；UI Automation 枚举通知区域需要管理员权限，
  本会话读不到，所以"图标确实显示在托盘上"这一条请你扫一眼。
- **客户端自我更新**：`DSH_DESKTOP_UPDATE_FEED` 默认留空（未配置时只检查 dsh，不报错）。
  要推送客户端更新，需要一个托管 `latest.yml` 的 HTTP 目录。

## 开发命令

```powershell
cd C:\Users\80441\Desktop\PROJECTS\dsh-desktop
npm run check        # 纯逻辑校验（版本比较、就绪行解析、余额凭据与格式化）
npm run check-balance # 余额真机校验：用本机凭据真的查一次 /user/balance
npm run self-test    # 真实端到端：装运行时 → 启动 → 鉴权握手 → 停止
npm run icon         # 由 assets\logo.png 生成 build\icon.ico 与 assets\icon-32.png
npm run electron     # 下载解压 Electron 到 build/electron-dist
npm run dist         # 打 NSIS 安装包
```

> 打包前先关掉正在运行的「DSH 桌面端」：它会锁住 `release\win-unpacked` 里的 DLL，
> 导致构建报 `EPERM: unlink ...`。`build\electron-dist\` 是打包必需，别删。

更多细节见 `README.md`。

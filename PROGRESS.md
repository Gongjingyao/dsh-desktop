# DSH Desktop 交付说明

**交付物**：`release\DSH-Desktop-Setup-0.1.2-x64.exe`（101,445,061 字节 ≈ 96.7 MB，NSIS 安装包）
**状态**：已完成并验证通过。本包 = 0.1.1 的全部内容 + 「插件列表功能说明」运行时补丁
+ 本机可用的打包入口 + 本节第四轮的两项：**角色插件随包安装**、「在文件资源管理器中显示」窗口修复。
与 0.1.1 是同一 appId 的同一个产品，新包可直接覆盖安装。

> **版本号**：第四轮的改动原先按 0.1.3 打过一次（被打断），按你的要求改回 **0.1.2** 重打；
> 同名旧包已删除，release 下现在只有这一个安装器。`npm run dist` 现在**每次打包前都会先清理
> release 里的旧产物**（旧 exe/7z 与 `win-unpacked`），不会再出现新旧包并存。
>
> **这次改动要生效得先退出正在运行的客户端**：本机运行中的是 0.1.1，里面没有本轮补丁，
> 也没有启动时装插件的那段代码；装完新包（或重启应用）才生效。

> 0.1.1（历史）：`release\DSH-Desktop-Setup-0.1.1-x64.exe`（101,429,522 字节），首个提交之后累积的
> 全部改动（启动慢 / 托盘退出 / 重复托盘提醒 / 日志自增殖 + 运行时「隐藏控制台窗口」补丁）
> 加「查看余额」。

## 0.1.2 新增（本交付已包含）

### 1. 插件列表的「功能说明」字段（运行时补丁）

设置 → 插件 里每一行原本只显示模块名与 Loader 行 id，没有任何说明字段（数据里也没有）。
现在桌面端启动时会给运行时打一个幂等补丁：宿主 `dsh-host-plugin-inventory` 在每条 entry 上透出
插件行 `config.description`，浏览器 `dsh-client-ui-settings-plugin-inventory` 让备注行优先显示它
（没有该字段就退回行 id，其它插件行为不变）。插件侧见
`plugins/dsh-plugin-agent-role/README.md` 的「插件列表里的功能说明」。

### 2. 打包入口 `scripts/dist.js`（`npm run dist`）

原来的 `electron-builder --win nsis` 在本机跑不起来，本轮的脚本把三个坑都绕开了，并且在
`README.md` 里记了一条。三个坑按踩到的顺序：

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `Unknown argument: ...\electron-builder\out\cli\cli.js` | Electron-as-node 下 CLI 的 yargs 把入口脚本路径当成「项目目录」位置参数 | 不走 CLI，直接调 Node API（`build({targets, projectDir, config})`） |
| `Cannot find module 'node:child_process'` | PATH 上的 node 是 v12，不认 `node:` 前缀 | 该脚本只用旧 Node 也支持的写法；Node < 14 时自动用 Electron 自带的 Node 24 重新执行自己 |
| 复制 Electron 发行版时 `ENOTDIR` | **在 Electron 的 Node 下跑打包**：Electron 的 fs 把 `.asar` 当目录，`readdir` 能列出 `default_app.asar` 的归档内容，于是 electron-builder 钻进这个"虚拟目录"，而目标侧它是普通文件 | 打包时强制 `ELECTRON_NO_ASAR=1`（并用 `scripts/dist.js` 直接拒绝没设该变量的 Electron 运行） |

第三条是最难查的一条：报错信息里没有路径，堆栈只指到 builder-util 的 walk/copyDir。定位方式是给
`builder-util/out/fs.js` 临加诊断（打完即还原），打印出失败的 `file`/`parent`/目标路径，再单独写
`_selftest/asar-probe.js` 对比 `ELECTRON_NO_ASAR` 开关下 `lstat/readdir` 的行为差异 —— 开着时
`lstat` 报 `isDirectory=true`，关掉后正常是文件。

**打包前清场**：`cleanRelease()` 会在 build 之前删掉 release 里的旧安装器（`*.exe` / `*.7z` /
`*.blockmap`）与 `win-unpacked`。两个原因：旧包留着容易让人装错版本；上一轮的 `win-unpacked`
被 Defender 扫过之后常处于占用状态，留着它打包可能中途 EBUSY。只删产物，`builder-debug.yml`
之类保留。

### 验证（都是真跑出来的）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 打包成功 | `npm run dist`（系统 npm 6 + Node 12，脚本自动切 Node 24） | PASS：`release\DSH-Desktop-Setup-0.1.2-x64.exe`，101,445,450 字节（第四轮重打后的数字） |
| 版本元数据 | `DSH 桌面端.exe` 的 VersionInfo | PASS：FileVersion `0.1.2`、ProductVersion `0.1.2.0` |
| 包内容与仓库一致 | `_selftest/verify-package.js` 解 asar 逐文件 sha256 比对 | PASS：`src/{main,runtime-patch,dsh,config,balance}.js` 全部逐字节一致 |
| 本轮改动确实进包 | 同上 | PASS：含 `ensurePluginListDescription`，且 `main.js` 里有调用；隐藏控制台补丁仍在 |
| 包内容清单抽查 | `asar.listPackage` | PASS：含 `src/`、`assets/`；不含 `node_modules/`（当时共 17 项；第四轮起含随包插件，27 项） |
| 补丁与插件列表联动 | 隔离 home 起 web，`pluginInventory/list` 按 UTF-8 复核 | PASS：`description` 为正确中文，156 行里仅本插件带该字段（见「第三轮」） |

**注意（已被第四轮推翻）**：上面这几行写的是 0.1.2 第一次交付时的状态 —— 那时候包里**不含**
`plugins/`，角色插件得在目标机器上另跑一次 `scripts/install-agent-role.ps1`。**现在的 0.1.2 包已经把
`plugins/**` 打进 asar**（排除插件自己的 node_modules），启动时由 `src/plugin-install.js` 幂等装进
`DSH_HOME`，新机器装完即带「角色」，不需要再手动装。详见第五节第四轮与 `HANDOFF.md`。


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

## 本轮新增：会话角色插件（agent-role）

**需求**：能给当前对话配置「角色」（项目经理 / 资深前端 / 资深算法工程师这类），并且**对话中随时切换**，
做成插件、在所有模式下都能选。经确认收窄为：只内置一个角色「我的常用角色」（内容 = `~/.dsh/AGENTS.md`
的常驻工作准则），并交付完整插件（GUI 选择器 + `/role` 命令）。

### 为什么不能用 preset 实现

DSH 的「模式」就是 agent preset（`standard` / `ptc` / `cordis` / `minimal`），它决定**工具集 + 提示词**，
且**只能在会话创建时选定**——中途换会让已记录的 tool call 找不到对应工具，所以官方明确不支持会话中途
切换（`dsh-agent-presets` 的已知限制里写得很清楚）。所以"按角色复制几个 preset"只能对新会话生效，
不满足"对话时可以切换"。

而「角色」只需要改系统提示词里的人设文本，不动工具集，因此可以中途切换。方案就按这个思路做：**宿主平面
插件 + 动态提示词段落**，挂在用户级 patch 层 `~/.dsh/cordis.patch.yml`，于是对每个 preset 下的会话同时
生效。

### 交付物

| 文件 | 作用 |
| --- | --- |
| `plugins/dsh-plugin-agent-role/lib/index.js` | 宿主半边：`role` 会话投影、`/role` 命令、`deployment:role` 动态段落 |
| `plugins/dsh-plugin-agent-role/lib/roles.js` | 内置角色（我的常用角色）与角色表校验 |
| `plugins/dsh-plugin-agent-role/lib/client.js` | 浏览器半边：给 `/role` 挂 popup 选择器（与 `/permission` 同构） |
| `plugins/dsh-plugin-agent-role/README.md` | 用法、配置、安装、关键约束 |
| `scripts/install-agent-role.ps1` | 幂等安装脚本（纯 ASCII，避免 Windows PowerShell 按 ANSI 读脚本） |

已实际装入本机：`~/.dsh/profiles/{web,headless,sdk}/package.json` 声明依赖 + `node_modules/agent-role`
junction，并在 `~/.dsh/cordis.patch.yml` 插入插件行。

### 验证（都是真跑出来的）

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 插件行进入组合 | `dsh --profile web --dump-config` | PASS，插件行在 home patch 层且 config 正确 |
| 角色进入系统提示词 | `dsh --profile headless "…"` 一次真实模型调用，再逐帧解压会话日志查 `system/message` | PASS：`## 当前会话角色：我的常用角色` 紧跟人设之后、先于工具引导 |
| **对话中切换** | 探针在 `session/created` 后追加 `role/selected`（切到另一个角色），再查真实请求 | PASS：投影 `{"role":"my-default"}` → `{"role":"switched-role"}`；请求里出现新角色标记词、旧角色标记词 **0 次** |
| 客户端半边进 boot graph | 取**线上 GUI**（50210）的页面 HTML | PASS：`agent-role/client.js` 已在组合包列表中 |
| 客户端 bundle 下发 | GET 组合包 URL | PASS：HTTP 200，内容含 `popupSelect` 装饰器代码 |
| 热加载 | 本次会话自身的系统提示词 | PASS：无需重启桌面端，角色段落已生效（web profile 是 `patchReload: live`） |
| 安装脚本幂等 | 重复执行 | PASS：第二次全部走「已就位，跳过」 |
| 失败是否 fail loud | 故意把 profile manifest 写坏后启动 | PASS：直接报「2 entries did not activate」并列出待定服务，不静默降级 |

### 踩到的三个真坑

1. **loader 行的 `name` 必须等于插件 `package.json` 的 `name`**。`dsh-client-modules` 定位插件包时，
   用行里的 specifier 解析出模块、再向上找 manifest，并**要求 manifest 的 name 等于该 specifier**；
   不一致就把这行当成"没有浏览器半边"**静默跳过**——宿主正常工作、页面里永远没有选择器、且没有任何
   报错。这条是靠一个临时探针插件逐段复刻解析链路才定位到的（症状是 boot graph 里没有我的包）。
   已在插件 README 里写死这条约束。
2. **会话日志是多个独立 zstd 帧首尾相接**（本机实测一次会话 6~7 帧）。`zlib.zstdDecompressSync` 只吃
   第一帧，直接解会得到"只有 215 字符、看不到任何消息"的假象，排查时按帧切分才看得到真实内容。
3. **插件自己的会话事件必须带 `ignorable: true`**。`role/selected` 不在 DSH 的
   `KNOWN_SESSION_EVENT_TYPES` 里，缺这个标记时下次 resume 会因为"日志里有本构建不认识的必读事件"
   而被拒绝读取。

### 没能验证 / 遗留

- **在浏览器里真点一次下拉选择器**没有条件做（本会话没有可交互的图形桌面）。已验证到"bundle 已下发到
  浏览器、宿主 `/role` 命令存在、投影与段落联动"，请你在 GUI 里输入 `/role` 点一次确认。
- **resume / fork 恢复角色**没有实测：事件已带 `ignorable` 标记、投影是标准 fold，按契约应当恢复，
  但没跑过"关掉再打开同一会话"。
- **`role` 这个投影键**若将来与 DSH 内置键撞名，注册表会直接抛错（loud），改个键名即可。

### 第二轮：设置页增删角色（已完成）

按你的确认补上了缺失的那一半：**设置 → 角色** 一整页（`settings.section` 插槽，不是 General 里的一行），
每个角色一张卡片（名称 / 人设文本 / 删除）+「新增角色」+ 默认角色选择 + 保存/撤销。改动写进
`~/.dsh/settings.yaml` 的 `agent-role:` 段，热生效。

宿主侧新增 `agent-role` 设置命名空间（schemastery `Schema.dict(Schema.object(...))`，让设置文档保持
人能直接读写的形状）；角色表变成「loader 配置 = composition base，settings.yaml = 用户层」的分层。

第二轮验证（同样是真跑出来的）：

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 无设置文档 | headless 真实会话 | PASS：用 composition base 的内置角色 |
| **设置文档覆盖角色表** | 手写 `settings.yaml` 指定另一个角色 | PASS：请求里是新角色标记词，内置角色 **0 次** |
| **浏览器同款 RPC 写入** | 复刻客户端握手（token→Cookie）后 POST `/api/settings/mutate`，ops 与设置页保存完全一致 | PASS：`describe` 能列出 `agent-role`；写入后 `settings.yaml` 正是那张表（不含 base 的键） |
| RPC 写入的闭环 | 用 RPC 写出的 `settings.yaml` 再跑一次真实会话 | PASS：请求用的是 RPC 写入的角色 |
| 坏文档不炸 | `settings.yaml` 写 `roles: {}` + `defaultRole: nope` | PASS：启动正常、不注入角色段落（不是让请求失败） |
| 安装脚本幂等 | 重复执行（含新增的插件依赖链接步骤） | PASS：全部「已就位，跳过」 |

第二轮踩到的坑（都写进插件 README 了）：

4. **设置分层是递归合并普通对象**，用户层删不掉 base 里的键 —— 直接吃「解析后的值」会让设置页里
   删掉的内置角色保存后原地复活。改成：用户层一旦声明了 `roles` 就以它为准，删掉整段即回退 base；
   客户端同理读原始用户层。
5. **`installSection` 的 `validate` 在注册期就会跑**，手改坏一个字段会让整个注册抛错、被 cordis
   静默吞掉（症状是设置页空着、角色却仍是 base）。改成不挂 `validate`，坏值交给统一的收敛函数过滤
   + 兜底，写入校验放在设置页保存前。
6. **投影 `init` 不能钉住创建时的默认角色**：否则改默认角色对已有会话永远不生效。改成投影里空串表示
   "从没显式切换过"（`stateVersion` 升到 2），此时跟随当前配置的默认值。
7. **junction 安装的插件解析不到自己的依赖**：Node 会解引用到工作区真实路径，
   `require('@deepseek-ai/schemastery')` 直接 `Cannot find module`。安装脚本会按插件
   `package.json` 的 `dependencies` 自动补 `plugins/<插件>/node_modules/<dep>` 的 junction。

### 没能验证 / 遗留

- **在浏览器里真点一次**：下拉选择器和设置页的渲染/保存按钮都没有条件点（本会话没有可交互的图形
  桌面）。已验证到"bundle 已下发到浏览器、宿主命令与设置命名空间都在、RPC 写入闭环成立"，请你在 GUI 里
  输入 `/role` 点一次、以及打开「设置 → 角色」改一次确认。
- **resume / fork 恢复角色**没有实测：事件已带 `ignorable` 标记、投影是标准 fold，按契约应当恢复，
  但没跑过"关掉再打开同一会话"。
- **`role` 这个投影键**若将来与 DSH 内置键撞名，注册表会直接抛错（loud），改个键名即可。

（内置角色「我的常用角色」的文案是我按 `~/.dsh/AGENTS.md` 整理的，在设置页里直接改即可。）

### 复验用的脚手架

`_selftest/agent-role/`（已被 gitignore）留了这些脚本，以后改动可以重跑：

- `stage.ps1`：搭一个隔离的 DSH_HOME（web + headless 两个 profile、junction、patch 行，可选复制凭据）；
- `check-log.js`：逐帧解压会话日志并检查标记词（`zstdDecompressSync` 只吃第一帧，所以必须自己切帧）；
- `rpc-test.ps1`：复刻浏览器握手后打 `settings/describe` 与 `settings/mutate`，验证设置写入；
- `client-harness.js`：**用迷你 React 在 Node 里跑真实的 `lib/client.js`**（29 项断言：注册、渲染、
  增删改、保存 ops、用户层优先、只读、选择器）—— 把原本只能靠浏览器点的那半边变成可断言的东西；
- `patch-check.js`：把运行时补丁打在工作区副本上，断言变换结果、语法与幂等；
- `apply-patch.js`：把插件列表说明补丁立即打到运行时（桌面端每次启动也会自己打）；
- `verify-inventory.js`：Node 侧按 UTF-8 复核 inventory 响应里的 `description`（PS 5.1 会解错码）；
- `verify-package.js`：解 0.1.2 的 app.asar，与仓库源码逐字节比对并检查版本号与本轮改动；
- `asar-probe.js`：对比 `ELECTRON_NO_ASAR` 开关下 `lstat`/`readdir` 对 `.asar` 的行为（打包那个 ENOTDIR 的证据）。

### 第三轮：用户反馈的两个问题

**1. 「设置 → 插件」那一行没有中文说明。**

查清后确认：这个列表由 shipped 包渲染，每行只显示 `moduleShortName(模块名)` 与
`entrySubtitle(行 id)`，数据里**根本没有说明字段**。按你的选择做成「加字段 + 备注行显示它」：
桌面端打运行时补丁（`src/runtime-patch.js` 的 `ensurePluginListDescription`），宿主
`dsh-host-plugin-inventory` 在每条 entry 上透出插件行 `config.description`，浏览器
`dsh-client-ui-settings-plugin-inventory` 让备注行优先显示它（没有该字段就退回行 id，其它插件不变）。
本插件的行因此写上 `description: 会话角色：…`。loader 行 id 保持 `agent-role` 未改。

**2. 重启客户端后设置里没有「角色」。**

根因是客户端服务注入方式：我把设置页注册嵌在 `ctx.inject([...])` 里，而 shipped 的设置类插件
（`ui-permission-presets`、`ui-agent-preset`）一律用**插件级 `inject`**。两种 inject 在 cordis 里
解析到的实例不同 —— 这一点我在宿主侧的探针上也撞到过（插件级 `inject: ['settings']` 拿到空注册表，
`ctx.inject(['settings'])` 拿到真实的那个）。改成插件级 inject、并在 `apply` 里直接
`ctx.slots.inject("settings.section", …)` 注册；读取改用与 permission 同款的共享镜像
`ctx.settingsScope.describe()`（不再用我原先的 `bind()`），写入用 `ctx.remote.settings.mutate` +
`face.acceptView`。

**顺带修掉一个会让设置页直接崩的真 bug**：草稿同步的 `useEffect` 原先放在几个早返回之后，
是 React hooks 顺序违规（首次渲染不调用它，第二次调用就抛错）。已移到早返回之前。
`client-harness.js` 就是为这类问题准备的。

第三轮验证（都是真跑出来的）：

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 客户端注册与渲染 | `client-harness.js` 跑真实 bundle | PASS：29 项全过（含保存 ops 形状、revision、用户层优先、只读、选择器 active） |
| 运行时补丁变换 | `patch-check.js` 打在工作区副本上 | PASS：14 项全过（变换生效、只插一次、产物过 `--check`、幂等、陌生文件不动） |
| 补丁落到真实运行时 | `apply-patch.js` + 标记计数 | PASS：两个文件各 1 处标记，再跑一次全 `already` |
| 宿主响应带说明 | 隔离 home 起 web，`pluginInventory/list` 用 Node 按 UTF-8 复核 | PASS：`description === "这是测试用的中文功能说明"`，156 行里仅本插件带该字段 |
| 客户端补丁已下发 | 取 `/plugins` 组合包内容 | PASS：含 `typeof description === "string"` 与 `description: entry.description,` |

### 第四轮：插件随包安装 + 「在文件资源管理器中显示」修复（本交付）

**1. 角色插件随包安装。** `electron-builder.yml` 的 `files` 加 `plugins/**/*`（排除
`plugins/**/node_modules`）；新增 `src/plugin-install.js`，启动时把随包的
`plugins/dsh-plugin-agent-role` **复制**到 `<DSH_HOME>/profiles/<profile>/node_modules/agent-role/`，
并确保 `<DSH_HOME>/cordis.patch.yml` 里有那一行。复制成真实目录而不是 junction，是为了让插件自己的
`require('@deepseek-ai/schemastery')` 能顺着父目录链走到 `profiles/node_modules` 那个依赖闭包。
逐字节比对，内容一致就不写盘（幂等）；已有三个 profile 里指向仓库的 junction 因此是 no-op。
插件侧顺手做了降级：`@deepseek-ai/schemastery` 改成可选 require，缺失时只跳过「设置 → 角色」页并
warn，不再连带 dsh 启动失败。

**2. 「在文件资源管理器中显示」点了没反应。** 链路是交付物卡片 →
`POST /api/present.open?...&action=reveal` → `dsh-native-command` 的 `execFile('explorer.exe',
['/select,', url])`。根因：`runNativeCommand` 给每个子进程都加 `windowsHide: true`，而 explorer 的
窗口**就是子进程自己的窗口**，于是被一起压掉 —— 宿主返回成功、前端提示已请求，用户什么都看不见。
补丁 `src/runtime-patch.js` 的 `ensureNativeOpenVisible()` 只对 `explorer.exe` 不隐藏；
`powershell Invoke-Item`、`wslpath` 等"启动器"仍保持隐藏（被启动的是另一个进程，藏掉控制台正是本意）。

**3. 覆盖安装到哪个目录（顺带查清）。** `oneClick: false` + `allowToChangeInstallationDirectory:
true` 走的是 assisted installer，`multiUser.nsh` 会先读
`HKCU\Software\<APP_GUID>\InstallLocation`，读到就把 `$INSTDIR` 预设成它 —— 所以第一次选了自定义
目录的话，新包是**覆盖升级到原目录**，不是装回默认目录，选择页也会预填并提示重新安装/升级。

第四轮验证（都是真跑出来的）：

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 插件安装逻辑 | `_selftest/agent-role/plugin-install-check.js` | PASS：18 项（两种 patch 文件形态、幂等、陌生形态返回 skipped 不动用户文件） |
| 全新机器集成 | `_selftest/agent-role/fresh-install-check.ps1` | PASS：全新 `DSH_HOME` → 装插件 → dsh 首启无报错 → 会话日志里出现内置角色名 |
| 三个运行时补丁 | `_selftest/agent-role/patch-check.js` | PASS：变换、产物语法、幂等、陌生文件不动 |
| 窗口确实弹出 | `_selftest/reveal-probe.js` + 窗口标题计数 | PASS：真实模块调 `revealNativePath`，窗口 1 → 2 个，标题 `release` |
| 打包装箱 | `npm run dist` + `_selftest/verify-package.js` | PASS：26 项全绿（包内源码/插件与仓库逐字节一致、版本 0.1.2、三个补丁都在、清单 27 项） |

**没能验证**：插件的设置页（设置 → 角色）在真实浏览器里仍没人点过 —— 本机没有可交互图形桌面，
只能用 `client-harness.js` 覆盖逻辑。

### 第五轮：角色设置页分两级 + 会话内实时角色标签

用户（在真实界面里）提的三点，只改插件浏览器半边 `plugins/dsh-plugin-agent-role/lib/client.js`：
**不动版本号，仍是 0.1.2**；改完按用户要求重打了一次包（`npm run dist` 先自动删掉同名旧包，
新包 101,445,061 字节，`verify-package.js` 26 项全绿）。

**1. 设置页分成两级。** 原来一页铺开：默认角色下拉 + 每个角色一张卡片（id、名称、人设、删除）。
现在一级只有角色名称列表（点行进入），二级才是单个角色的 id（只读）、名称、人设文本、删除与返回。
「新增角色」在一级，点完直接进新角色的二级页（新人设本来就是空的，省一次点击）。
「保存 / 撤销改动」两级都在，作用于整张表。层级用组件内的 `openId` 表示，不额外开 effect 同步：
草稿是本地状态，"打开的角色还在不在表里"直接算，删掉后自动退回列表。

**2. 默认角色下拉只剩名称。** 候选项从 `名称（id）` 改成 `名称`（id 挪到二级页显示）。

**3. 会话内实时角色标签。** 注册 `conversation.input.left`（session 级 list 插槽，输入框工具行左侧，
Plan 芯片那一排）显示 `角色：<当前角色名>`。数据来自槽位的标准 props `useProjection("role")` ——
就是宿主按会话日志折出来的 `role` 投影 wire 视图（没显式切换过的会话是默认角色），切换后随投影推送
自动更新，前端不自己维护状态；投影不可用时整个标签不渲染（不留空壳）。这是 dsh 自己的
`ui-plan` 芯片的同一套写法（`dsh-cordis-client-runner` 里的插槽目录明确列出该插槽的
standardProps 含 `useProjection`）。

第五轮验证：

| 项目 | 方式 | 结果 |
| --- | --- | --- |
| 客户端半边逻辑 | `_selftest/agent-role/client-harness.js`（迷你 React 跑真实 bundle） | PASS：**43 项**（比上一轮 +14），含两级导航、默认下拉只剩名称、新增直达二级、删除退回一级、指示器随投影变化 |
| 产物语法 | Electron 自带的 Node 24 `--check` | PASS：`client.js` 可解析（PATH 上的 Node 12 不认可选链，这是它报错的唯一原因） |
| 打包装箱 | `npm run dist` + `_selftest/verify-package.js` | PASS：26 项全绿，包内插件（含 README）与仓库逐字节一致 |

harness 当场抓到一个真 bug：二级页元素被提前构造，`openId` 为 null 时也会去取 `draft.roles[null]`，
`useState` 首次渲染即抛错。已改成按 id 惰性构造（`detailPageOf(id)`）。

**仍未验证**：真实浏览器里长什么样（本机没有可交互图形桌面）。要看到这些改动：重启桌面端 /
dsh 进程（插件是以 junction 指向仓库装的，改代码即改装好的包）。

### 回滚

删掉 `~/.dsh/cordis.patch.yml` 里的 `agent-role` 那段，再删掉
`~/.dsh/profiles/{web,headless,sdk}/node_modules/agent-role` 三个 junction（用 `cmd /c rmdir`，
别用 `Remove-Item -Recurse`——那会顺着链接删到插件源码目录）即可。插件的用户设置留在
`~/.dsh/settings.yaml` 的 `agent-role:` 段里，按需一并删除。

插件列表说明补丁想撤掉的话，把 `src/main.js` 里那行 `runtimePatch.ensurePluginListDescription(...)`
注释掉并重装 dsh 运行时即可（补丁跟着 node_modules 一起没了）。

## 实现备忘

> 原来写在 README 里，README 精简后挪到这里。都是实现层面的约束和踩过的坑，改代码前值得先看。

### 启动各阶段耗时（参考）

| 阶段 | 说明 | 耗时 |
| --- | --- | --- |
| 准备运行环境 | 读本地已装版本（不联网） | 立即（进度 0→30%） |
| 安装 / 更新 dsh | 只在本地没有可用运行时（首次），或你点了「立即更新」时才会联网 | 首次约 30s（进度 10→78%） |
| 启动服务 | 拉起本地 `dsh web`，端口由系统分配 | 取决于 dsh 自身 |
| 打开界面 | 载入 Web UI | 立即（100%） |

安装阶段没有精确的进度事件，进度条是按耗时估算的爬升；服务启动阶段同理。引导页右侧有「显示日志」。

### 命令行窗口不会闪

新机器上第一次启动、以及每次升级 dsh 之后，客户端都会给运行时补一个「隐藏子进程控制台窗口」的
补丁（`src/runtime-patch.js`，幂等）：dsh 本身跑在没有控制台的 GUI 进程里，不补的话 agent 每跑一条
命令，Windows 都会给它新建并弹出一个黑框。

补丁只在**进程创建的显示状态**上动手（`STARTF_USESHOWWINDOW | SW_HIDE`），不改变子进程有没有控制台
—— 后者（`CREATE_NO_WINDOW` / Node 的 `windowsHide`）在受限令牌的沙箱下会让子进程直接起不来
（`STATUS_DLL_INIT_FAILED`）。dsh 上游把这两处改好之后补丁会自动跳过（检测到标记就什么都不做），
届时删掉 `src/runtime-patch.js` 与 `main.js` 里那行调用即可。

### 实现上必须注意的四点

1. **`dsh web` 必须加 `--expose-internals`**。dsh 的 HMR 加载器优先用它直接取 Node 内部 ESM
   loader；否则回退到 `node-addon-require-builtin`，而那个原生插件在 Electron 内嵌的 Node 里用不了
   （`no compatible GetAlignedPointerFromEmbedderData symbol found`），启动会直接失败。
2. **子进程的 `cwd` 是 `DSH_HOME`，目录必须先建出来**。全新电脑上它并不存在，而 Windows 下不存在的
   cwd 会让 `spawn` 直接抛 `ENOENT`。
3. **子进程 stdio 采用「管道优先、失败回退文件」**。stdout 重定向到文件时，就绪那一行
   （`dsh web: <url>`）不一定及时落盘；但某些受限环境又不允许给子进程建管道，所以两条路都要有。
   注意：**文件回退路径下子进程的行已经写进日志文件了，父进程不能再往同一个文件写回去**，否则就是
   "读出来 → 写回去 → 又被读出来"的自增殖循环（日志每轮翻倍）。
4. **打包后 `process.execPath` 是 `DSH 桌面端.exe`**，不是 `electron.exe`。这段路径解析必须同时兼容
   开发态与打包态，否则只有成品会踩坑。

### 托盘与退出

- 窗口的 `close` 事件里判断 `closeAction`：为 `tray` 时 `preventDefault()` 并 `hide()`，否则放行给
  默认关闭流程。
- 真正退出统一走 `quitApp()`（置 `quitting = true` 再 `app.quit()`），否则会被 `close` 处理器拦住变成
  「隐藏」；重复点击由 `quitting` 挡掉，`before-quit` 里的收尾由 `shutdownInFlight` 保证只跑一次。
- `before-quit` 先 `preventDefault()`，收起窗口与托盘图标（让"点了退出"立刻有反馈），再停子进程，
  停完重放 `app.quit()`。
- `stop()` **按进程存活判断是否结束，不等 `close` 事件**：`close` 还要求 stdio 全部关闭，可能被 dsh
  派生的、持有同一批管道的工作进程拖住。Windows 上直接 `taskkill /T /F` 杀整棵树（宽限期为 0：
  不带 `/F` 的 taskkill 对无窗口的控制台进程必然失败），被安全软件/权限拒绝时退回 `child.kill()`。
- 托盘图标用独立的 `build/icon-32.png`（`npm run icon` 会一并生成），直接拿 ICO 给 `Tray` 在部分环境
  下会显示异常。
- 「最小化到托盘」的提示只走系统通知一个通道：老的 `tray.displayBalloon` 会跟它一起弹两个，而且展开
  任务栏折叠区时 Windows 还会把气泡重播一次。

### 关于 Web 鉴权

`dsh web` 启动时会打印带一次性 token 的地址。浏览器访问该地址会拿到一个 HttpOnly Cookie 并 303 跳到
干净的 `/`；之后的请求都靠 Cookie。所以：

- 应用里直接 `loadURL(带 token 的地址)` 即可，窗口会自然完成握手；
- 用脚本校验可用性时，**不能**只发一次不带 Cookie 的请求（那必然是 401），要复刻「拿 token 换
  Cookie → 带 Cookie 请求」两步。

# 交接：0.1.2 打包已完成（含角色插件随包安装 + 两个 dsh 运行时补丁）

> 写给下一个会话的 agent。**先读这一份**，再动代码。所有结论都是真跑出来的，
> 复验命令都写在下面；不确定的地方标了「未验证」，请自己跑一遍再下结论。

## 一、当前状态（一句话）

**这一轮已经收尾：安装器 exe 已组装并核验通过。** 产物
`release\DSH-Desktop-Setup-0.1.2-x64.exe`，`_selftest/verify-package.js`
26 项断言全绿（包内源码与插件与仓库逐字节一致、版本 0.1.2、三个补丁都在、清单 27 项）。

版本号说明：本轮的改动原先按 `0.1.3` 打过一次（被打断，`release` 里留下了 0.1.3 的载荷），
按用户要求**改回 `0.1.2` 重打**；同名旧包已在打包时被自动清理，release 下现在没有 0.1.3 的任何残留。

**之后又在同一个 0.1.2 上改了两轮、各重打了一次包**（都没动版本号；`npm run dist` 每次先删旧包）：

- **第五轮 · 插件界面**：角色设置页分两级（一级只列名称、二级编辑名称与人设）、默认角色下拉只剩名称、
  会话输入行加实时角色标签。改的是 `plugins/dsh-plugin-agent-role/lib/client.js` + client harness。
- **第六轮 · 角色分工重排**：`~/.dsh/AGENTS.md` 清空（开发者准则迁进新角色「前端开发者」）、
  「我的常用角色」只留通用约束、「需求搭档」拆成短人设 + `requirement-analysis` skill；
  仓库侧把 `plugins/dsh-plugin-agent-role/lib/roles.js` 的 `BUILTIN_ROLES` 同步成这三个角色。

当前 exe 的确切大小以 `PROGRESS.md` 顶部或 `Get-Item release\*.exe` 为准（每次重打都会变）。

## 二、下次怎么重打（已跑通，命令可直接抄）

```powershell
# 1. 打包（大约 2~4 分钟）。必须在放开沙箱的权限下跑：
#    electron-builder 要 spawn app-builder.exe / npm ls 并用管道读输出，受限沙箱下固定 EPERM
#    （本轮实测：workspace-write 下报 spawn EPERM，danger-full-access 下通过）。
#    scripts/dist.js 会先自动清理 release 里的旧产物（旧 exe/7z 与 win-unpacked），无需手动删。
cd C:\Users\80441\Desktop\PROJECTS\dsh-desktop
npm run dist

# 打包仍失败时再手动清一次中间产物重试（Defender 扫大文件会造成 EBUSY）：
#   Remove-Item release\win-unpacked -Recurse -Force

# 2. 核验产物（26 项断言：包内文件与仓库逐字节比对 + 版本 + 本轮改动 + 清单）
$env:ELECTRON_RUN_AS_NODE='1'; $env:ELECTRON_NO_ASAR='1'
& build\electron-dist\electron.exe _selftest\verify-package.js
```

`PROGRESS.md` 顶部已改成 0.1.2 的交付说明。

## 三、用户这一轮提的三件事，各自的状态

| # | 用户要求 | 状态 |
|---|---|---|
| ① | 把角色插件打进安装包 | **代码完成、端到端验证、已随 0.1.2 打包发出**（asar 里含 `plugins/dsh-plugin-agent-role/`） |
| ② | 「在文件资源管理器中显示」点了没反应 | **根因定位 + 补丁 + 验证通过**；运行中的应用需重启才生效 |
| ③ | 首次装在自定义目录时，新包是重装还是覆盖到旧目录 | **已查明（有注册表与模板证据）**，见第六节 |

### ① 插件随包安装（已完成）

- `electron-builder.yml` 的 `files` 加了 `plugins/**/*`（并排除 `plugins/**/node_modules`）。
- 新增 `src/plugin-install.js`：启动时（`src/main.js` 里 `pluginInstall.ensureAgentRolePlugin({ onLine: log })`）
  把随包的 `plugins/dsh-plugin-agent-role` **复制**到
  `<DSH_HOME>/profiles/<profile>/node_modules/agent-role/`，并确保 `<DSH_HOME>/cordis.patch.yml`
  里有那一行。幂等：逐字节比对，内容一致不写盘。
  - 复制成真实目录（不是 junction），是为了让插件自己的 `require('@deepseek-ai/schemastery')`
    能顺着父目录链走到 `<DSH_HOME>/profiles/node_modules`（dsh 建好的依赖闭包）。
  - 全新机器上 dsh 还没初始化 profile：提前建 `profiles/web/node_modules/agent-role` 是安全的
    （`initProfile` 只补缺失文件、从不删）。
  - 覆盖 `web` + 所有已存在且带 `cordis.yml` 的 profile（命令行用户走 headless 才有角色）。
  - patch 文件两种形态都支持：流式 `[ ... ]` 插到最后一个 `]` 之前；块式 `- insert:` 追加到末尾；
    形态不认识（像 mapping）就返回 `skipped`，绝不动用户的文件。
- 插件侧顺手做了**优雅降级**：`@deepseek-ai/schemastery` 改成可选 require，缺失时只跳过
  「设置 → 角色」页并 warn，不再让插件（乃至 dsh 启动）失败。
- 验证：`_selftest/agent-role/plugin-install-check.js`（18 项，含两种 YAML 形态与幂等）；
  `_selftest/agent-role/fresh-install-check.ps1`（**全新 DSH_HOME 集成测试**：客户端装插件 →
  dsh 首次启动无报错 → 会话日志里出现内置角色名）。两条都 PASS。

### ② 「在文件资源管理器中显示」没反应（已修，需重启应用）

链路：交付物卡片 → `POST /api/present.open?...&action=reveal`（由 `dsh-client-ui-deliverables` 的
node 半边提供）→ `sessionController.openWorkspacePath` → `dsh-native-command` 的
`revealNativePath` → `execFile('explorer.exe', ['/select,', fileUrl])`。

**根因**：`dsh-native-command` 的 `runNativeCommand` 给**每个**子进程都加 `windowsHide: true`
（本意是藏掉控制台黑框），但 explorer.exe 的窗口**就是子进程自己的窗口**，于是窗口被一起压掉：
宿主返回成功（explorer 退出码 1 本来就被当作正常交接）、前端显示「已请求在文件资源管理器中显示」，
用户什么都看不见。

**证据**（真跑出来的对照，`_selftest/reveal-probe.js` + 窗口标题计数）：

| 调用方式 | 新窗口 |
| --- | --- |
| `Start-Process explorer.exe '/select,', <路径>` | ✅ 出现标题为 `release` 的窗口 |
| `Start-Process explorer.exe '/select,', <file:// URL>` | ✅ 出现 |
| Node `spawn(..., {stdio:'ignore', windowsHide:true})` | ❌ 无窗口 |
| Node `spawn(..., {stdio:'ignore', windowsHide:false})` | ✅ 出现 |

注意：**`execFile` 的默认管道 stdio 在受限沙箱下会 EPERM**，用它做对照会得到假的「没窗口」，
必须用 `stdio: 'ignore'` 才能测准（我在这里绕过一次弯路）。

**补丁**：`src/runtime-patch.js` 的 `ensureNativeOpenVisible()` —— 只对 `explorer.exe` 不隐藏：

```js
windowsHide: !/(^|[\\/])explorer\.exe$/i.test(command) /* EXPLORER_WINDOW_IS_THE_CHILD */
```

其余命令（`powershell Invoke-Item`、`wslpath` 等）保持隐藏：那类只是"启动器"，被启动的应用是
另一个进程，窗口照常出现，藏掉它们的控制台正是原本想要的效果。
验证：`_selftest/agent-role/patch-check.js`（变换/语法/幂等）+ 用**真实模块**调
`revealNativePath` → 窗口 1 → 2 个，标题 `release`。

### ③ 覆盖安装到哪个目录（已查明）

`oneClick: false` + `allowToChangeInstallationDirectory: true` → 走 electron-builder 的
**assisted installer**。`templates/nsis/multiUser.nsh` 的 `setInstallModePerUser`：

```nsis
ReadRegStr $perUserInstallationFolder HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
${if} $perUserInstallationFolder != ""
  StrCpy $INSTDIR $perUserInstallationFolder        ; 复用上次的安装目录
${else}
  StrCpy $INSTDIR "$LocalAppData\Programs\${APP_FILENAME}"   ; 默认目录
${endif}
```

`INSTALL_REGISTRY_KEY = "Software\<APP_GUID>"`，本机 GUID 是 `99d3b161-a891-5338-88af-d766b76d586e`
（由 appId `com.dsh.desktop` 决定，换包不变）。

**结论：你第一次选了自定义目录的话，新安装包会读到那个目录、把 `$INSTDIR` 预设成它，
直接覆盖升级到原目录（不是装回默认目录）**；目录选择页会预填该路径，界面上还会提示
「已存在安装(<目录>)，将重新安装/升级」（`perUserInstallExists`/`reinstallUpgrade`）。
本机现状：`HKCU\Software\99d3b161-…\InstallLocation = C:\Users\80441\AppData\Local\Programs\dsh-desktop`
（即默认位置，说明这台机器当初没改目录）。用户数据（`%APPDATA%\dsh-desktop`、`~/.dsh`）不删。

## 四、环境与工具链的坑（务必先看，能省你半小时）

1. **PATH 上的 node 是 v12**，而 electron-builder 26 要求 ≥ 14。`npm run dist` 走的是
   `scripts/dist.js`：Node 太旧时自动用 Electron 自带的 Node 24 重新执行自己，并在 Electron 的
   Node 下强制 `ELECTRON_NO_ASAR=1`。
   - 为什么必须关 asar：Electron 的 `fs` 把 `.asar` 文件当目录，electron-builder 遍历 Electron
     发行版时会钻进 `default_app.asar` 的"虚拟目录"，写目标时 ENOTDIR。实测开着时 `lstat` 报
     `isDirectory=true`，关掉后正常（`_selftest/asar-probe.js` 是证据）。
   - 不要再用 `electron-builder --win nsis` 这种 CLI 形式：在 Electron-as-node 下 yargs 会把入口
     脚本路径当成「项目目录」位置参数，报 `Unknown argument: …cli.js`。
2. **受限沙箱**：`npm run dist`、以及任何要真起 explorer.exe / 用管道 stdio 的操作，都得在
   `danger-full-access` 下跑（工具调用里带 `sandbox_permissions` + 一句 justification）。
   写 `~/.dsh`、`%APPDATA%\dsh-desktop\runtime` 也需要它。
3. **PowerShell 5.1 的两个坑**：
   - `-File` 脚本里有中文 → 按 ANSI 解析 → 语法崩。`-File` 脚本一律**纯 ASCII**（要中文就用
     `[char]0x….` 拼，现有 `scripts/install-agent-role.ps1`、`_selftest/agent-role/stage.ps1`
     都是这个风格）。
   - **别用 `Get-Content -Raw` + `WriteAllText` 往返改含中文的文件**：PS 5.1 会当 ANSI 读，
     中文标签和字符串字面量都会被破坏（本会话把 `_selftest/verify-package.js` 弄坏过一次，
     已重写）。要改文件用编辑器工具，不要走 PowerShell。
   - `$home` / `$PSScriptRoot` 有陷阱：前者是只读变量（写它会静默失败，我曾因此差点动到用户主目录，
     被沙箱挡住），后者在 `-File` 的参数默认值里可能为空 —— 都在函数体里解析。
4. **asar 路径**：`@electron/asar` 的 `extractFile` 对深层嵌套路径（`plugins/<pkg>/lib/x.js`）
   只认反斜杠；`src/main.js` 两种都行。`_selftest/verify-package.js` 里的 `extract()` 两种都试。
5. **清理 junction**：删带 junction 的临时目录前，先用 `cmd /c rmdir` 逐个拆链接（`Remove-Item -Recurse`
   会顺着链接删到目标目录）。本会话用的模式见 `_selftest/agent-role/stage.ps1` 与每轮清理命令。

## 五、已经验证过的（别重复做）

- `_selftest/agent-role/patch-check.js`：三个运行时补丁的文本变换、产物语法、幂等、陌生文件不动它。
- `_selftest/agent-role/plugin-install-check.js`：插件安装逻辑 18 项。
- `_selftest/agent-role/fresh-install-check.ps1`：全新 DSH_HOME 的「装插件 → dsh 首启 → 角色注入」。
- `_selftest/reveal-probe.js` + 窗口计数：「在文件资源管理器中显示」修复后确实弹窗。
- `_selftest/verify-package.js`：**0.1.2 的 exe 组装完后已重跑，asar 26 项全绿**。
- 更早（0.1.2 第一次交付那一轮）已验：客户端半边 29 项（`_selftest/agent-role/client-harness.js`）、
  设置文档读写与 RPC、角色切换、插件列表 description 透出。细节见 `PROGRESS.md`。

## 六、真实环境现状（别踩）

- **运行中的应用是 0.1.1**（`%LOCALAPPDATA%\Programs\dsh-desktop`），它里面没有本轮的三个补丁调用；
  运行中的 dsh 进程也缓存着旧的 `agent-role` 插件代码与旧的 `dsh-native-command`。
  所以：**装 0.1.2（或重启应用）之后，②的修复才会在当前应用里生效**；①的自动安装也只有新应用会做。
- 当前运行时文件里的三个补丁是**本会话手工打上去的**（`_selftest/agent-role/apply-patch.js`）：
  插件列表 description、explorer 窗口可见、以及更早的隐藏控制台。dsh 升级会覆盖 node_modules，
  之后靠新应用启动时自动重打。
- `~/.dsh` 现状：`profiles/{web,headless,sdk}/node_modules/agent-role` 是指向仓库的 junction
  （手工装的），`cordis.patch.yml` 里有带 `description` 的插件行。
  新应用的安装步骤会把这些 junction 当普通目录写 —— 因为内容逐字节相同，实际是 no-op。
- 插件的**设置页（设置 → 角色）在真实浏览器里仍未被人点过**（本会话没有可交互图形桌面）。
  可用 `_selftest/agent-role/client-harness.js`（迷你 React 跑真实 bundle）覆盖逻辑，
  但真机点击需要用户确认。

## 七、本会话改动的文件

| 文件 | 改动 |
| --- | --- |
| `package.json` | 版本 0.1.1 → 0.1.2（中途按 0.1.3 打过一次，按用户要求改回 **0.1.2**）；`dist` 指向 `scripts/dist.js` |
| `scripts/dist.js` | 新增：打包入口（旧 Node 自动切 Node 24、绕过 CLI、强制 `ELECTRON_NO_ASAR=1`）；**打包前清理 release 里的旧产物与 `win-unpacked`** |
| `scripts/dist.js` | 新增：打包入口（旧 Node 自动切 Node 24、绕过 CLI、强制 `ELECTRON_NO_ASAR=1`） |
| `electron-builder.yml` | `files` 加 `plugins/**/*`（排除插件自己的 node_modules） |
| `src/plugin-install.js` | 新增：把随包插件装进 DSH_HOME（复制 + 补 patch 行，幂等） |
| `src/runtime-patch.js` | 新增 `ensurePluginListDescription`（插件列表 description）与 `ensureNativeOpenVisible`（explorer 窗口） |
| `src/main.js` | 启动时调用上面两个补丁 + `ensureAgentRolePlugin` |
| `plugins/dsh-plugin-agent-role/**` | 客户端半边改用插件级 inject + 设置共享镜像；修 hooks 顺序 bug；schemastery 改可选 |
| `README.md` / `PROGRESS.md` | 安装包版本、打包说明、逐轮记录 |
| `_selftest/**` | 各类测试台与探针（gitignore，可重跑） |

# DSH Desktop 交付说明

**交付物**：`release\DSH-Desktop-Setup-0.1.0-x64.exe`（96.7 MB，NSIS 安装包）
**状态**：已完成并验证通过。

## 它做了什么

装到一台全新 Windows 电脑上，双击就能用 DeepSeek Harness：

1. 首次启动自动准备运行环境 —— 用应用自带的 Node（Electron 内嵌）→ 从 npmmirror
   下载 npm → 安装 `@deepseek-ai/dsh` 到 `%APPDATA%\dsh-desktop\runtime`
2. 拉起本地 `dsh web` 服务，把官方 Web UI 装进原生窗口；启动全程有百分比进度条
3. **每次启动主动检查 dsh 新版本，有更新直接装上再启动**；运行期间每 30 分钟再检查一次，
   那时发现新版本会先问一句（避免打断进行中的会话）
4. 关窗口默认最小化到托盘（服务继续跑，双击托盘唤回），可改为退出应用
5. 桌面 / 开始菜单快捷方式、窗口与任务栏图标均为上传的 logo

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
cd C:\Users\80441\Desktop\工具\dsh-desktop
npm run check        # 纯逻辑校验（版本比较、就绪行解析）
npm run self-test    # 真实端到端：装运行时 → 启动 → 鉴权握手 → 停止
npm run icon         # 由 assets\logo.png 生成 build\icon.ico 与 assets\icon-32.png
npm run electron     # 下载解压 Electron 到 build/electron-dist
npm run dist         # 打 NSIS 安装包
```

> 打包前先关掉正在运行的「DSH 桌面端」：它会锁住 `release\win-unpacked` 里的 DLL，
> 导致构建报 `EPERM: unlink ...`。`build\electron-dist\` 是打包必需，别删。

更多细节见 `README.md`。

# DSH 桌面端（DSH Desktop）

Windows 桌面客户端：**装到一台全新电脑上，双击就能用上 DeepSeek Harness（dsh）** —— 不需要事先
安装 Node、npm 或命令行版 dsh。界面就是 dsh 官方的 Web UI，客户端只负责把本地服务拉起来、
托管在一个原生窗口里。

- 首次启动自动准备运行环境（内置 Node → 自动获取 npm → 自动安装 `@deepseek-ai/dsh`），之后启动不依赖网络
- 自动检查并升级 dsh 运行时（走国内可直连的 npmmirror 镜像）
- 托盘常驻、查看账户余额、日志可视化、关窗口默认最小化到托盘

## 安装

1. 到 [Releases](https://github.com/Gongjingyao/dsh-desktop/releases) 下载最新的
   `DSH-Desktop-Setup-<版本>-x64.exe`
2. 双击安装，可自选安装位置（只装给当前用户，不需要管理员权限）
3. 装完自动创建桌面与开始菜单快捷方式「DSH 桌面端」

升级直接双击新包覆盖安装（同一 appId，安装器会先静默卸载旧程序文件）：`%APPDATA%\dsh-desktop`
与 `~/.dsh` 都会保留，已装好的 dsh 运行时不用重新下载。

> 升级前请先从托盘菜单**真正退出**客户端 —— 关窗口只是最小化到托盘、进程还在，exe 被占用会让升级失败。

安装包本身不联网、不带运行时；**运行环境在第一次启动时准备**，全新电脑约 80 秒可用。
装过之后再启动，客户端自己的开销只有几百毫秒，剩下的都是 dsh 自身启动，日志里会把这两段分开记。

## 用法要点

| 项目 | 说明 |
| --- | --- |
| 关窗口 | 默认最小化到托盘（首次隐藏会弹一次系统通知）。改成退出：托盘右键 →「关闭窗口时」→「退出应用」，或引导页的「关闭窗口时…」按钮（可勾选不再询问） |
| 托盘菜单 | 打开主界面 / 重新启动 dsh 服务 / 检查更新 / 查看余额 / 打开日志目录 / 退出 |
| 登录凭据 | `DSH_HOME` 默认 `~/.dsh`，与命令行版 dsh 共用会话、配置与凭据；要隔离就把 `DSH_DESKTOP_HOME` 指到别的目录 |
| 查看余额 | 菜单「维护 → 查看余额…」或托盘「查看余额…」，直接查 DeepSeek 账户余额。密钥沿用 dsh 那套优先级：`DEEPSEEK_API_KEY` → `~/.dsh/.credentials.yaml` → `~/.dsh/.env`，只用于这次请求 |
| 更新 | dsh 运行时在界面就绪后后台检查，发现新版先问「立即更新 / 稍后」再动手；客户端自身的更新源用 `DSH_DESKTOP_UPDATE_FEED` 指定（不配就只检查 dsh） |

## 文件位置

| 内容 | 路径 |
| --- | --- |
| 程序安装目录 | 用户自选，默认 `%LOCALAPPDATA%\Programs\dsh-desktop` |
| 数据目录 | `%APPDATA%\dsh-desktop`（日志在其 `logs`） |
| dsh 运行时 | `%APPDATA%\dsh-desktop\runtime` |
| 应用设置 | `%APPDATA%\dsh-desktop\settings.json`（关闭行为、镜像、更新检查间隔） |
| DSH_HOME | `~/.dsh`（可用 `DSH_DESKTOP_HOME` 覆盖） |
| 命令行入口 | `%APPDATA%\dsh-desktop\dsh.cmd` |

卸载**不会**删除数据目录；想彻底清理，手动删掉 `%APPDATA%\dsh-desktop`。

## 给开发者

```powershell
npm install           # 只装 electron 与 electron-builder
npm run electron      # 下载并解压 Electron 到 build/electron-dist
npm run icon          # 由 assets/logo.png 生成 build/icon.ico
npm start             # 开发态启动

npm run check         # 纯逻辑校验：版本比较、就绪行解析、余额凭据与格式化（不起进程）
npm run check-exit    # 退出路径校检：真起 dsh 再停掉，断言秒级停止
npm run check-balance # 余额真机校验：用本机凭据真的查一次 /user/balance
npm run self-test     # 端到端：装运行时 → 启动 dsh → 鉴权握手 → 停止
npm run dist          # 打 NSIS 安装包到 release/（打包前自动清理旧产物）
```

目录结构：

```
src/       主进程：main（窗口/菜单/启动状态机）、dsh（托管子进程）、runtime（查找安装升级）、
           runtime-patch（给运行时打补丁）、updater、balance、config、preload、ui/（引导页）
scripts/   fetch-electron、make-icon、各类 check 脚本、dist（打包入口）
plugins/   随包发布的 dsh 插件（会话角色 agent-role）
```

## 其它文档

- [`PROGRESS.md`](PROGRESS.md)：逐轮交付记录、验证方式，以及**实现备忘**（开发时要注意的坑、
  托盘与退出的实现细节、Web 鉴权握手、启动各阶段耗时）
- [`HANDOFF.md`](HANDOFF.md)：最近一轮的交接说明（打包命令与环境上的坑）

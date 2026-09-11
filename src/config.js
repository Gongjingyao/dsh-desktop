'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** npm 包名与默认镜像（国内可直连）。 */
const DSH_PACKAGE = '@deepseek-ai/dsh';

/** 关闭主窗口时的行为：最小化到托盘，或直接退出应用。 */
const CLOSE_ACTIONS = ['tray', 'quit'];

const REGISTRY_CANDIDATES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
];

/**
 * 应用自身的版本只用于导航判别（例如区分 `app.isPackaged`），
 * 真正要展示的版本号来自运行时安装出来的 dsh 包。
 */
function appVersion() {
  return app.getVersion();
}

/** 所有可写状态放在用户目录，卸载应用时保留会话与配置。 */
function dataRoot() {
  return path.join(app.getPath('appData'), 'dsh-desktop');
}

/**
 * 用来跑 dsh 的 Node 可执行文件。
 *
 * 打包后就是应用自带的 `DSH 桌面端.exe`（ELECTRON_RUN_AS_NODE 模式下等价于 node），
 * 全新电脑上不依赖任何已安装的 Node。
 * 开发态下 Electron 可能不在 process.execPath 上（例如用 build/electron-dist 手动解压的），
 * 因此按候选位置逐个找，找不到就明确报错而不是悄悄跑错。
 */
function resolveNodeExecutable() {
  if (process.env.DSH_DESKTOP_NODE_EXECUTABLE) return process.env.DSH_DESKTOP_NODE_EXECUTABLE;

  const candidates = [];
  if (process.execPath && fs.existsSync(process.execPath)) candidates.push(process.execPath);
  if (!app.isPackaged) {
    // 开发态的两种常见形态：npm 装的 electron，或 scripts/fetch-electron.js 解压出来的。
    candidates.push(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'));
    candidates.push(path.join(app.getAppPath(), 'build', 'electron-dist', 'electron.exe'));
    candidates.push(path.join(app.getAppPath(), '..', 'build', 'electron-dist', 'electron.exe'));
  }
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (found === undefined) {
    throw new Error(`找不到可用的 Node 运行时，已尝试：\n${candidates.join('\n')}`);
  }
  return found;
}

/**
 * DSH_HOME 默认沿用 `~/.dsh`：与命令行版 dsh 共用同一份会话、配置与凭据，
 * 用户不必在桌面端重新登录。全新电脑上该目录不存在，会在首次启动时自动创建。
 * 需要隔离时用 DSH_DESKTOP_HOME 覆盖。
 */
function dshHome() {
  if (process.env.DSH_DESKTOP_HOME) return process.env.DSH_DESKTOP_HOME;
  return path.join(os.homedir(), '.dsh');
}

/** dsh CLI 自身的安装目录（npm --prefix 的目标）。 */
function runtimeRoot() {
  return path.join(dataRoot(), 'runtime');
}

/** 运行时包目录。 */
function runtimePackageDir() {
  return path.join(runtimeRoot(), 'node_modules', ...DSH_PACKAGE.split('/'));
}

/** 运行时入口脚本。 */
function runtimeEntry() {
  return path.join(runtimePackageDir(), 'lib', 'bin.js');
}

function logsDir() {
  return path.join(dataRoot(), 'logs');
}

function settingsPath() {
  return path.join(dataRoot(), 'settings.json');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * spawn 子进程时统一使用的环境。
 * PATH 里优先放入我们自己的 Node 目录，全新电脑上没有 node/npm 时也能兜住；
 * npm 相关变量指向应用数据目录，不污染用户已有的 npm 配置。
 */
function childEnv(extra) {
  const root = dataRoot();
  const cacheDir = ensureDir(path.join(root, 'npm-cache'));
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'Path';
  const sep = path.delimiter;
  const nodeDir = path.dirname(resolveNodeExecutable());
  const pathValue = [nodeDir, process.env[pathKey] || ''].filter(Boolean).join(sep);

  return {
    ...process.env,
    [pathKey]: pathValue,
    npm_config_registry: REGISTRY_CANDIDATES[0],
    npm_config_cache: cacheDir,
    npm_config_audit: 'false',
    npm_config_fund: 'false',
    npm_config_update_notifier: 'false',
    npm_config_prefix: runtimeRoot(),
    npm_config_userconfig: path.join(root, 'npmrc'),
    // Electron 的可执行文件本身就是一个 Node：不设这个开关会把 dsh 当成 Electron 应用启动。
    ELECTRON_RUN_AS_NODE: '1',
    // 打包后的可执行文件是 GUI 子系统程序，禁止它去附加父进程控制台。
    ELECTRON_NO_ATTACH_CONSOLE: '1',
    ...extra,
  };
}

/**
 * 读取应用的本地设置（镜像地址等）。缺失时返回默认值，损坏时回退默认值而不是崩溃。
 */
function readSettings() {
  const defaults = {
    registry: REGISTRY_CANDIDATES[0],
    autoUpdateDsh: true,
    updateCheckIntervalMinutes: 30,
    /** 默认最小化到托盘，避免误点关闭就把服务停掉。 */
    closeAction: 'tray',
  };
  try {
    // 一定要去掉 BOM：外部工具（含 PowerShell）写出的 JSON 常带 BOM，
    // 而 JSON.parse 遇到 BOM 会直接抛错，导致整份设置悄悄回退成默认值。
    const raw = fs.readFileSync(settingsPath(), 'utf8').replace(/^\uFEFF/, '');
    const parsed = { ...defaults, ...JSON.parse(raw) };
    if (!CLOSE_ACTIONS.includes(parsed.closeAction)) parsed.closeAction = defaults.closeAction;
    return parsed;
  } catch {
    return defaults;
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  ensureDir(dataRoot());
  fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

/** 切换关闭窗口的行为，返回切换后的值。 */
function setCloseAction(action) {
  if (!CLOSE_ACTIONS.includes(action)) throw new Error(`未知的关闭行为：${action}`);
  writeSettings({ closeAction: action });
  return action;
}

/** 写一份 npmrc，让运行时的 npm 装包默认走用户选定的镜像。 */
function syncNpmrc(registry) {
  const lines = [
    `registry=${registry}`,
    `cache=${path.join(dataRoot(), 'npm-cache')}`,
    'audit=false',
    'fund=false',
    'update-notifier=false',
    '',
  ];
  ensureDir(dataRoot());
  fs.writeFileSync(path.join(dataRoot(), 'npmrc'), lines.join(os.EOL), 'utf8');
}

module.exports = {
  DSH_PACKAGE,
  REGISTRY_CANDIDATES,
  CLOSE_ACTIONS,
  appVersion,
  dataRoot,
  dshHome,
  runtimeRoot,
  runtimePackageDir,
  runtimeEntry,
  logsDir,
  settingsPath,
  ensureDir,
  childEnv,
  readSettings,
  writeSettings,
  setCloseAction,
  syncNpmrc,
  resolveNodeExecutable,
};

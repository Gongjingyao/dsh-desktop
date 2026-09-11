'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// userData 必须早于 app ready 设置，否则日志与缓存会落到默认目录。
app.setName('DSH Desktop');
app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop'));

const config = require('./config');
const runtime = require('./runtime');
const updater = require('./updater');
const { DshProcess, writeCliLauncher } = require('./dsh');

const ICON_PATH = path.join(__dirname, '..', 'build', 'icon.ico');
// 托盘图标走 assets：只有 assets/ 会进 app.asar，build/ 是构建资源目录。
const TRAY_ICON_PATH = path.join(__dirname, '..', 'assets', 'icon-32.png');
const BOOT_PAGE = path.join(__dirname, 'ui', 'index.html');

/** 启动状态机。渲染进程只消费状态，不参与决策。 */
const boot = {
  status: 'idle', // idle | checking | installing | starting | ready | failed
  message: '',
  detail: '',
  percent: 0,
  installedVersion: null,
  latestVersion: null,
  error: null,
};

let mainWindow = null;
let tray = null;
let dsh = null;
let updateTimer = null;
let updateInFlight = false;
/** 用户明确要求退出时置为 true，用来区分「关窗口」和「真退出」。 */
let quitting = false;

let appLogStream = null;

/** 取主进程日志的写入流（懒打开）。GUI 进程没有可读的 stdout，排查问题全靠这个文件。 */
function appLogStreamRef() {
  if (appLogStream !== null) return appLogStream;
  try {
    const dir = config.ensureDir(config.logsDir());
    appLogStream = fs.createWriteStream(path.join(dir, 'app.log'), { flags: 'a' });
  } catch {
    appLogStream = null;
  }
  return appLogStream;
}

function log(line) {
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const text = `[${stamp}] ${line}`;
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('boot:log', text);
  }
  appLogStreamRef()?.write(`${text}\n`);
}

function pushState(patch) {
  Object.assign(boot, patch);
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('boot:state', { ...boot, appVersion: config.appVersion() });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: '#e8f1ff',
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (event) => {
    // 「最小化到托盘」时关窗口只是藏起来：服务继续跑，托盘图标还能唤回来。
    if (quitting || config.readSettings().closeAction !== 'tray') return;
    event.preventDefault();
    log(`关闭窗口：按设置为「最小化到托盘」，窗口隐藏，服务继续运行。`);
    mainWindow.hide();
    notifyHiddenToTray();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // dsh 的 Web UI 里的外链走系统浏览器，避免在应用窗口里打开任意站点。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url) && !url.startsWith('http://127.0.0.1')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  return mainWindow.loadFile(BOOT_PAGE);
}

/** 打开 dsh 的 Web UI；失败时退回引导页并提示。 */
async function showWebUi(url) {
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  try {
    await mainWindow.loadURL(url);
  } catch (error) {
    log(`加载 Web UI 失败：${error.message}`);
    await mainWindow.loadFile(BOOT_PAGE);
    pushState({ status: 'failed', message: 'Web UI 加载失败', error: error.message });
  }
}

/** 把窗口显示出来（从托盘、从最小化、或从隐藏状态）。 */
function showMainWindow() {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

let trayHintShown = false;

/** 首次隐藏到托盘时提示一次，否则用户会以为应用被关掉了。 */
function notifyHiddenToTray() {
  if (trayHintShown) return;
  trayHintShown = true;
  try {
    if (Notification.isSupported()) {
      const hint = new Notification({
        title: 'DSH 桌面端仍在后台运行',
        body: '已最小化到托盘，双击托盘图标可以重新打开。',
        icon: fs.existsSync(TRAY_ICON_PATH) ? TRAY_ICON_PATH : undefined,
      });
      hint.on('click', () => showMainWindow());
      hint.show();
    }
  } catch (error) {
    log(`托盘提示发送失败：${error.message}`);
  }
  tray?.displayBalloon?.({ title: 'DSH 桌面端', content: '已最小化到托盘' });
}

/** 让用户选择关闭窗口的行为，并记住选择。 */
async function chooseCloseAction() {
  const current = config.readSettings().closeAction;
  const { response, checkboxChecked } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    title: '关闭窗口时',
    message: '关闭主窗口时希望怎么处理？',
    detail: '最小化到托盘：服务继续在后台运行，双击托盘图标可以唤回窗口。\n退出应用：同时停止本地 dsh 服务。',
    buttons: ['最小化到托盘', '退出应用', '取消'],
    defaultId: current === 'tray' ? 0 : 1,
    cancelId: 2,
    checkboxLabel: '记住我的选择，不再询问',
    checkboxChecked: true,
  });
  if (response > 1) return current;
  const action = response === 0 ? 'tray' : 'quit';
  if (checkboxChecked) {
    config.setCloseAction(action);
    log(`关闭窗口行为已设为「${action === 'tray' ? '最小化到托盘' : '退出应用'}」`);
  } else {
    log('未勾选记住选择，本次仅临时生效');
  }
  return action;
}

/** 创建/刷新托盘。菜单里的「关闭窗口时」会勾选当前设置。 */
function createTray() {
  if (tray !== null) return;
  if (!fs.existsSync(TRAY_ICON_PATH)) {
    log(`托盘图标缺失，跳过创建：${TRAY_ICON_PATH}`);
    return;
  }
  try {
    tray = new Tray(nativeImage.createFromPath(TRAY_ICON_PATH));
  } catch (error) {
    log(`托盘创建失败：${error.message}`);
    tray = null;
    return;
  }

  const closeAction = config.readSettings().closeAction;
  tray.setToolTip(`DSH 桌面端 · dsh ${runtime.installedVersion() ?? '未安装'}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主界面', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '重新启动 dsh 服务',
        click: () => {
          showMainWindow();
          void restartService();
        },
      },
      { label: '检查更新…', click: () => void checkUpdatesManually() },
      { type: 'separator' },
      {
        label: '关闭窗口时',
        submenu: [
          {
            label: '最小化到托盘',
            type: 'radio',
            checked: closeAction === 'tray',
            click: () => config.setCloseAction('tray'),
          },
          {
            label: '退出应用',
            type: 'radio',
            checked: closeAction === 'quit',
            click: () => config.setCloseAction('quit'),
          },
        ],
      },
      { label: '打开日志目录', click: () => void shell.openPath(config.ensureDir(config.logsDir())) },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]),
  );
  // 单击唤回窗口：Windows 上这是最符合直觉的托盘交互。
  tray.on('click', () => showMainWindow());
}

function refreshTray() {
  if (tray === null) return;
  tray.destroy();
  tray = null;
  createTray();
}

/** 真正退出应用。窗口的 close 处理会看这个标记决定是隐藏还是放行。 */
function quitApp() {
  quitting = true;
  app.quit();
}

/** 重启本地 dsh 服务，并把界面切回它。 */
async function restartService() {
  if (dsh === null) return;
  pushState({ status: 'starting', message: '正在重启 dsh 服务…', percent: 80 });
  const url = await dsh.restart();
  if (url !== null) await showWebUi(url);
}

/** 等待 dsh 打印出可访问的 URL，或提前失败。 */
function waitForReady(instance) {
  return new Promise((resolve, reject) => {
    const onReady = (url) => {
      cleanup();
      resolve(url);
    };
    const onExit = ({ code }) => {
      cleanup();
      reject(new Error(`dsh 进程提前退出（退出码 ${code}）`));
    };
    const cleanup = () => {
      instance.off('ready', onReady);
      instance.off('exit', onExit);
    };
    instance.once('ready', onReady);
    instance.once('exit', onExit);
  });
}

/**
 * 完整启动流程：检查运行环境 → 有必要就装/更新 dsh → 启动服务 → 打开 Web UI。
 *
 * 全程用一个百分比表达进度：每 2% 推一次状态，避免高频刷新渲染进程。
 * @param {object} [options]
 * @param {boolean} [options.autoUpdate] - 是否在启动阶段直接安装发现的新版本
 */
async function bootSequence(options = {}) {
  const { autoUpdate = false } = options;
  if (updateInFlight) return;

  let lastReported = -1;
  const report = (percent, message, patch = {}) => {
    const next = Math.max(boot.percent, Math.min(100, Math.round(percent)));
    if (next === lastReported && message === undefined) return;
    lastReported = next;
    pushState({ percent: next, ...(message === undefined ? {} : { message }), ...patch });
  };

  updateInFlight = true;
  boot.percent = 0;
  lastReported = -1;
  report(2, '正在检查运行环境…', { status: 'checking', error: null, detail: '' });

  log(`数据目录：${config.dataRoot()}`);
  log(`DSH_HOME：${config.dshHome()}`);
  log(`Node 运行时：${config.resolveNodeExecutable()}`);

  try {
    const check = await updater.checkRuntime();
    report(8, undefined, { installedVersion: check.current, latestVersion: check.latest });

    if (check.current === null) {
      log(`未检测到 dsh，开始安装 ${check.latest}（镜像 ${check.registry}）`);
      report(10, `正在安装 dsh ${check.latest}…`, { status: 'installing' });
      const version = await runtime.installDsh({
        onLine: log,
        onProgress: (percent) => report(10 + percent * 0.68, undefined, { status: 'installing' }),
      });
      report(78, undefined, { installedVersion: version, latestVersion: version });
    } else if (runtime.compareVersions(check.latest, check.current) > 0) {
      log(`发现新版 dsh：${check.current} → ${check.latest}`);
      if (autoUpdate) {
        report(10, `正在更新到 dsh ${check.latest}…`, { status: 'installing' });
        const version = await runtime.installDsh({
          onLine: log,
          onProgress: (percent) => report(10 + percent * 0.68, undefined, { status: 'installing' }),
        });
        log(`已更新到 dsh ${version}`);
        report(78, undefined, { installedVersion: version, latestVersion: version });
      } else {
        log(`本次按原版本 ${check.current} 启动`);
        report(30);
      }
    } else {
      log(`dsh ${check.current} 已是最新版本`);
    }

    report(80, '正在启动 dsh 服务…', { status: 'starting', detail: '首次启动需要初始化会话目录，请稍候。' });
    dsh = new DshProcess();
    dsh.on('progress', (percent) => report(percent));
    dsh.on('exit', ({ stopping }) => {
      if (!stopping) log('dsh 服务已退出');
    });

    const ready = waitForReady(dsh);
    void dsh.start();
    const url = await ready;
    if (url === null) throw new Error('未能获取 Web UI 地址');

    log(`dsh 已就绪：${url}`);
    report(100, '正在打开界面…', { status: 'ready' });
    await showWebUi(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`启动失败：${message}`);
    pushState({ status: 'failed', message: '启动失败', error: message });
  } finally {
    updateInFlight = false;
  }
}

/** 停掉本地服务、装最新版 dsh、再走一遍启动流程（期间自动装更新）。 */
async function updateRuntime() {
  if (updateInFlight) return;
  if (dsh !== null) {
    await dsh.stop();
    dsh = null;
  }
  boot.percent = 0;
  await bootSequence({ autoUpdate: true });
}

/** 手动触发一次检查；发现新版本时问一句再更新。 */
async function checkUpdatesManually() {
  if (updateInFlight) return;
  try {
    const result = await updater.checkAll(log);
    if (result.runtime?.updateAvailable && result.runtime.current !== null) {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'info',
        buttons: ['立即更新', '稍后'],
        defaultId: 0,
        cancelId: 1,
        title: 'dsh 有新版本',
        message: `dsh ${result.runtime.latest} 已发布`,
        detail: `当前版本 ${result.runtime.current}。更新会重启本地服务，进行中的会话可能中断。`,
      });
      if (response === 0) await updateRuntime();
      return;
    }
    const current = result.runtime?.current ?? runtime.installedVersion();
    void dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '检查更新',
      message: current === null ? '尚未安装 dsh 运行时' : `dsh ${current} 已是最新版本`,
      detail: result.errors.length > 0 ? result.errors.join('\n') : '没有可用的更新。',
    });
  } catch (error) {
    log(`检查更新失败：${error.message}`);
    void dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '检查更新失败',
      message: '无法获取版本信息',
      detail: error.message,
    });
  }
}

/** 后台周期性检查：只提示，不擅自重启服务打断用户。 */
async function pollUpdates() {
  if (updateInFlight) return;
  try {
    const result = await updater.checkAll(log);
    if (result.runtime?.updateAvailable && result.runtime.current !== null) {
      const changed = config.readSettings().lastNotifiedVersion !== result.runtime.latest;
      if (changed) {
        config.writeSettings({ lastNotifiedVersion: result.runtime.latest });
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          buttons: ['立即更新', '稍后'],
          defaultId: 0,
          cancelId: 1,
          title: 'dsh 有新版本',
          message: `dsh ${result.runtime.latest} 已发布`,
          detail: `当前版本 ${result.runtime.current}。更新会重启本地服务，进行中的会话可能中断。`,
        });
        if (response === 0) void updateRuntime();
      }
    }
    if (result.app?.updateAvailable) {
      const changed = config.readSettings().lastNotifiedAppVersion !== result.app.latest;
      if (changed) {
        config.writeSettings({ lastNotifiedAppVersion: result.app.latest });
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'info',
          buttons: ['打开发布页', '稍后'],
          defaultId: 0,
          cancelId: 1,
          title: '客户端有新版本',
          message: `DSH Desktop ${result.app.latest} 已发布`,
          detail: `当前版本 ${result.app.current}。`,
        });
        if (response === 0 && updater.APP_UPDATE_FEED !== '') shell.openExternal(updater.APP_UPDATE_FEED);
      }
    }
  } catch (error) {
    log(`自动检查更新失败：${error.message}`);
  }
}

function scheduleUpdateChecks() {
  const { updateCheckIntervalMinutes } = config.readSettings();
  const interval = Math.max(5, Number(updateCheckIntervalMinutes) || 30) * 60 * 1000;
  clearInterval(updateTimer);
  updateTimer = setInterval(() => void pollUpdates(), interval);
}

function registerIpc() {
  ipcMain.handle('boot:action', async (_event, name) => {
    switch (name) {
      case 'retry':
        void bootSequence({ autoUpdate: true });
        return true;
      case 'update':
        void updateRuntime();
        return true;
      case 'skip': {
        // 用户不想现在更新：只把当前进度走完，版本留着下次启动再说。
        log('已跳过本次更新，先按当前版本启动');
        void bootSequence();
        return true;
      }
      case 'open-logs':
        await shell.openPath(config.ensureDir(config.logsDir()));
        return true;
      case 'open-in-browser':
        if (dsh?.webUrl) await shell.openExternal(dsh.webUrl);
        return true;
      case 'choose-close-action':
        await chooseCloseAction();
        refreshTray();
        return true;
      default:
        return false;
    }
  });

  ipcMain.handle('boot:info', () => ({
    appVersion: config.appVersion(),
    dshVersion: runtime.installedVersion(),
    dataRoot: config.dataRoot(),
    dshHome: config.dshHome(),
    registry: config.readSettings().registry,
    closeAction: config.readSettings().closeAction,
    feed: updater.APP_UPDATE_FEED,
    electron: process.versions.electron,
    node: process.versions.node,
  }));
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '在浏览器中打开界面',
          click: () => {
            if (dsh?.webUrl) void shell.openExternal(dsh.webUrl);
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    // 保留编辑菜单：Web UI 的复制粘贴依赖这些加速键。
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入界面' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'toggleDevTools', label: '开发者工具' },
      ],
    },
    {
      label: '维护',
      submenu: [
        { label: '检查更新…', click: () => void checkUpdatesManually() },
        { label: '重新启动 dsh 服务', click: () => void restartService() },
        { type: 'separator' },
        {
          label: '关闭窗口时的行为…',
          click: () => {
            void chooseCloseAction().then(() => refreshTray());
          },
        },
        {
          label: '设置开机自启动',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({ openAtLogin: item.checked, args: [] });
            log(`开机自启动已${item.checked ? '开启' : '关闭'}`);
          },
        },
        { type: 'separator' },
        { label: '打开日志目录', click: () => void shell.openPath(config.ensureDir(config.logsDir())) },
        {
          label: '打开数据目录',
          click: () => void shell.openPath(config.ensureDir(config.dataRoot())),
        },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 DSH Desktop',
          click: () => {
            const cliLauncher = writeCliLauncher();
            void dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于 DSH Desktop',
              message: `DSH Desktop ${config.appVersion()}`,
              detail: [
                `dsh 运行时：${runtime.installedVersion() ?? '未安装'}`,
                `数据目录：${config.dataRoot()}`,
                `DSH_HOME：${config.dshHome()}`,
                `命令行入口：${cliLauncher}`,
              ].join('\n'),
            });
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 托盘模式下再次启动应用，直接把已有窗口唤到前面。
    showMainWindow();
  });

  app.whenReady().then(async () => {
    config.ensureDir(config.dataRoot());
    config.ensureDir(config.logsDir());
    // 把生效的设置打出来：排查"设置没生效"这类问题时，第一眼就能确认读的是哪个文件。
    const settings = config.readSettings();
    log(`设置文件：${config.settingsPath()}（存在：${fs.existsSync(config.settingsPath())}）`);
    log(`关闭窗口行为：${settings.closeAction}`);
    registerIpc();
    buildMenu();
    createTray();
    writeCliLauncher();
    await createWindow();
    scheduleUpdateChecks();
    // 启动阶段主动检查：有新版本就直接装上，再启动服务。
    void bootSequence({ autoUpdate: true });
  });

  app.on('window-all-closed', () => {
    // 最小化到托盘时窗口只是隐藏，不会走到这里；真关闭窗口才应该退出。
    if (config.readSettings().closeAction === 'tray') return;
    quitApp();
  });

  app.on('before-quit', (event) => {
    clearInterval(updateTimer);
    quitting = true;
    if (dsh === null) return;
    event.preventDefault();
    // 退出时收掉 dsh 子进程，避免留下孤儿服务占用端口与句柄。
    // 先停进程再释放句柄，最后无条件放行退出。
    const pending = dsh;
    dsh = null;
    void pending
      .stop()
      .catch(() => {})
      .finally(() => {
        pending.dispose();
        app.quit();
      });
  });
}

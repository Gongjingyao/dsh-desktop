'use strict';

const { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// userData 必须早于 app ready 设置，否则日志与缓存会落到默认目录。
app.setName('DSH Desktop');
app.setPath('userData', path.join(app.getPath('appData'), 'dsh-desktop'));

const balance = require('./balance');
const config = require('./config');
const runtime = require('./runtime');
const runtimePatch = require('./runtime-patch');
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
/** 退出收尾（停子进程）进行中：期间的重复退出请求一律挡回去。 */
let shutdownInFlight = false;
/** 余额查询进行中：连点菜单不该并发发多次请求。 */
let balanceInFlight = false;

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
  // 引导页脚本挂上监听之前推过去的状态会丢（启动现在和窗口加载并行，这个窗口期
  // 是真实存在的），所以每次加载完成都补推一次当前状态。
  mainWindow.webContents.on('did-finish-load', () => pushState({}));
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
  // 只留一个提醒通道。原先这里还调了 tray.displayBalloon：老的托盘气泡与下面这条
  // 系统通知会同时弹出来（用户看到"两次提醒"），而且展开任务栏折叠区时 Windows
  // 还会把气泡重播一遍。要提示就用系统通知，它还能点开窗口。
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

/**
 * 弹出原生对话框。窗口可见时挂在窗口上（居中且模态），窗口在托盘里藏着时用独立对话框——
 * 挂在隐藏窗口上的消息框用户根本看不到。
 */
function messageBox(options) {
  const visible = mainWindow !== null && !mainWindow.isDestroyed() && mainWindow.isVisible();
  return visible ? dialog.showMessageBox(mainWindow, options) : dialog.showMessageBox(options);
}

/** 查一次 DeepSeek 账户余额并展示；用户点「刷新」就再查一次。 */
async function checkAccountBalance() {
  if (balanceInFlight) return;
  balanceInFlight = true;
  try {
    for (;;) {
      let result;
      try {
        result = await balance.fetchBalance();
      } catch (error) {
        await showBalanceError(error);
        return;
      }
      // 日志只记"查成功了"和币种：金额与密钥都不落盘。
      const currencies = result.balance.infos.map((info) => info.currency).filter(Boolean).join('/');
      log(`余额查询成功：${balance.balanceSummary(result)}（${currencies || '无明细'}）`);
      const { response } = await messageBox({
        type: 'info',
        title: '账户余额',
        message: balance.balanceSummary(result),
        detail: balance.balanceDetail(result),
        buttons: ['刷新', '关闭'],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      });
      if (response !== 0) return;
    }
  } finally {
    balanceInFlight = false;
  }
}

/** 余额查不出来时的提示：没配密钥和"查失败"是两种事，分开说。 */
async function showBalanceError(error) {
  const message = error instanceof Error ? error.message : String(error);
  log(`余额查询失败：${message}`);
  const credentialsPath = path.join(config.dshHome(), '.credentials.yaml');

  if (error?.code === 'NO_KEY') {
    const { response } = await messageBox({
      type: 'info',
      title: '账户余额',
      message: '还没有配置 DeepSeek API Key',
      detail: [
        '客户端按这个顺序找密钥：',
        '1. 启动环境变量 DEEPSEEK_API_KEY',
        `2. 凭据文件 ${credentialsPath}`,
        `3. 环境文件 ${path.join(config.dshHome(), '.env')}`,
        '',
        '在 dsh 界面里「设置 → 模型」填一次 API Key，就会写进第 2 个文件。',
      ].join('\n'),
      buttons: ['打开凭据目录', '关闭'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await shell.openPath(config.ensureDir(config.dshHome()));
    return;
  }

  await messageBox({
    type: 'warning',
    title: '余额查询失败',
    message: '没能查到账户余额',
    detail: `${message}\n\n查询地址：${balance.baseUrl()}${balance.BALANCE_PATH}`,
    buttons: ['关闭'],
    defaultId: 0,
    noLink: true,
  });
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
      { label: '查看余额…', click: () => void checkAccountBalance() },
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

/**
 * 真正退出应用。窗口的 close 处理会看 quitting 决定是隐藏还是放行。
 *
 * 这里必须挡住重复调用：收尾期间（停子进程要几百毫秒）再点一次"退出"不应该
 * 被当成一次全新的退出流程重来。
 */
function quitApp() {
  if (quitting) return;
  quitting = true;
  log('收到退出请求，正在退出…');
  app.quit();
}

/** 退出时先收起窗口与托盘图标：让"点了退出"马上有视觉反馈，服务在原地收尾。 */
function hideForQuit() {
  if (mainWindow !== null && !mainWindow.isDestroyed()) mainWindow.hide();
  if (tray === null) return;
  const pending = tray;
  tray = null;
  // 退出可能是从托盘菜单本身的点击回调里发起的，销毁 Tray 要离开这个回调栈，
  // 否则 Windows 上会留下一个点不动的"幽灵图标"。
  setImmediate(() => {
    try {
      pending.destroy();
    } catch {
      // 已经销毁过就忽略。
    }
  });
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
 * 完整启动流程：确定本地运行时 →（必要时）联网安装/更新 → 启动服务 → 打开 Web UI。
 *
 * 核心约束：**启动路径不依赖网络**。本地已经装好 dsh 时直接起服务，版本检查挪到
 * 界面出来之后在后台做。之前每次启动都要先联网查最新版（断网时两个镜像各等 15s），
 * 查到新版本还要先跑完 npm 安装才肯起服务——用户只能对着进度条干等，断网时甚至直接
 * 报"启动失败"，明明本地就有一份能用的运行时。
 *
 * 全程用一个百分比表达进度：每 2% 推一次状态，避免高频刷新渲染进程。
 * @param {object} [options]
 * @param {boolean} [options.install] - 先联网装/更新到最新版再启动（用户点了「立即更新」）
 * @param {boolean} [options.checkAfterReady] - 界面就绪后在后台查新版本，有新版本问一句
 */
async function bootSequence(options = {}) {
  const { install = false, checkAfterReady = false } = options;
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
  const startedAt = Date.now();
  report(2, '正在准备运行环境…', { status: 'checking', error: null, detail: '' });

  log(`数据目录：${config.dataRoot()}`);
  log(`DSH_HOME：${config.dshHome()}`);
  log(`Node 运行时：${config.resolveNodeExecutable()}`);

  try {
    const installed = runtime.installedVersion();
    const usable = installed !== null && fs.existsSync(config.runtimeEntry());

    if (install || !usable) {
      // 只有本地没有可用运行时、或用户明确要求更新时才联网。
      const check = await updater.checkRuntime();
      report(8, undefined, { installedVersion: check.current, latestVersion: check.latest });
      if (check.current === null || check.updateAvailable) {
        log(`${check.current === null ? '未检测到 dsh' : `发现新版 dsh：${check.current} → ${check.latest}`}，开始安装（镜像 ${check.registry}）`);
        report(10, `正在安装 dsh ${check.latest}…`, {
          status: 'installing',
          detail: '需要联网下载运行环境，装好之后就不再需要联网了。',
        });
        const version = await runtime.installDsh({
          onLine: log,
          onProgress: (percent) => report(10 + percent * 0.68, undefined, { status: 'installing' }),
        });
        report(78, undefined, { installedVersion: version, latestVersion: version });
      } else {
        log(`dsh ${check.current} 已是最新版本`);
        report(78, undefined, { installedVersion: check.current, latestVersion: check.latest });
      }
    } else {
      log(`本地已有 dsh ${installed}，直接启动（版本检查放到界面就绪之后）`);
      report(30, undefined, { installedVersion: installed, latestVersion: installed });
    }

    // 起服务之前先把「隐藏控制台窗口」的补丁确认一遍：dsh 升级会重装 node_modules，
    // 补丁跟着没了，闪窗会回来，所以每次启动都补一次（幂等，已打过就直接跳过）。
    runtimePatch.ensureRuntimeConsoleHidden({ onLine: log });

    report(80, '正在启动 dsh 服务…', { status: 'starting' });
    const serviceStartedAt = Date.now();
    dsh = new DshProcess();
    dsh.on('progress', (percent) => report(percent));
    dsh.on('exit', ({ stopping }) => {
      if (!stopping) log('dsh 服务已退出');
    });

    const ready = waitForReady(dsh);
    void dsh.start();
    const url = await ready;
    if (url === null) throw new Error('未能获取 Web UI 地址');

    // 把服务启动耗时单独记一笔：客户端自己的开销已经压到最低，
    // 这里剩下的就是 dsh 自身启动的时间，慢了也知道该找谁。
    log(
      `dsh 已就绪：${url}（服务启动 ${((Date.now() - serviceStartedAt) / 1000).toFixed(1)}s，` +
        `本次启动共 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
    );
    report(100, '正在打开界面…', { status: 'ready' });
    await showWebUi(url);

    if (checkAfterReady) void checkRuntimeUpdateAfterBoot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`启动失败：${message}`);
    pushState({ status: 'failed', message: '启动失败', error: message });
  } finally {
    updateInFlight = false;
  }
}

/**
 * 界面就绪后的后台版本检查：查到新版本只问一句，绝不让启动路径等它。
 * 断网、镜像不稳都只记日志——界面已经能用了，不该因此报错。
 */
async function checkRuntimeUpdateAfterBoot() {
  try {
    const check = await updater.checkRuntime();
    const current = check.current ?? runtime.installedVersion();
    if (current === null || !check.updateAvailable) {
      log(`dsh ${current ?? '未安装'} 已是最新版本`);
      return;
    }
    if (config.readSettings().lastNotifiedVersion === check.latest) {
      log(`dsh ${check.latest} 已经提示过，本次不再打扰`);
      return;
    }
    log(`发现新版 dsh：${current} → ${check.latest}，等待用户确认`);
    config.writeSettings({ lastNotifiedVersion: check.latest });
    await promptRuntimeUpdate(current, check.latest);
  } catch (error) {
    log(`后台检查 dsh 版本失败（不影响本次使用）：${error.message}`);
  }
}

/**
 * 发现新版本时问一句，用户同意就停服务、装新版、再用新版本把服务拉起来。
 * 「启动后的后台检查」「手动检查」「每 30 分钟的周期检查」三处共用，措辞只维护一份。
 * @returns {Promise<boolean>} 是否已按用户意愿触发更新
 */
async function promptRuntimeUpdate(current, latest) {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
    title: 'dsh 有新版本',
    message: `dsh ${latest} 已发布`,
    detail: `当前版本 ${current}。更新会重启本地服务，进行中的会话可能中断。`,
  });
  if (response !== 0) return false;
  await updateRuntime();
  return true;
}

/** 停掉本地服务、装最新版 dsh、再把服务拉起来（用户确认更新后走这里）。 */
async function updateRuntime() {
  if (updateInFlight) return;
  if (dsh !== null) {
    await dsh.stop();
    dsh = null;
  }
  // 安装期间把窗口切回引导页：服务已经停了，留在 Web UI 上只会是一片死页面。
  if (mainWindow !== null && !mainWindow.isDestroyed()) await mainWindow.loadFile(BOOT_PAGE);
  boot.percent = 0;
  await bootSequence({ install: true });
}

/** 手动触发一次检查；发现新版本时问一句再更新。 */
async function checkUpdatesManually() {
  if (updateInFlight) return;
  try {
    const result = await updater.checkAll(log);
    if (result.runtime?.updateAvailable && result.runtime.current !== null) {
      await promptRuntimeUpdate(result.runtime.current, result.runtime.latest);
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
        await promptRuntimeUpdate(result.runtime.current, result.runtime.latest);
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
        void bootSequence({ checkAfterReady: true });
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
        { label: '查看余额…', click: () => void checkAccountBalance() },
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
    scheduleUpdateChecks();
    // 窗口加载与 dsh 启动并行：不等窗口画完再拉服务，省掉这 1~2 秒。
    // 本地已有运行时直接起服务，新版本改为界面就绪后在后台问一句。
    const windowLoaded = createWindow();
    void bootSequence({ checkAfterReady: true });
    await windowLoaded;
  });

  app.on('window-all-closed', () => {
    // 最小化到托盘时窗口只是隐藏，不会走到这里；真关闭窗口才应该退出。
    if (config.readSettings().closeAction === 'tray') return;
    quitApp();
  });

  app.on('before-quit', (event) => {
    clearInterval(updateTimer);
    quitting = true;
    // 收尾期间冒出来的退出请求一律挡回去：停子进程不能被打断，
    // 收尾完成后由下面的 app.quit() 统一放行。
    if (shutdownInFlight) {
      event.preventDefault();
      return;
    }
    if (dsh === null) return;
    event.preventDefault();
    shutdownInFlight = true;
    // 退出时收掉 dsh 子进程，避免留下孤儿服务占用端口与句柄。
    // 先把引用摘掉再停进程：这次 app.quit() 会被拦下，收尾完成后重放的那次才会放行。
    const pending = dsh;
    dsh = null;
    hideForQuit();
    void pending
      .stop()
      .catch(() => {})
      .finally(() => {
        pending.dispose();
        shutdownInFlight = false;
        log('本地服务已停止，应用退出。');
        app.quit();
      });
  });
}

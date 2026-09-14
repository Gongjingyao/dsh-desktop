'use strict';

/**
 * 退出路径校检：真实拉起 dsh web，再走一遍应用退出时的 stop()。
 *
 * 盯住的是一个改过的真实缺陷：Windows 上 taskkill 不带 /F 对 dsh 这种无窗口的
 * 控制台进程必然失败，于是每次退出都要先白等满宽限期才强杀——用户点了"退出"没反应，
 * 往往要点第二次。这里断言 stop() 在秒级内完成，并且子进程确实被回收。
 *
 * 用法：node scripts/check-exit.js
 * 复用本机已装好的运行时（%APPDATA%\dsh-desktop\runtime），不联网安装，也不写用户数据目录。
 */

const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const testDataRoot = path.join(projectRoot, '_selftest');
// dataRoot() 会在 appData 后面再拼一层 dsh-desktop，和真实目录结构保持一致。
const testAppData = path.join(testDataRoot, 'dsh-desktop');
const installedRuntime = path.join(process.env.APPDATA ?? os.homedir(), 'dsh-desktop', 'runtime');

// 数据目录指到工程内，日志/DSH_HOME 都不会落到用户真实目录；
// 运行时用 junction 链到已装好的那一份，省掉重新下载 500 个包。
const stubApp = {
  isPackaged: false,
  getVersion: () => require(path.join(projectRoot, 'package.json')).version,
  getPath: (name) => (name === 'appData' ? testDataRoot : os.tmpdir()),
  getAppPath: () => projectRoot,
};
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return { app: stubApp };
  return originalLoad.call(this, request, parent, isMain);
};

process.env.DSH_DESKTOP_HOME = path.join(testDataRoot, 'home');
const devElectron = path.join(projectRoot, 'build', 'electron-dist', 'electron.exe');
if (fs.existsSync(devElectron)) process.env.DSH_DESKTOP_NODE_EXECUTABLE = devElectron;

/** 把 <appData>/dsh-desktop/runtime 链到已装好的运行时；已存在就原样用（绝不删除链接，避免误伤目标目录）。 */
function ensureRuntimeLink() {
  const link = path.join(testAppData, 'runtime');
  if (fs.existsSync(path.join(link, 'node_modules', '@deepseek-ai', 'dsh'))) return true;
  if (fs.existsSync(link)) return false;
  if (!fs.existsSync(installedRuntime)) return false;
  fs.mkdirSync(testAppData, { recursive: true });
  fs.symlinkSync(installedRuntime, link, 'junction');
  return true;
}

const config = require('../src/config');
const runtime = require('../src/runtime');
const { DshProcess } = require('../src/dsh');

/**
 * 停止耗时上限：正常路径只有一次 taskkill 的时间。这里给得比较宽松，是因为
 * taskkill 在受限环境里会被拒（Access denied），此时会走"直接杀子进程"的兜底路径，
 * 多花一次 TREE_KILL_WAIT_MS。老实现是 8s + 5s，无论哪条路径都在这个上限之内。
 */
const STOP_BUDGET_MS = 3000;

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 子进程是否还在（Windows 用 tasklist 查 PID）。 */
function isAlive(pid) {
  if (process.platform !== 'win32') {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
  const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8' }).stdout ?? '';
  return out.includes(String(pid));
}

async function main() {
  if (!ensureRuntimeLink()) {
    console.error(`未找到可复用的运行时（先正常启动一次客户端，或检查 ${installedRuntime}）`);
    process.exit(2);
  }
  const entry = config.runtimeEntry();
  if (!fs.existsSync(entry)) {
    console.error(`运行时入口不存在：${entry}`);
    process.exit(2);
  }
  console.log(`运行时：dsh ${runtime.installedVersion()}`);
  console.log(`DSH_HOME：${config.dshHome()}`);

  const instance = new DshProcess();
  const started = Date.now();
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('启动超时')), 180000);
    instance.once('ready', (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    instance.once('exit', ({ code, stopping }) => {
      if (stopping) return;
      clearTimeout(timer);
      reject(new Error(`子进程提前退出，退出码 ${code}`));
    });
    instance.start().catch(reject);
  });
  check('dsh web 启动并输出 URL', /^http:\/\/127\.0\.0\.1:\d+\//.test(url), `${((Date.now() - started) / 1000).toFixed(1)}s`);

  const pid = instance.child?.pid ?? 0;
  const stopStarted = Date.now();
  await instance.stop();
  const stopMs = Date.now() - stopStarted;
  check(`停止耗时 < ${STOP_BUDGET_MS}ms`, stopMs < STOP_BUDGET_MS, `${stopMs}ms`);
  check('子进程引用已清空', instance.child === null);
  check('子进程确实已退出（无孤儿进程）', pid !== 0 && !isAlive(pid), `pid ${pid}`);
  instance.dispose();

  const failed = results.filter((item) => !item.passed).length;
  console.log(`\n合计 ${results.length} 项，失败 ${failed} 项`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`校检异常：${error.stack ?? error.message}`);
  process.exit(1);
});

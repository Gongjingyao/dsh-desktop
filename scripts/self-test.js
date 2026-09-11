'use strict';

/**
 * 无 GUI 的端到端自检：直接跑 src/ 下的运行时与进程管理模块。
 *
 * Electron 的 app 对象用桩替代，其余逻辑全部走真实实现：
 *   1) 找到可执行的 Node 运行时
 *   2) 启动 dsh web 子进程并拿到可访问 URL
 *   3) 请求该 URL 确认服务真的在响应
 *   4) 停止子进程
 *
 * 用法：node scripts/self-test.js
 */

const Module = require('node:module');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const testDataRoot = path.join(projectRoot, '_selftest');

// 桩：只提供 src/ 真正用到的 app API，并把数据目录指到工程内的临时目录。
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

process.env.DSH_DESKTOP_HOME = path.join(testDataRoot, 'home');process.env.DSH_DESKTOP_NODE_EXECUTABLE = path.join(projectRoot, 'build', 'electron-dist', 'electron.exe');

const config = require('../src/config');
const runtime = require('../src/runtime');
const { DshProcess } = require('../src/dsh');

const results = [];
function check(name, passed, detail) {
  results.push({ name, passed, detail });
  console.log(`${passed ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function request(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request(
      { host: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, headers },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('请求超时')));
    req.end();
  });
}

/**
 * 复刻浏览器的鉴权握手：先带 token 请求根路径换 cookie，再带 cookie 请求页面。
 * 直接用 fetch 不带 cookie 只会拿到 401，不能作为可用性判据。
 */
async function openWebUi(url) {
  const first = await request(url, { accept: 'text/html' });
  const cookie = String(first.headers['set-cookie'] ?? '').split(';')[0];
  if (first.status !== 303 || cookie === '') {
    return { ok: false, detail: `握手返回 HTTP ${first.status}` };
  }
  const second = await request(new URL(url).origin + '/', { accept: 'text/html', cookie });
  return { ok: second.status === 200 && second.body.includes('<html'), detail: `HTTP ${second.status}，${second.body.length} 字节` };
}

async function main() {
  console.log(`数据目录：${config.dataRoot()}`);
  console.log(`DSH_HOME：${config.dshHome()}`);

  const nodeExec = config.resolveNodeExecutable();
  check('解析 Node 运行时', fs.existsSync(nodeExec), nodeExec);

  const installed = runtime.installedVersion();
  check('运行时已安装', installed !== null, `dsh ${installed}`);

  if (installed === null) {
    console.log('运行时未安装，先执行安装…');
    await runtime.installDsh({ onLine: (line) => console.log(`  ${line}`) });
  }

  const latest = await runtime.fetchLatestVersion();
  check('查询最新版本', typeof latest.version === 'string', `${latest.version} @ ${latest.registry}`);
  check(
    '版本比较可用',
    runtime.compareVersions('0.1.5-rc.2', '0.1.5-rc.1') > 0 && runtime.compareVersions('0.1.5-rc.1', '0.1.5-rc.1') === 0,
  );

  // DSH_HOME 故意先删掉：全新电脑上它并不存在，启动时应当自己建出来。
  const homeBefore = config.dshHome();
  fs.rmSync(homeBefore, { recursive: true, force: true });
  check('DSH_HOME 清理完毕', !fs.existsSync(homeBefore), homeBefore);

  const logsBefore = fs.existsSync(config.logsDir()) ? fs.readdirSync(config.logsDir()).length : 0;
  const instance = new DshProcess();
  const output = [];
  instance.on('output', (line) => output.push(line));
  const progress = [];
  instance.on('progress', (percent) => progress.push(percent));
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
      reject(new Error(`子进程提前退出，退出码 ${code}\n${output.slice(-20).join('\n')}`));
    });
    instance.start().catch(reject);
  });
  check('dsh web 启动并输出 URL', /^http:\/\/127\.0\.0\.1:\d+\//.test(url), url);
  check('启动耗时合理', Date.now() - started < 180000, `${((Date.now() - started) / 1000).toFixed(1)}s`);
  check(
    '启动进度单调递增到 100',
    progress.length >= 2 && progress[0] === 80 && progress[progress.length - 1] === 100 &&
      progress.every((value, index) => index === 0 || value >= progress[index - 1]),
    progress.join(' → '),
  );

  const handshake = await openWebUi(url);
  check('Web UI 可访问（token 握手 → 页面 200）', handshake.ok, handshake.detail);

  await instance.stop();
  await new Promise((resolve) => setTimeout(resolve, 800));
  check('停止后子进程已回收', instance.child === null);
  const logsAfter = fs.existsSync(config.logsDir()) ? fs.readdirSync(config.logsDir()).length : 0;
  check('日志已落盘', logsAfter > logsBefore, `${logsBefore} → ${logsAfter} 个文件，stdio=${instance.fileStdio ? '文件' : '管道'}`);
  instance.dispose();

  const failed = results.filter((item) => !item.passed);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`自检异常：${error.stack ?? error.message}`);
  process.exit(1);
});

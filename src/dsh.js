'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

/** Web UI 启动成功后打印的一行：`dsh web: <url> (LAN: <url>)`。 */
const WEB_URL_PATTERN = /dsh web:\s*(http:\/\/\S+)/;
const READY_TIMEOUT_MS = 180000;
const KILL_GRACE_MS = 8000;
/** 强杀之后再等多久就放弃等待（应用退出不能被它拖住）。 */
const FORCE_KILL_WAIT_MS = 5000;
/** 回退到文件 stdio 时，父进程跟进日志的轮询间隔。 */
const LOG_POLL_MS = 300;

/** 日志只留最近若干份，避免长期使用后目录无限膨胀。 */
const MAX_LOG_FILES = 10;

function pruneLogs(prefix) {
  const logsDir = config.logsDir();
  if (!fs.existsSync(logsDir)) return;
  const existing = fs
    .readdirSync(logsDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.log'))
    .sort();
  for (const stale of existing.slice(0, Math.max(0, existing.length - MAX_LOG_FILES))) {
    fs.rmSync(path.join(logsDir, stale), { force: true });
  }
}

function newLogPath(prefix) {
  config.ensureDir(config.logsDir());
  pruneLogs(prefix);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(config.logsDir(), `${prefix}-${stamp}.log`);
}

/**
 * 托管一个常驻的 `dsh --profile web` 子进程。
 *
 * 子进程输出走「管道优先、失败回退文件」：管道是行缓冲，就绪那一行能立刻读到；
 * 某些受限环境不允许给子进程建管道，此时把输出重定向进日志文件再轮询。
 *
 * 事件：`state`（状态字符串）、`output`（日志行）、`progress`（启动百分比 80~98）、
 * `ready`（Web URL）、`exit`（{code}）。
 */
class DshProcess extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.webUrl = null;
    this.state = 'idle';
    this.logFile = null;
    this.appender = null;
    this.logHandle = null;
    this.readOffset = 0;
    this.pending = '';
    this.pollTimer = null;
    /** 管道不可用时才做文件和轮询，正常路径下这两个都是空的。 */
    this.fileStdio = false;
    this.stopping = false;
    this.readyTimer = null;
    this.progressTimer = null;
    this.lastProgress = 0;
  }

  setState(state) {
    this.state = state;
    this.emit('state', state);
  }

  /**
   * 启动阶段的百分比：从 80% 缓慢逼近 98%，就绪时由调用方推到 100%。
   * dsh 启动过程没有可用的阶段事件，这里只表示"还在推进"，不伪装成精确值。
   */
  #startProgressTicker() {
    const start = Date.now();
    this.lastProgress = 0;
    this.progressTimer = setInterval(() => {
      const elapsed = (Date.now() - start) / 1000;
      // 12 秒左右走完大部分，之后越来越慢，避免长时间停在 98% 不动。
      const ratio = 1 - Math.exp(-elapsed / 9);
      const percent = Math.min(98, Math.round(80 + ratio * 18));
      if (percent !== this.lastProgress) {
        this.lastProgress = percent;
        this.emit('progress', percent);
      }
    }, 400);
    this.emit('progress', 80);
  }

  #stopProgressTicker() {
    clearInterval(this.progressTimer);
    this.progressTimer = null;
  }

  /** 自己写日志（父进程侧的行，与子进程输出写进同一个文件）。 */
  #write(line) {
    this.appender?.write(`${line}\n`);
    this.emit('output', line);
  }

  /** 子进程的一行输出：落盘、上报，并识别就绪 URL。 */
  #recordLine(line) {
    this.appender?.write(`${line}\n`);
    this.emit('output', line);
    const match = WEB_URL_PATTERN.exec(line);
    if (match && this.webUrl === null) {
      this.webUrl = match[1];
      clearTimeout(this.readyTimer);
      this.#stopProgressTicker();
      this.emit('progress', 100);
      this.#write(`dsh Web UI：${this.webUrl}`);
      this.setState('ready');
      this.emit('ready', this.webUrl);
    }
  }

  /**
   * 拉起子进程。
   *
   * 首选管道 stdout：行缓冲，就绪那一行能立刻读到。
   * 某些受限环境不允许给子进程建管道（spawn 直接 EPERM），此时回退到把
   * stdout/stderr 重定向进日志文件，父进程轮询读取——代价是块缓冲会带来延迟，
   * 但能保证仍然可用。
   */
  #spawnChild(args, home) {
    const spawnPiped = () => {
      let child = null;
      try {
        child = spawn(config.resolveNodeExecutable(), args, {
          cwd: home,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: config.childEnv({ DSH_HOME: home }),
        });
      } catch (error) {
        // 受限环境下 spawn 会在这里直接抛 EPERM，交给调用方回退到文件方式。
        return Promise.reject(error);
      }
      const attach = () => {
        this.fileStdio = false;
        for (const stream of [child.stdout, child.stderr]) {
          if (stream === null) continue;
          stream.setEncoding('utf8');
          let buffered = '';
          stream.on('data', (chunk) => {
            buffered += chunk;
            let index = buffered.indexOf('\n');
            while (index >= 0) {
              this.#recordLine(buffered.slice(0, index).replace(/\r$/, ''));
              buffered = buffered.slice(index + 1);
              index = buffered.indexOf('\n');
            }
          });
          stream.on('end', () => {
            if (buffered.trim() !== '') this.#recordLine(buffered);
          });
        }
        return child;
      };

      return new Promise((resolve, reject) => {
        const onEarlyError = (error) => reject(error);
        child.once('error', onEarlyError);
        // spawn 的错误以事件形式异步上报，下一轮事件循环没有报错就说明起进程成功。
        setImmediate(() => {
          child.off('error', onEarlyError);
          resolve(attach());
        });
      });
    };

    const spawnToFile = () => {
      this.fileStdio = true;
      let child = null;
      try {
        child = spawn(config.resolveNodeExecutable(), args, {
          cwd: home,
          windowsHide: true,
          stdio: ['ignore', this.logHandle, this.logHandle],
          env: config.childEnv({ DSH_HOME: home }),
        });
      } catch (error) {
        this.#write(`dsh 进程启动失败：${error.message}`);
        this.#write(`可执行文件：${config.resolveNodeExecutable()}`);
        this.setState('failed');
        throw error;
      }
      this.#startLogPolling();
      return child;
    };

    return spawnPiped().catch((error) => {
      this.#write(`管道方式启动失败（${error.message}），改用日志文件方式。`);
      return spawnToFile();
    });
  }

  /** 回退路径专用：增量读取日志文件，还原成一行行输出。 */
  #drain() {
    if (this.logHandle === null) return;
    let chunk = '';
    try {
      const size = fs.fstatSync(this.logHandle).size;
      if (size > this.readOffset) {
        const buffer = Buffer.alloc(size - this.readOffset);
        const read = fs.readSync(this.logHandle, buffer, 0, buffer.length, this.readOffset);
        this.readOffset += read;
        chunk = buffer.subarray(0, read).toString('utf8');
      }
    } catch {
      return;
    }
    if (chunk === '') return;

    this.pending += chunk;
    let index = this.pending.indexOf('\n');
    while (index >= 0) {
      this.#recordLine(this.pending.slice(0, index).replace(/\r$/, ''));
      this.pending = this.pending.slice(index + 1);
      index = this.pending.indexOf('\n');
    }
  }

  #startLogPolling() {
    this.pollTimer = setInterval(() => this.#drain(), LOG_POLL_MS);
  }

  #stopLogPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  /** 启动 web 服务；已启动时直接返回当前 URL。 */
  async start() {
    if (this.child !== null) return this.webUrl;

    const entry = config.runtimeEntry();
    if (!fs.existsSync(entry)) throw new Error(`未找到 dsh 入口：${entry}`);

    this.logFile = newLogPath('dsh');
    config.ensureDir(path.dirname(this.logFile));
    // 先同步建出文件：createWriteStream 是异步打开的，紧接着的只读句柄会扑空。
    fs.writeFileSync(this.logFile, '', { flag: 'a' });
    this.appender = fs.createWriteStream(this.logFile, { flags: 'a' });
    // 回退路径要用同一个句柄增量读，所以按读写方式打开并在 close 时统一释放。
    this.logHandle = fs.openSync(this.logFile, 'a+');
    this.readOffset = 0;
    this.pending = '';
    this.stopping = false;
    this.webUrl = null;
    this.setState('starting');
    this.#write(`===== ${new Date().toISOString()} 启动 dsh =====`);

    // --expose-internals 是 dsh 的 HMR 加载器必需的：
    // 它优先用 --expose-internals 直接拿 Node 内部 ESM loader，拿不到时才退回
    // node-addon-require-builtin 这个原生插件，而该插件在 Electron 的内嵌 Node 里
    // 无法工作（no compatible GetAlignedPointerFromEmbedderData symbol found）。
    // 端口交给操作系统分配，避免与用户自己开的 dsh 或其它程序抢占固定端口。
    const args = ['--expose-internals', entry, '--profile', 'web', '--no-open', '--port', '0'];
    // DSH_HOME 作为工作目录必须存在：全新电脑上它还是空的，Windows 下
    // 不存在的 cwd 会让 spawn 直接失败（ENOENT）。
    const home = config.ensureDir(config.dshHome());
    const child = await this.#spawnChild(args, home);
    this.child = child;
    this.#startProgressTicker();

    this.readyTimer = setTimeout(() => {
      if (this.webUrl === null) {
        this.#write(`启动超过 ${READY_TIMEOUT_MS / 1000}s 仍未就绪，日志：${this.logFile}`);
        this.setState('timeout');
      }
    }, READY_TIMEOUT_MS);

    child.once('error', (error) => {
      this.#write(`dsh 进程启动失败：${error.message}`);
      this.#write(`可执行文件：${config.resolveNodeExecutable()}`);
      this.setState('failed');
    });
    child.once('close', (code) => {
      clearTimeout(this.readyTimer);
      this.#stopProgressTicker();
      this.#stopLogPolling();
      this.#drain();
      this.child = null;
      this.webUrl = null;
      this.#write(`===== dsh 进程结束，退出码 ${code ?? 0} =====`);
      this.appender?.end();
      this.appender = null;
      if (this.logHandle !== null) {
        try {
          fs.closeSync(this.logHandle);
        } catch {
          // 已经关过就忽略。
        }
        this.logHandle = null;
      }
      this.setState('idle');
      this.emit('exit', { code: code ?? 0, stopping: this.stopping });
    });

    return null;
  }

  /**
   * 先请求正常退出，超时后连同子进程树一起强制结束。
   * 每一步都有硬上限：退出流程绝不能因为没有 close 事件而挂住应用。
   */
  async stop() {
    const child = this.child;
    if (child === null) return;
    this.stopping = true;
    const pid = child.pid;
    this.#write('正在停止 dsh…');

    const closed = new Promise((resolve) => child.once('close', resolve));
    const wait = (ms) => Promise.race([closed, new Promise((resolve) => setTimeout(resolve, ms))]);

    const terminate = (force) => {
      if (process.platform !== 'win32') {
        child.kill(force ? 'SIGKILL' : 'SIGTERM');
        return;
      }
      try {
        // Windows 没有真正的 SIGTERM：先不带 /F 请求退出，不行再强杀整棵进程树。
        spawn('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], {
          windowsHide: true,
          stdio: 'ignore',
        });
      } catch {
        try {
          child.kill();
        } catch {
          // 进程可能已经退出，忽略。
        }
      }
    };

    terminate(false);
    await wait(KILL_GRACE_MS);
    if (this.child !== null) {
      this.#write(`dsh 未在 ${KILL_GRACE_MS / 1000}s 内退出，强制结束。`);
      terminate(true);
      await wait(FORCE_KILL_WAIT_MS);
    }
    if (this.child !== null) {
      this.#write(`dsh 进程 ${pid} 仍未退出，先继续退出应用。`);
    }
    this.stopping = false;
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  /** 退出前把该收的句柄都收掉。 */
  dispose() {
    this.#stopProgressTicker();
    this.#stopLogPolling();
    this.appender?.end();
    this.appender = null;
    if (this.logHandle !== null) {
      try {
        fs.closeSync(this.logHandle);
      } catch {
        // 句柄在 close 回调里已经关过，这里忽略。
      }
      this.logHandle = null;
    }
  }
}

/** 把 dsh 的启动日志写到一个 .cmd，方便用户在终端里自己排查问题。 */
function writeCliLauncher() {
  const target = path.join(config.dataRoot(), 'dsh.cmd');
  config.ensureDir(config.dataRoot());
  const lines = [
    '@echo off',
    'rem DSH Desktop 生成的命令行入口，可直接在终端里使用 dsh。',
    `set "DSH_HOME=${config.dshHome()}"`,
    'set "ELECTRON_RUN_AS_NODE=1"',
    `"${config.resolveNodeExecutable()}" --expose-internals "${config.runtimeEntry()}" %*`,
    '',
  ];
  fs.writeFileSync(target, lines.join('\r\n'), 'utf8');
  return target;
}

module.exports = { DshProcess, writeCliLauncher, READY_TIMEOUT_MS };

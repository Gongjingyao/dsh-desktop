'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const config = require('./config');

/** 连接超时：国内镜像通常很快，超时即认为该镜像不可用。 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * 执行一个进程并等它结束。
 *
 * 子进程输出重定向到文件、父进程轮询读取：这样既不依赖管道 stdio
 * （受限环境下管道会直接 spawn 失败），又能把完整输出留档。
 *
 * @param {object} options
 * @param {string} options.logFile - 输出落盘路径
 * @param {(line:string)=>void} [options.onLine] - 逐行回调
 * @param {(line:string)=>void} [options.onLineFilter] - 过滤后需要上报的整行日志
 * @param {(text:string)=>void} [options.collect] - 结束后拿到完整输出
 */
function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    config.ensureDir(path.dirname(options.logFile));
    // a+：进程还没写任何输出时文件也必须已经存在，否则 'r' 读取会失败。
    const logHandle = fs.openSync(options.logFile, 'a+');
    let child = null;
    try {
      child = spawn(file, args, {
        windowsHide: true,
        ...options,
        stdio: ['ignore', logHandle, logHandle],
        env: options.env || config.childEnv(),
      });
    } catch (error) {
      fs.closeSync(logHandle);
      reject(error);
      return;
    }

    let readOffset = fs.fstatSync(logHandle).size;
    let pending = '';
    const drain = () => {
      let chunk = '';
      try {
        const size = fs.fstatSync(logHandle).size;
        if (size > readOffset) {
          const buffer = Buffer.alloc(size - readOffset);
          const read = fs.readSync(logHandle, buffer, 0, buffer.length, readOffset);
          readOffset += read;
          chunk = buffer.subarray(0, read).toString('utf8');
        }
      } catch {
        return;
      }
      if (chunk === '') return;
      pending += chunk;
      let index = pending.indexOf('\n');
      while (index >= 0) {
        options.onLine?.(pending.slice(0, index).replace(/\r$/, ''));
        pending = pending.slice(index + 1);
        index = pending.indexOf('\n');
      }
    };

    const timer = setInterval(drain, 300);
    const finish = (code) => {
      drain();
      if (pending.trim() !== '') options.onLine?.(pending);
      clearInterval(timer);
      if (options.collect) {
        try {
          options.collect(fs.readFileSync(options.logFile, 'utf8'));
        } catch {
          options.collect('');
        }
      }
      try {
        fs.closeSync(logHandle);
      } catch {
        // 已经关过就忽略。
      }
      resolve({ code: code ?? 0 });
    };

    child.once('error', (error) => {
      clearInterval(timer);
      try {
        fs.closeSync(logHandle);
      } catch {
        // 忽略重复关闭。
      }
      reject(error);
    });
    child.once('close', finish);
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}`);
  return response.json();
}

/** 读取本地已安装的 dsh 版本，未安装返回 null。 */
function installedVersion() {
  try {
    const raw = fs.readFileSync(path.join(config.runtimePackageDir(), 'package.json'), 'utf8');
    return JSON.parse(raw).version ?? null;
  } catch {
    return null;
  }
}

/** 语义化版本比较：a > b 返回正数。预发布号按 semver 规则参与比较。 */
function compareVersions(a, b) {
  const parse = (value) => {
    const [core, pre = ''] = String(value).split('-');
    const numbers = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
    return { numbers, pre: pre === '' ? null : pre.split('.') };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index += 1) {
    const diff = (left.numbers[index] ?? 0) - (right.numbers[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === null && right.pre === null) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  const length = Math.max(left.pre.length, right.pre.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.pre[index];
    const rightPart = right.pre[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : null;
    if (leftNumber !== null && rightNumber !== null) {
      if (leftNumber !== rightNumber) return leftNumber - rightNumber;
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1;
    }
  }
  return 0;
}

/**
 * 查询镜像上的最新版本。按候选镜像顺序尝试，第一个成功的结果胜出。
 * @returns {Promise<{version:string, registry:string}>}
 */
async function fetchLatestVersion() {
  const settings = config.readSettings();
  const registries = [settings.registry, ...config.REGISTRY_CANDIDATES].filter(
    (value, index, list) => value && list.indexOf(value) === index,
  );
  const failures = [];
  for (const registry of registries) {
    try {
      const packument = await fetchJson(`${registry}/${config.DSH_PACKAGE.replace('/', '%2f')}`);
      const version = packument['dist-tags']?.latest;
      if (typeof version === 'string' && version !== '') return { version, registry };
      failures.push(`${registry}: 响应缺少 dist-tags.latest`);
    } catch (error) {
      failures.push(`${registry}: ${error.message}`);
    }
  }
  throw new Error(`无法获取最新版本（已尝试 ${registries.length} 个镜像）\n${failures.join('\n')}`);
}

/**
 * 确保运行时目录里有一份可用的 npm。
 * 不依赖目标机器上的 Node/npm：从镜像下载 npm 的 tarball 解压到 runtime/npm。
 */
async function ensureNpm(onLine) {
  const npmRoot = path.join(config.runtimeRoot(), 'npm');
  const cliPath = path.join(npmRoot, 'package', 'bin', 'npm-cli.js');
  if (fs.existsSync(cliPath)) return cliPath;

  const settings = config.readSettings();
  const registries = [settings.registry, ...config.REGISTRY_CANDIDATES].filter(
    (value, index, list) => value && list.indexOf(value) === index,
  );

  let lastError = null;
  for (const registry of registries) {
    try {
      onLine(`正在准备内置 npm（镜像 ${registry}）…`);
      const meta = await fetchJson(`${registry}/npm/latest`);
      const tarballUrl = meta?.dist?.tarball;
      if (typeof tarballUrl !== 'string') throw new Error('响应缺少 dist.tarball');

      const response = await fetch(tarballUrl, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw new Error(`下载 npm 失败：HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());

      fs.rmSync(npmRoot, { recursive: true, force: true });
      config.ensureDir(npmRoot);
      onLine(`已下载 npm ${meta.version}（${Math.round(buffer.length / 1024)} KB），正在解压…`);
      await extractTarball(buffer, npmRoot);
      if (fs.existsSync(cliPath)) return cliPath;
      throw new Error('解压后未找到 npm-cli.js');
    } catch (error) {
      lastError = error;
      onLine(`该镜像不可用：${error.message}`);
    }
  }
  throw new Error(`无法准备内置 npm：${lastError?.message ?? '未知原因'}`);
}

/** 用内置 Node 自带的 zlib 解压 .tar.gz（只处理普通文件与目录，足够 npm 包使用）。 */
async function extractTarball(buffer, destination) {
  const tar = zlib.gunzipSync(buffer);
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const readString = (start, length) => {
      const end = header.indexOf(0, start);
      const stop = end === -1 || end > start + length ? start + length : end;
      return header.toString('utf8', start, stop);
    };
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const sizeText = readString(124, 12).trim();
    const size = Number.parseInt(sizeText, 8) || 0;
    const type = String.fromCharCode(header[156] || 48);

    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const target = path.join(destination, ...relative.split('/').filter((part) => part && part !== '.'));
    const payloadStart = offset + 512;
    const payloadEnd = payloadStart + size;
    const paddedEnd = payloadStart + Math.ceil(size / 512) * 512;

    // 包内路径必须落在目标目录内，避免被构造的 tarball 写出目录。
    if (target !== destination && !target.startsWith(destination + path.sep)) {
      throw new Error(`压缩包内路径非法：${relative}`);
    }

    if (type === '5') {
      config.ensureDir(target);
    } else if (type === '0' || type === '\0' || type === '') {
      // npm 的包名会带 scope 目录，这里统一按文件名长度上限建目录。
      config.ensureDir(path.dirname(target));
      const body = tar.subarray(payloadStart, payloadEnd);
      try {
        fs.writeFileSync(target, body, { mode: 0o666 });
      } catch (error) {
        // Windows 上的超长路径不值得为此中断安装。
        if (error.code !== 'ENAMETOOLONG') throw error;
      }
    }
    offset = paddedEnd;
  }
}

/**
 * 用内置 npm 安装 / 升级 dsh CLI 到 runtime 目录。
 * @param {object} options
 * @param {string} [options.spec] - 例如 `@deepseek-ai/dsh@latest`
 * @param {(line:string)=>void} options.onLine - 逐行日志
 * @param {(percent:number)=>void} [options.onProgress] - 进度百分比（1~99）
 */
async function installDsh(options) {
  const { spec = `${config.DSH_PACKAGE}@latest`, onLine, onProgress } = options;
  const npmCli = await ensureNpm(onLine);
  const settings = config.readSettings();
  config.syncNpmrc(settings.registry);
  config.ensureDir(config.runtimeRoot());

  onLine(`正在安装 ${spec} …`);
  const args = [
    npmCli,
    'install',
    '--prefix',
    config.runtimeRoot(),
    '--registry',
    settings.registry,
    '--no-audit',
    '--no-fund',
    '--loglevel',
    'http',
    '--progress=false',
    spec,
  ];

  const devLog = path.join(config.logsDir(), 'npm-install.log');
  config.ensureDir(config.logsDir());

  // npm 不提供可靠的进度事件，这里只做一条缓慢逼近的上限爬升：
  // 目的是让用户看到"确实在动"，而不是假装精确到某个百分比。
  let estimate = 1;
  const estimateTimer = setInterval(() => {
    estimate = Math.min(99, estimate + Math.max(1, (99 - estimate) * 0.06));
    onProgress?.(Math.round(estimate));
  }, 400);
  onProgress?.(1);

  const { code } = await runProcess(config.resolveNodeExecutable(), args, {
    cwd: config.runtimeRoot(),
    logFile: devLog,
    env: config.childEnv({ npm_config_prefix: config.runtimeRoot() }),
    onLine: (line) => {
      // npm 的 http 级日志噪音很大，只挑对用户有意义的行上报。
      if (line.startsWith('npm error') || line.startsWith('npm warn') || /added \d+ package/.test(line)) {
        onLine(line);
      }
    },
  });
  clearInterval(estimateTimer);

  if (code !== 0) {
    throw new Error(`npm 安装失败（退出码 ${code}），完整日志：${devLog}`);
  }
  const version = installedVersion();
  if (version === null) throw new Error('安装完成后仍未找到 dsh 入口，请查看日志');
  onLine(`dsh ${version} 已就绪`);
  return version;
}

module.exports = {
  runProcess,
  installedVersion,
  compareVersions,
  fetchLatestVersion,
  ensureNpm,
  installDsh,
};

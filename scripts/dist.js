'use strict';

/**
 * 打 NSIS 安装包：`npm run dist`。
 *
 * 三个坑都在这一个文件里绕开：
 *
 * 1. **Node 版本**：electron-builder 26 要求 Node >= 14，而本机 PATH 上的 node 可能是 v12。
 *    所以当前 Node 太旧时，用 Electron 自带的 Node 24 重新执行本脚本（靠环境变量防止无限递归）。
 * 2. **不用 electron-builder 的 CLI**：在 Electron-as-node 下跑 CLI 时，yargs 会把入口脚本路径
 *    当成「项目目录」位置参数而报 Unknown argument。直接调 Node API 没有这个问题。
 * 3. **必须关掉 Electron 的 asar 支持（ELECTRON_NO_ASAR=1）**：Electron 的 fs 会把 `.asar`
 *    文件当目录（`readdir` 能列出归档内容）。electron-builder 复制 electronDist 时会遍历整个
 *    Electron 发行版，于是它钻进 `resources/default_app.asar` 的"虚拟目录"，而目标侧那是个普通
 *    文件 —— 创建子目录时报 ENOTDIR。实测：不关时 `lstat` 报 isDirectory=true，关掉后正常。
 *
 * 本文件自身必须能被旧 Node 解析（它先被旧 Node 读一遍才会重新执行），所以刻意不用可选链等新语法。
 */

// 刻意用不带 `node:` 前缀的模块名：本文件要先被旧 Node（可能是 v12）读一遍，
// 而那个前缀是 Node 14 之后才支持的。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** 仓库根目录（本脚本在 scripts/ 下）。 */
const repo = path.join(__dirname, '..');

/** 重新执行本脚本时用的环境变量标记，避免 Node 太旧时无限递归。 */
const REEXEC_FLAG = 'DSH_DIST_REEXEC';

/** electron-builder 要求的最低 Node 主版本。 */
const MIN_NODE_MAJOR = 14;

/** 打包用的 Electron（`scripts/fetch-electron.js` 解压出来的，同时是 electronDist）。 */
function electronBinary() {
  return path.join(repo, 'build', 'electron-dist', 'electron.exe');
}

/** 递归删除；旧 Node（< 14.14）没有 fs.rmSync。 */
function remove(target) {
  if (typeof fs.rmSync === 'function') {
    fs.rmSync(target, { recursive: true, force: true });
  } else {
    fs.rmdirSync(target, { recursive: true });
  }
}

/**
 * 打包前先清掉上一轮的产物：旧安装器会让人装错包，而上一轮的 win-unpacked 常被
 * Defender 扫过之后处于占用状态，留着它就可能在打包中途 EBUSY。
 * 只删产物，不动 release 下的其它文件（builder-debug.yml 之类）。
 */
function cleanRelease() {
  const release = path.join(repo, 'release');
  if (!fs.existsSync(release)) return;
  const stale = fs
    .readdirSync(release)
    .filter((name) => name === 'win-unpacked' || /\.(exe|7z|blockmap)$/i.test(name))
    .map((name) => path.join(release, name));
  if (stale.length === 0) return;
  console.log('清理上一轮产物：' + stale.map((p) => path.basename(p)).join('、'));
  stale.forEach(remove);
}

/** 用 Electron 自带的 Node 重新执行本脚本；不复返。 */
function reexecUnderElectron() {
  const binary = electronBinary();
  if (!fs.existsSync(binary)) {
    throw new Error(`找不到 ${binary}，先跑一次 npm run electron 准备打包用的 Electron`);
  }
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.log(`当前 Node ${process.versions.node} 低于 electron-builder 要求的 ${MIN_NODE_MAJOR}，改用 Electron 自带的 Node 重新执行…`);
  const result = spawnSync(binary, [__filename].concat(process.argv.slice(2)), {
    cwd: repo,
    stdio: 'inherit',
    env: Object.assign({}, process.env, {
      ELECTRON_RUN_AS_NODE: '1',
      ELECTRON_NO_ATTACH_CONSOLE: '1',
      // 见文件头第 3 条：不关掉 asar 支持，复制 Electron 发行版时会 ENOTDIR。
      ELECTRON_NO_ASAR: '1',
      [REEXEC_FLAG]: '1',
    }),
  });
  process.exit(typeof result.status === 'number' ? result.status : 1);
}

/**
 * 在 Electron 的 Node 下直接跑（没经过上面的重新执行）时，asar 支持必须已经关掉；
 * 否则会在复制 Electron 发行版时报一个很难查的 ENOTDIR，这里先把它挡在门口。
 */
function assertAsarSupportDisabled() {
  if (process.versions.electron !== undefined && process.env.ELECTRON_NO_ASAR !== '1') {
    console.error('在 Electron 的 Node 下打包必须设置 ELECTRON_NO_ASAR=1（否则复制 Electron 发行版会 ENOTDIR）。');
    process.exit(1);
  }
}

async function main() {
  cleanRelease();
  const { build, Platform, Arch } = require('electron-builder');
  const targets = Platform.WINDOWS.createTarget(['nsis'], Arch.x64);
  // projectDir + 显式的 config 路径：不依赖 CLI 的位置参数，也不依赖 cwd。
  await build({
    targets,
    projectDir: repo,
    config: path.join(repo, 'electron-builder.yml'),
  });
  console.log('打包完成。');
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
if (process.env[REEXEC_FLAG] !== '1' && nodeMajor < MIN_NODE_MAJOR) {
  reexecUnderElectron();
} else {
  assertAsarSupportDisabled();
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

'use strict';

/**
 * 给已安装的 dsh 运行时打一个「别弹控制台窗口」的补丁。
 *
 * 背景：桌面端拉起的 dsh 是 GUI 子系统进程（Electron-as-Node），没有可继承的控制台；
 * Windows 会给它 CreateProcess 出来的每个控制台子进程（pwsh.exe / cmd.exe）**新建并显示**
 * 一个控制台窗口 —— agent 每跑一条命令，桌面就闪一下黑框。dsh 运行时是 koffi 直接调
 * CreateProcess，STARTUPINFO 里没给窗口指定显示状态，所以只能在运行时侧补。
 *
 * 为什么用 STARTF_USESHOWWINDOW + SW_HIDE，而不是 CREATE_NO_WINDOW（Node 的 windowsHide）：
 * 后者会让子进程干脆没有控制台，而 dsh-sandbox-windows-acl 的源码注释明确写了受限令牌下
 * CREATE_NO_WINDOW 的子进程会 STATUS_DLL_INIT_FAILED。隐藏窗口不动控制台，风险最小。
 *
 * 每次启动、以及装/更新运行时之后都会重新检查一遍：dsh 升级会覆盖 node_modules，补丁随之
 * 失效，下次启动自动补回来。上游修好之后，本模块连同调用点一起删掉即可。
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

/** 补丁落在运行时里的哪个文件。 */
const TARGET_RELATIVE = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-win32-process',
  'lib',
  'index.js',
);

/** 打过补丁的文件里必然出现的标记，用来判断是否已经打过。 */
const PATCH_MARKER = 'STARTF_USESHOWWINDOW';

const PATCH_HEADER = `/**
 * 子进程的控制台窗口一律不显示（STARTUPINFO: STARTF_USESHOWWINDOW + SW_HIDE）。
 * 由 DSH 桌面端打补丁（src/runtime-patch.js）：桌面端没有可继承的控制台，
 * 不隐藏窗口的话每条命令都会闪一个黑框。上游修好后这段可以直接删。
 */
const STARTF_USESHOWWINDOW = 1;
const SW_HIDE = 0;
`;

/**
 * 纯文本变换：给每个 STARTUPINFO 的 dwFlags 补上「隐藏窗口」的位。
 * 只认 `dwFlags: <数字>,` 这种形态，不会碰到结构体定义里的 `dwFlags: "uint32",`。
 * @param {string} source - 原始文件内容
 * @returns {{text: string, changed: boolean, reason: 'patched'|'already'|'unrecognized'|'no-startupinfo'}}
 */
function applyConsoleHidePatch(source) {
  if (source.includes(PATCH_MARKER)) return { text: source, changed: false, reason: 'already' };
  if (!/^import koffi from "koffi";/m.test(source)) {
    return { text: source, changed: false, reason: 'unrecognized' };
  }
  if (!/dwFlags: \d+,/.test(source)) return { text: source, changed: false, reason: 'no-startupinfo' };

  const text = source
    .replace(/^import koffi from "koffi";\r?\n/m, (line) => `${line}${PATCH_HEADER}`)
    .replace(/dwFlags: (\d+),/g, 'dwFlags: $1 | STARTF_USESHOWWINDOW, wShowWindow: SW_HIDE,');

  return text === source
    ? { text: source, changed: false, reason: 'no-startupinfo' }
    : { text, changed: true, reason: 'patched' };
}

/**
 * 确保运行时里的闪窗补丁已就位（幂等）。
 * @param {object} [options]
 * @param {(line: string) => void} [options.onLine] - 逐行日志
 * @returns {{status: 'patched'|'already'|'absent'|'unrecognized'|'no-startupinfo'|'failed', file: string}}
 */
function ensureRuntimeConsoleHidden(options = {}) {
  const { onLine } = options;
  const file = path.join(config.runtimeRoot(), TARGET_RELATIVE);
  if (!fs.existsSync(file)) return { status: 'absent', file };

  try {
    const result = applyConsoleHidePatch(fs.readFileSync(file, 'utf8'));
    if (result.changed) {
      fs.writeFileSync(file, result.text, 'utf8');
      onLine?.(`已给 dsh 运行时打上「隐藏控制台窗口」补丁：${file}`);
      return { status: 'patched', file };
    }
    if (result.reason !== 'already') {
      // 结构变了（多半是 dsh 升级换了写法）：不报错，但要让用户知道闪窗可能回来。
      onLine?.(`运行时结构与预期不符，闪窗补丁未生效（${result.reason}）：${file}`);
    }
    return { status: result.reason, file };
  } catch (error) {
    onLine?.(`闪窗补丁写入失败（不影响使用，命令会闪黑框）：${error.message}`);
    return { status: 'failed', file };
  }
}

module.exports = { TARGET_RELATIVE, PATCH_MARKER, applyConsoleHidePatch, ensureRuntimeConsoleHidden };

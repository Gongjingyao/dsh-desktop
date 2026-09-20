'use strict';

/**
 * 给已安装的 dsh 运行时打补丁。
 *
 * 目前两个补丁：
 *
 * 1. 「别弹控制台窗口」：桌面端拉起的 dsh 是 GUI 子系统进程（Electron-as-Node），没有可继承的
 *    控制台；Windows 会给它 CreateProcess 出来的每个控制台子进程（pwsh.exe / cmd.exe）**新建并
 *    显示**一个控制台窗口 —— agent 每跑一条命令，桌面就闪一下黑框。dsh 运行时是 koffi 直接调
 *    CreateProcess，STARTUPINFO 里没给窗口指定显示状态，所以只能在运行时侧补。
 *    为什么用 STARTF_USESHOWWINDOW + SW_HIDE 而不是 CREATE_NO_WINDOW（Node 的 windowsHide）：
 *    后者会让子进程干脆没有控制台，而 dsh-sandbox-windows-acl 的源码注释明确写了受限令牌下
 *    CREATE_NO_WINDOW 的子进程会 STATUS_DLL_INIT_FAILED。隐藏窗口不动控制台，风险最小。
 *
 * 2. 插件列表「功能说明」：设置 → 插件的每一行只显示模块名与 Loader 行 id，没有说明字段。
 *    这里让宿主把插件行 `config.description` 透出到 inventory 响应，并让列表的备注行显示它。
 *    插件行没有该字段时行为不变（仍是原来的行 id）。
 *
 * 每次启动、以及装/更新运行时之后都会重新检查一遍：dsh 升级会覆盖 node_modules，补丁随之
 * 失效，下次启动自动补回来。上游修好之后，本模块连同调用点一起删掉即可。
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

/** 补丁 1 落在运行时里的哪个文件。 */
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

/* ── 补丁 2：插件列表「功能说明」 ────────────────────────────────────────────── */

/** 宿主半边：inventory 响应里补上 description 字段。 */
const INVENTORY_HOST_RELATIVE = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-host-plugin-inventory',
  'lib',
  'index.js',
);
/** 浏览器半边：备注行优先显示 description。 */
const INVENTORY_CLIENT_RELATIVE = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-settings-plugin-inventory',
  'lib',
  'client.js',
);

const INVENTORY_HOST_MARKER = 'description: entry.options.config';
const INVENTORY_CLIENT_MARKER = 'typeof description === "string"';

/** 宿主响应里那条“取插件行 config.description”的表达式（换行符按目标文件现取）。 */
function inventoryHostField(eol) {
  return (
    `,${eol}\t\t\t\t\tdescription: entry.options.config !== null && typeof entry.options.config === "object"` +
    ' && typeof entry.options.config.description === "string" ? entry.options.config.description : null'
  );
}

/**
 * 纯文本变换：给宿主 inventory 的每条 entry 补上 `description`。
 *
 * @param {string} source - 原始文件内容
 * @returns {{text: string, changed: boolean, reason: string}} 变换结果
 */
function applyInventoryHostPatch(source) {
  if (source.includes(INVENTORY_HOST_MARKER)) return { text: source, changed: false, reason: 'already' };
  const anchor = 'fiberPhase: entry.fiber === void 0 ? null : FIBER_PHASE[entry.fiber.state]';
  if (!source.includes(anchor)) return { text: source, changed: false, reason: 'unrecognized' };
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const text = source.replace(anchor, (line) => `${line}${inventoryHostField(eol)}`);
  return text === source
    ? { text: source, changed: false, reason: 'unrecognized' }
    : { text, changed: true, reason: 'patched' };
}

/**
 * 纯文本变换：让插件卡片接住并显示 `description`（没有该字段时退回原来的行 id）。
 *
 * 四处替换：组件解构里接一个新 prop、备注行的内容改成优先用它、两个 PluginCard 调用点
 * 把值传进去。任何一处没匹配上都算失败，避免只补一半导致渲染出 undefined。
 *
 * @param {string} source - 原始文件内容
 * @returns {{text: string, changed: boolean, reason: string}} 变换结果
 */
function applyInventoryClientPatch(source) {
  if (source.includes(INVENTORY_CLIENT_MARKER)) return { text: source, changed: false, reason: 'already' };

  const steps = [
    [
      'function PluginCard({ rowKey, moduleName, entryId, trailing,',
      'function PluginCard({ rowKey, moduleName, entryId, description, trailing,',
    ],
    [
      'children: entrySubtitle(entryId)',
      'children: typeof description === "string" && description !== "" ? description : entrySubtitle(entryId)',
    ],
    [
      /entryId: row\.entryId,\r?\n(\s*)failed,/,
      (match, indent) => `entryId: row.entryId,\n${indent}description: row.description,\n${indent}failed,`,
    ],
    [
      /entryId: entry\.entryId,\r?\n(\s*)failed,/,
      (match, indent) => `entryId: entry.entryId,\n${indent}description: entry.description,\n${indent}failed,`,
    ],
  ];

  let text = source;
  for (const [pattern, replacement] of steps) {
    const next = text.replace(pattern, replacement);
    // 任何一步没匹配上都放弃整份补丁：只补一半会渲染出 undefined。
    if (next === text) return { text: source, changed: false, reason: 'unrecognized' };
    text = next;
  }
  return { text, changed: true, reason: 'patched' };
}

/**
 * 确保运行时里的插件列表「功能说明」补丁已就位（幂等）。
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.onLine] - 逐行日志
 * @returns {Array<{status: string, file: string}>} 每个目标文件的结果
 */
function ensurePluginListDescription(options = {}) {
  const { onLine } = options;
  const targets = [
    { relative: INVENTORY_HOST_RELATIVE, apply: applyInventoryHostPatch, label: '宿主 inventory 透出 description' },
    { relative: INVENTORY_CLIENT_RELATIVE, apply: applyInventoryClientPatch, label: '插件列表显示 description' },
  ];

  return targets.map(({ relative, apply, label }) => {
    const file = path.join(config.runtimeRoot(), relative);
    if (!fs.existsSync(file)) return { status: 'absent', file };
    try {
      const result = apply(fs.readFileSync(file, 'utf8'));
      if (result.changed) {
        fs.writeFileSync(file, result.text, 'utf8');
        onLine?.(`已给 dsh 运行时打上「${label}」补丁：${file}`);
        return { status: 'patched', file };
      }
      if (result.reason !== 'already') {
        // 结构变了（多半是 dsh 升级换了写法）：插件列表回到只显示行 id，不影响其它功能。
        onLine?.(`运行时结构与预期不符，插件列表说明补丁未生效（${result.reason}）：${file}`);
      }
      return { status: result.reason, file };
    } catch (error) {
      onLine?.(`插件列表说明补丁写入失败（不影响使用）：${error.message}`);
      return { status: 'failed', file };
    }
  });
}

/* ── 补丁 3：让「在文件资源管理器中显示」真的弹出窗口 ────────────────────────── */

/** 宿主原生命令运行器：它给每个子进程都加了 windowsHide。 */
const NATIVE_COMMAND_RELATIVE = path.join(
  'node_modules',
  '@deepseek-ai',
  'dsh-native-command',
  'lib',
  'index.js',
);

const NATIVE_COMMAND_MARKER = 'EXPLORER_WINDOW_IS_THE_CHILD';

const NATIVE_COMMAND_ANCHOR = '\t\twindowsHide: true';

/**
 * 纯文本变换：`explorer.exe` 不套 windowsHide。
 *
 * 背景：`revealNativePath` 用 `explorer.exe /select,<file>` 显示文件，而 explorer 的窗口就是
 * 子进程自己的窗口 —— `windowsHide`（CREATE_NO_WINDOW）会把它一起压掉，于是宿主返回成功
 * （explorer 退出码 1 本来就被当作正常交接）、浏览器显示「已请求在文件资源管理器中显示」，
 * 用户却什么都看不见。实测：windowsHide=true 无新窗口，false 弹出窗口。
 *
 * 其余命令保持隐藏：`powershell Invoke-Item` 这类只是"启动器"，被启动的应用是另一个进程，
 * 窗口照常出现；藏掉它们的控制台正是原本想要的效果（否则每条命令闪一下黑框）。
 *
 * @param {string} source - 原始文件内容
 * @returns {{text: string, changed: boolean, reason: string}} 变换结果
 */
function applyNativeOpenVisiblePatch(source) {
  if (source.includes(NATIVE_COMMAND_MARKER)) return { text: source, changed: false, reason: 'already' };
  if (!source.includes(NATIVE_COMMAND_ANCHOR)) return { text: source, changed: false, reason: 'unrecognized' };
  const replacement = [
    '\t\t// explorer.exe 的窗口就是子进程自己，隐藏窗口会连它一起压掉：/select 显示文件毫无反应。',
    '\t\t// DSH 桌面端补丁（src/runtime-patch.js）。',
    `\t\twindowsHide: !/(^|[\\\\/])explorer\\.exe$/i.test(command) /* ${NATIVE_COMMAND_MARKER} */`,
  ].join('\n');
  const text = source.replace(NATIVE_COMMAND_ANCHOR, () => replacement);
  return text === source
    ? { text: source, changed: false, reason: 'unrecognized' }
    : { text, changed: true, reason: 'patched' };
}

/**
 * 确保运行时里的「explorer 窗口不被隐藏」补丁已就位（幂等）。
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.onLine] - 逐行日志
 * @returns {{status: string, file: string}} 结果
 */
function ensureNativeOpenVisible(options = {}) {
  const { onLine } = options;
  const file = path.join(config.runtimeRoot(), NATIVE_COMMAND_RELATIVE);
  if (!fs.existsSync(file)) return { status: 'absent', file };
  try {
    const result = applyNativeOpenVisiblePatch(fs.readFileSync(file, 'utf8'));
    if (result.changed) {
      fs.writeFileSync(file, result.text, 'utf8');
      onLine?.(`已给 dsh 运行时打上「文件管理器窗口可见」补丁：${file}`);
      return { status: 'patched', file };
    }
    if (result.reason !== 'already') {
      onLine?.(`运行时结构与预期不符，「在文件资源管理器中显示」可能仍无反应（${result.reason}）：${file}`);
    }
    return { status: result.reason, file };
  } catch (error) {
    onLine?.(`文件管理器窗口补丁写入失败（不影响其它功能）：${error.message}`);
    return { status: 'failed', file };
  }
}

module.exports = {
  TARGET_RELATIVE,
  PATCH_MARKER,
  applyConsoleHidePatch,
  ensureRuntimeConsoleHidden,
  INVENTORY_HOST_RELATIVE,
  INVENTORY_CLIENT_RELATIVE,
  INVENTORY_HOST_MARKER,
  INVENTORY_CLIENT_MARKER,
  applyInventoryHostPatch,
  applyInventoryClientPatch,
  ensurePluginListDescription,
  NATIVE_COMMAND_RELATIVE,
  NATIVE_COMMAND_MARKER,
  applyNativeOpenVisiblePatch,
  ensureNativeOpenVisible,
};

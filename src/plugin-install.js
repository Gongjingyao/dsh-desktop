'use strict';

/**
 * 把随包发布的 agent-role 插件装进 DSH_HOME（幂等，每次启动都跑）。
 *
 * 为什么要客户端来做这件事：dsh 的插件是从 profile 的 node_modules 按包名解析的，而安装包
 * 把插件放在自己的 app.asar 里 —— 位置对 dsh 毫无意义。所以启动前把它复制到
 * `<DSH_HOME>/profiles/<profile>/node_modules/agent-role/`，并在用户级 patch 层
 * `<DSH_HOME>/cordis.patch.yml` 里确保有那一行。
 *
 * 为什么不建 junction：复制成真实目录后，插件自己的 require（`@deepseek-ai/schemastery`）
 * 可以顺着父目录链走到 `<DSH_HOME>/profiles/node_modules`（dsh 安装时建好的依赖闭包），
 * 既不需要额外的链接，也不怕 junction 被解引用到包内路径。
 *
 * 幂等靠逐字节比对：内容一致就不写盘，所以每次启动几乎零成本，也不会白刷 mtime。
 *
 * @module plugin-install
 */

const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');

/** 插件在 DSH_HOME 里安装成什么包名（必须与 package.json 的 name 一致）。 */
const PLUGIN_NAME = 'agent-role';

/** 随包发布的插件目录（开发态在仓库里，打包后在 app.asar 里）。 */
const BUNDLED_PLUGIN_DIR = path.join(__dirname, '..', 'plugins', 'dsh-plugin-agent-role');

/** 桌面端自己用的 profile；其余已存在的 profile 也一并装上，命令行走 headless 时才有角色。 */
const PRIMARY_PROFILE = 'web';

/** 插件行的 YAML：id 只影响「设置 → 插件」里显示的行身份，name 必须等于包名。 */
const PATCH_BLOCK = `- insert:
    - id: agent-role
      name: agent-role
      config:
        defaultRole: my-default
        description: 会话角色：给当前对话设定 agent 人设，并可在对话中随时切换
`;

/**
 * 递归收集插件要复制的文件（相对路径）。
 *
 * 跳过 `node_modules`：开发态的插件目录里有一个指向安装闭包的 schemastery 链接，
 * 复制它既没意义又会把别处的目录树拖进来。
 *
 * @param {string} root - 插件源目录
 * @returns {string[]} 相对路径列表
 */
function collectFiles(root) {
  const found = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) found.push(relative);
    }
  };
  walk(root, '');
  return found.sort();
}

/**
 * 把插件复制到一个目标目录；内容相同则跳过。
 *
 * @param {string} source - 插件源目录
 * @param {string} target - 目标目录
 * @returns {number} 实际写入的文件数
 */
function copyPlugin(source, target) {
  let written = 0;
  for (const relative of collectFiles(source)) {
    const from = path.join(source, ...relative.split('/'));
    const to = path.join(target, ...relative.split('/'));
    const bytes = fs.readFileSync(from);
    try {
      if (fs.readFileSync(to).equals(bytes)) continue;
    } catch {
      // 目标不存在或读不了：直接写。
    }
    config.ensureDir(path.dirname(to));
    fs.writeFileSync(to, bytes);
    written += 1;
  }
  return written;
}

/**
 * 需要安装到的 profile 目录名：桌面端自己的 profile 一定装，其余已存在的 profile 也装。
 *
 * @param {string} dshHome - DSH_HOME
 * @returns {string[]} profile 名列表
 */
function targetProfiles(dshHome) {
  const names = new Set([PRIMARY_PROFILE]);
  const root = path.join(dshHome, 'profiles');
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // 还没建过 profile：只装 web，dsh 首次启动会自己初始化。
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    if (fs.existsSync(path.join(root, entry.name, 'cordis.yml'))) names.add(entry.name);
  }
  return [...names];
}

/**
 * 取第一行有意义的（非空、非注释）内容，用来判断 patch 文件的顶层形态。
 *
 * @param {string} text - 文件内容
 * @returns {string} 第一行有意义的内容（已 trim），没有则空串
 */
function firstMeaningfulLine(text) {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    return trimmed;
  }
  return '';
}

/**
 * 确保用户级 patch 层里有插件行。
 *
 * 顶层是 loader patch 列表，两种写法都得支持：流式 `[ ... ]`（模板的初始形态）与块式
 * `- insert:`（用户或脚本追加后的常见形态）。形态不认识时放弃并留痕，绝不去改用户的文件。
 *
 * @param {string} dshHome - DSH_HOME
 * @returns {'created'|'present'|'skipped'} 处理结果
 */
function ensurePatchRow(dshHome) {
  const patchPath = path.join(dshHome, 'cordis.patch.yml');
  let text = null;
  try {
    text = fs.readFileSync(patchPath, 'utf8');
  } catch {
    // 没有这份文件：新建。
  }
  if (text === null) {
    config.ensureDir(dshHome);
    fs.writeFileSync(patchPath, PATCH_BLOCK, 'utf8');
    return 'created';
  }
  if (/(^|\n)\s*name:\s*agent-role\s*(\n|$)/.test(text)) return 'present';

  const head = firstMeaningfulLine(text);
  if (head.startsWith('[')) {
    const close = text.lastIndexOf(']');
    if (close < 0) return 'skipped';
    fs.writeFileSync(patchPath, `${text.slice(0, close).replace(/\s+$/, '')}\n${PATCH_BLOCK}${text.slice(close)}`, 'utf8');
    return 'created';
  }
  if (head === '' || head.startsWith('-')) {
    const base = text.replace(/\s+$/, '');
    fs.writeFileSync(patchPath, base === '' ? PATCH_BLOCK : `${base}\n${PATCH_BLOCK}`, 'utf8');
    return 'created';
  }
  return 'skipped';
}

/**
 * 确保随包发布的插件已装进 DSH_HOME（幂等）。
 *
 * @param {object} [options]
 * @param {(line: string) => void} [options.onLine] - 逐行日志
 * @returns {{status: 'installed'|'current'|'absent'|'failed', files: number, profiles: string[], patch: string, dir: string}}
 */
function ensureAgentRolePlugin(options = {}) {
  const { onLine } = options;
  const dir = BUNDLED_PLUGIN_DIR;
  if (!fs.existsSync(dir)) {
    onLine?.(`未找到随包发布的插件目录，跳过安装：${dir}`);
    return { status: 'absent', files: 0, profiles: [], patch: 'skipped', dir };
  }

  const dshHome = config.dshHome();
  try {
    const profiles = targetProfiles(dshHome);
    let files = 0;
    for (const profile of profiles) {
      // 先把 profile 的 node_modules 建出来：全新机器上 dsh 还没有初始化 profile，
      // 提前放好插件，dsh 首次启动就能按包名解析到它（initProfile 只补缺失文件，不会删它）。
      const target = path.join(dshHome, 'profiles', profile, 'node_modules', PLUGIN_NAME);
      config.ensureDir(target);
      files += copyPlugin(dir, target);
    }
    const patch = ensurePatchRow(dshHome);
    if (files > 0) {
      onLine?.(`已把角色插件装进 ${profiles.map((name) => `profiles/${name}`).join('、')}（更新 ${files} 个文件）`);
      return { status: 'installed', files, profiles, patch, dir };
    }
    return { status: 'current', files: 0, profiles, patch, dir };
  } catch (error) {
    onLine?.(`角色插件安装失败（不影响其它功能）：${error.message}`);
    return { status: 'failed', files: 0, profiles: [], patch: 'skipped', dir };
  }
}

module.exports = {
  PLUGIN_NAME,
  BUNDLED_PLUGIN_DIR,
  PATCH_BLOCK,
  collectFiles,
  targetProfiles,
  ensurePatchRow,
  ensureAgentRolePlugin,
};

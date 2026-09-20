'use strict';

/**
 * 从 `plugins/dsh-plugin-agent-role/roles/*.md` 生成 `lib/roles.js` 的「生成区」。
 *
 * 为什么要有这一步：同一份人设有两个消费方 —— 仓库内置表（新机器、还没有 settings 用户层时用）
 * 和 `~/.dsh/settings.yaml`（本机在设置页里编辑的表，由 `_selftest/apply-roles.js` 装配）。
 * 让 `.md` 成为唯一来源、`roles.js` 由它生成，就不存在"改了一处忘了另一处"的漂移。
 * 生成而不是运行时读文件，是为了让插件保持自包含：运行时零新增失败面（文件缺失、打包路径差异等）。
 *
 * 用法：
 *   node scripts/sync-roles.js          # 改了 roles/*.md 之后重新生成
 *   node scripts/sync-roles.js --check  # 只校验是否已同步（提交前 / CI）
 *
 * 兼容 PATH 上的旧 Node（v12）：不用可选链、不用 replaceAll。
 */

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(REPO, 'plugins', 'dsh-plugin-agent-role');
const ROLES_DIR = path.join(PLUGIN_DIR, 'roles');
const ROLES_JS = path.join(PLUGIN_DIR, 'lib', 'roles.js');

/** 生成区标记：脚本只替换这两行之间的内容，其余（校验函数、注释）保持手写。 */
const BEGIN = '// #region 生成区：由 scripts/sync-roles.js 从 roles/*.md 生成，勿手改';
const END = '// #endregion 生成区';

/**
 * 角色清单：顺序即 `/role` 选择器与设置页里的顺序。
 * `note` 是生成到 roles.js 里的那行注释，`constant` 是生成的常量名。
 */
const ROLES = [
  {
    id: 'my-default',
    name: '我的常用角色',
    constant: 'MY_DEFAULT_PROMPT',
    note: '与具体角色、具体项目无关的通用约束，任何会话都适用',
  },
  {
    id: 'frontend-dev',
    name: '前端开发者',
    constant: 'FRONTEND_DEV_PROMPT',
    note: '资深前端工程师的常驻工作准则（原 `~/.dsh/AGENTS.md` 全文）',
  },
  {
    id: 'product-partner',
    name: '需求搭档',
    constant: 'PRODUCT_PARTNER_PROMPT',
    note: '需求沟通与方案调优的常驻部分，动笔细节在 `requirement-analysis` skill 里',
  },
];

/** 默认角色 id（没有显式切换过的会话用它）。 */
const DEFAULT_ROLE_ID = 'my-default';

/** 读一份人设文本；缺文件时明确报错，不静默兜底。 */
function readPrompt(id) {
  const file = path.join(ROLES_DIR, id + '.md');
  if (!fs.existsSync(file)) throw new Error('缺少人设源文件：' + file);
  return fs.readFileSync(file, 'utf8');
}

/** 把文本转成模板字面量：反引号与 `${` 必须转义，尾换行要原样保留。 */
function toTemplateLiteral(text) {
  return '`' + text.split('`').join('\\`').split('${').join('\\${') + '`';
}

/** 生成区内容（不含标记行本身）。 */
function renderRegion() {
  const files = fs
    .readdirSync(ROLES_DIR)
    .filter(function (name) {
      return /\.md$/.test(name);
    })
    .sort();
  const expected = ROLES.map(function (role) {
    return role.id + '.md';
  }).sort();
  if (files.join(',') !== expected.join(',')) {
    throw new Error('roles/ 里的 .md 与脚本里登记的角色不一致：目录 ' + files.join(',') + ' / 登记 ' + expected.join(','));
  }

  const lines = [];
  for (const role of ROLES) {
    const prompt = readPrompt(role.id);
    lines.push('/** 「' + role.name + '」：' + role.note + '。 */');
    lines.push('const ' + role.constant + ' = ' + toTemplateLiteral(prompt) + ';');
    lines.push('');
  }
  lines.push('/** 内置角色表：id -> { name, prompt }。 */');
  lines.push('const BUILTIN_ROLES = {');
  ROLES.forEach(function (role, index) {
    lines.push((index === 0 ? '  [DEFAULT_ROLE_ID]: {' : "  '" + role.id + "': {"));
    lines.push("    name: '" + role.name + "',");
    lines.push('    prompt: ' + role.constant + ',');
    lines.push('  },');
  });
  lines.push('};');
  return lines.join('\n');
}

/** 用生成区替换 roles.js 里的对应片段。 */
function regenerate(current) {
  const beginAt = current.indexOf(BEGIN);
  const endAt = current.indexOf(END);
  if (beginAt < 0 || endAt < 0 || endAt < beginAt) throw new Error('roles.js 里找不到生成区标记，请先补上 BEGIN/END 两行');
  return current.slice(0, beginAt) + BEGIN + '\n' + renderRegion() + '\n' + current.slice(endAt);
}

function main() {
  const current = fs.readFileSync(ROLES_JS, 'utf8');
  const next = regenerate(current);
  const check = process.argv.indexOf('--check') >= 0;

  console.log('角色源：' + path.relative(REPO, ROLES_DIR));
  ROLES.forEach(function (role) {
    console.log('  ' + role.id.padEnd(16) + role.name.padEnd(8) + readPrompt(role.id).length + ' 字符');
  });

  if (next === current) {
    console.log('\nroles.js 已是最新（' + current.length + ' 字符）。');
    return;
  }
  if (check) {
    throw new Error('roles.js 与 roles/*.md 不同步：跑 `npm run roles` 重新生成');
  }
  fs.writeFileSync(ROLES_JS, next, 'utf8');
  console.log('\n已重新生成 ' + path.relative(REPO, ROLES_JS) + '（' + current.length + ' → ' + next.length + ' 字符）。');
}

try {
  main();
} catch (error) {
  console.error('失败：' + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
}

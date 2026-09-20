'use strict';

/**
 * 角色注册表与内置角色。
 *
 * 角色 = 一段注入到系统提示词里的人格/工作准则文本。它与 agent preset（standard /
 * ptc / cordis / minimal）无关：preset 决定工具集，角色只决定"以什么身份和标准干活"，
 * 因此可以在一次对话中途随时切换。
 *
 * 内置角色文本来自用户自己的 `~/.dsh/AGENTS.md`（资深前端工程师工作准则）。
 */

/** 角色 id 规则：能直接当 YAML 键和命令参数用。 */
const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** 内置角色的 id。 */
const DEFAULT_ROLE_ID = 'my-default';

/**
 * 内置角色：把用户 AGENTS.md 里的常驻工作准则整体作为一个人设。
 * 文本按原文件的章节结构排布，便于用户在设置里继续增删。
 */
const DEFAULT_ROLE_PROMPT = `用户把这次会话固定为「我的常用角色」——即下列常驻工作准则。它不是本轮的临时要求，而是贯穿整个会话的工作方式，请始终遵守。

## 一、代码价值观

1. 简洁可读 > 聪明：清晰直白的实现优于炫技；一段代码应让下一个维护者一眼看懂。
2. 非必要不做抽象/封装：只有出现第 2 处真实重复时才提取公共函数/组件/工具；不为"未来可能用到"提前封装。
3. 命名准确直白：变量、函数、组件、文件命名直接表达意图，不缩写到费解。
4. 注释只写"为什么"：不为代码本身写废话注释；复杂处解释意图与约束。
5. 少加依赖：新增 npm/原生依赖前先评估体积、维护成本与替代方案（前端项目尤其敏感）。
6. 沿用项目既有风格：目录约定、组件写法、命名规范跟项目现状走，不另起炉灶。

## 二、任务执行纪律

- 动手前先读相关文件确认现状，不要凭印象改代码；先小范围改动、快速验证，再扩大。
- 每个可验证节点就跑校验：\`tsc --noEmit\` / \`eslint\` / 对应构建；涉及多端则各端确认。
- 完成后自查清单：边界输入与三态（loading/empty/error）、金额精度、请求竞态、不破坏相邻模块。
- 汇报用中文、简洁结构化：改了什么 / 为什么 / 怎么验证的 / 遗留风险。

## 三、委派政策（简单自己做，复杂自动拆派）

直接做，不派活：单文件或小改动（约 <300 行）、无跨模块影响、不需要第二视角、来回 <2 轮。

拆派 subagent（默认动作，无需用户点名），当满足任一：

- 改动跨多文件/多模块，或可拆成 ≥2 个互相独立的并行块；
- 需要多视角独立评审（如安全/性能/跨端/业务正确性）；
- 需要长上下文来回迭代（继续挤在主会话会拖垮上下文）。

拆派纪律：

1. 每个 subagent 指令自包含（它看不到本对话），把背景、输入、输出契约写全；
2. 需要独立结论时声明"你看不到其他评审员，独立下结论"；
3. 输出契约固定（如 \`问题 | 严重度 | 位置 | 修复建议\` 一行式），收齐全部结果再合并，不提前下结论；
4. 返工用 send_message 续聊同一个 subagent（保留其上下文），跑偏用 interrupt 停掉；
5. 合并排序：同一问题被 ≥2 个互不知情的下属命中 = 高置信优先，其余按 影响 × 概率 × 修复成本 排序。

## 四、可用场景资产（命中自动加载，也可直接 /name 手动触发）

- \`/frontend-code-review\`：多视角代码评审（安全/性能/跨端/状态）。
- \`/frontend-perf-audit\`：性能优化专项审计（定基线 → 3 域并行 → ROI 排序）。
- \`/parallel-module-build\`：大需求拆解并行实现（契约先行 → 模块并行 → 汇合联调）。

这些 skill 只提供流程与契约，不重复上述价值观；两者冲突时以上述价值观与用户当场要求为准。`;

/** 内置角色表：id -> { name, prompt }。 */
const BUILTIN_ROLES = {
  [DEFAULT_ROLE_ID]: {
    name: '我的常用角色',
    prompt: DEFAULT_ROLE_PROMPT,
  },
};

/**
 * 校验一份角色定义并归一化。
 *
 * @param {unknown} id - 角色 id
 * @param {unknown} value - `{ name, prompt }`
 * @returns {{name: string, prompt: string}} 归一化后的角色
 * @throws 当 id 或角色内容不合法时抛出，调用方负责报错给用户
 */
function normalizeRole(id, value) {
  if (typeof id !== 'string' || !ROLE_ID_PATTERN.test(id)) {
    throw new Error(`角色 id 必须是 ${ROLE_ID_PATTERN}（小写字母、数字、连字符），得到 ${JSON.stringify(id)}`);
  }
  if (value === null || typeof value !== 'object') {
    throw new Error(`角色 "${id}" 的定义必须是 { name, prompt } 对象`);
  }
  const { name, prompt } = value;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error(`角色 "${id}" 缺少非空的 name`);
  }
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw new Error(`角色 "${id}" 缺少非空的 prompt`);
  }
  return { name: name.trim(), prompt };
}

/**
 * 校验整张角色表：id 合法、至少有一个角色、prompt 非空。
 *
 * @param {unknown} roles - 角色表
 * @returns {Record<string, {name: string, prompt: string}>} 归一化后的角色表
 * @throws 当角色表为空或任一条目不合法时抛出
 */
function normalizeRoleTable(roles) {
  if (roles === null || typeof roles !== 'object' || Array.isArray(roles)) {
    throw new Error('roles 必须是一个对象：{ 角色id: { name, prompt } }');
  }
  const entries = Object.entries(roles);
  if (entries.length === 0) throw new Error('roles 至少要有一个角色，否则无法选择');
  return Object.fromEntries(entries.map(([id, value]) => [id, normalizeRole(id, value)]));
}

module.exports = {
  ROLE_ID_PATTERN,
  DEFAULT_ROLE_ID,
  BUILTIN_ROLES,
  normalizeRoleTable,
};

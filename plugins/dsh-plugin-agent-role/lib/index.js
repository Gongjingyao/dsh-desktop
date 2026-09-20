'use strict';

/**
 * dsh-plugin-agent-role —— 会话角色（人设）插件·宿主半边。
 *
 * 它解决一个 agent preset 解决不了的问题：preset 决定工具集，只能在会话创建时
 * 选定，中途换会留下新工具集无法重放的 tool call；而"角色"只改系统提示词里的人设
 * 文本，可以随时切换。所以本插件挂在宿主平面（compose 在 dsh-base 之后），对
 * standard / ptc / cordis / minimal 每个 preset 下的会话同时生效。
 *
 * 四个面：
 * 1. `role/selected` 会话事件 + `role` 投影 —— 角色选择随会话日志持久化，resume /
 *    fork 自动恢复；
 * 2. `deployment:role` 动态提示词段落 —— 每次模型请求装配时按当前会话角色求值，
 *    因此切换后的下一条消息立即生效（与 `dsh-plan-mode` 的 `plan:policy` 同构）；
 * 3. `/role` 人类命令 —— `ctx.commands` 注册，浏览器半边据此挂出选择器；
 * 4. `agent-role` 设置命名空间 —— 角色表本身可在 GUI 里增删改，写进
 *    `<DSH_HOME>/settings.yaml`，live 生效。
 *
 * 角色表是分层的：loader 行里的 `config.roles` 是 composition base，设置文档是用户层；
 * 未挂 settings（自定义 composition）时只用前者。设置分层是递归合并，用户层删不掉 base
 * 的键，所以用户层一旦声明了 `roles` 就以它为准（否则设置页里删角色会原地复活）。
 *
 * @module dsh-plugin-agent-role
 */

/**
 * schemastery 只用于「设置 → 角色」那一页的 schema。它在 dsh 的依赖闭包里，正常一定存在；
 * 万一被裁掉，缺的应该只是设置页，而不是让整个角色功能（甚至 dsh 启动）失败 —— 所以这里
 * 允许它缺失，缺了就跳过设置注册并留一条 warn。
 */
let Schema = null;
try {
  Schema = require('@deepseek-ai/schemastery');
} catch {
  Schema = null;
}

const {
  BUILTIN_ROLES,
  DEFAULT_ROLE_ID,
  ROLE_ID_PATTERN,
  normalizeRoleTable,
} = require('./roles');

/** Cordis 插件名。 */
const name = 'agent-role';

/** 角色选择事件的类型名。日志兼容性靠 `ignorable: true` 标记，见 README。 */
const ROLE_EVENT = 'role/selected';

/** `role` 投影键。 */
const ROLE_PROJECTION = 'role';

/**
 * 提示词段落名。用独立名字而不是去遮蔽 `deployment:persona-prefix`：那个槽位已经
 * 被 agent preset 的 persona 行占着，宿主平面重复注册同名段落会直接报错。
 */
const ROLE_SECTION = 'deployment:role';

/** 段落排序：紧跟人设前缀（0）之后，先于所有工具引导。 */
const ROLE_SECTION_ORDER = 100;

/** `/role` 命令名。 */
const ROLE_COMMAND = 'role';

/** 角色表的设置命名空间（浏览器设置页读写它）。 */
const SETTINGS_NAMESPACE = 'agent-role';

/**
 * 投影的持久化状态校验。`dsh-session-projection` 只要求一个带 `parse()` 的
 * schema（`parse(value) -> value` 或抛错），所以这里不需要引入 zod。
 */
const ROLE_STATE_SCHEMA = {
  parse(value) {
    if (value === null || typeof value !== 'object' || typeof value[ROLE_PROJECTION] !== 'string') {
      throw new Error(`role 投影状态必须是 { role: string }，得到 ${JSON.stringify(value)}`);
    }
    return value;
  },
};

/** 投影的客户端视图校验，同样只需 `parse()`。 */
const ROLE_VIEW_SCHEMA = {
  parse(value) {
    if (value === null || typeof value !== 'object' || typeof value.current !== 'string' || !Array.isArray(value.options)) {
      throw new Error('role 投影视图必须是 { current, options }');
    }
    return value;
  },
};

/**
 * 角色表的设置 schema（schemastery）。用真正的 schema 而不是"整段 JSON 塞字符串"，
 * 是为了让 `settings.yaml` 保持人能直接读写的形状。schemastery 缺失时为 null。
 */
const ROLES_SETTINGS_SCHEMA = Schema === null
  ? null
  : Schema.object({
    roles: Schema.dict(
      Schema.object({
        name: Schema.string(),
        prompt: Schema.string(),
      }),
    ),
    defaultRole: Schema.string(),
  });

/**
 * 校验插件配置。刻意手写而不是用 schemastery：config 只有两个字段，报错信息比
 * schema 的默认报错更直白。
 *
 * @param {unknown} raw - loader 传进来的 config
 * @returns {{roles: Record<string, {name: string, prompt: string}>, defaultRole: string}} 归一化配置
 * @throws 配置非法时在加载期明确报错（fail loud，不做静默兜底）
 */
function resolveConfig(raw) {
  const config = raw === null || raw === undefined ? {} : raw;
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${name}: config 必须是一个对象`);
  }
  const unknown = Object.keys(config).filter((key) => key !== 'roles' && key !== 'defaultRole' && key !== 'description');
  if (unknown.length > 0) {
    throw new Error(`${name}: config 出现未知字段 ${unknown.join(', ')}（只接受 roles、defaultRole、description）`);
  }
  const roles = normalizeRoleTable(config.roles ?? BUILTIN_ROLES);
  const defaultRole = config.defaultRole ?? DEFAULT_ROLE_ID;
  if (typeof defaultRole !== 'string' || !Object.hasOwn(roles, defaultRole)) {
    throw new Error(
      `${name}: defaultRole ${JSON.stringify(defaultRole)} 不在角色表里（可选：${Object.keys(roles).join(', ')}）`,
    );
  }
  return { roles, defaultRole };
}

/**
 * 注册角色服务。
 *
 * 服务本身不发布成 `ctx.<名字>`：没有任何其它插件需要依赖它，命令、段落、投影、
 * 设置都在本函数作用域内注册，随 fiber 一起释放。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - 宿主平面上下文
 * @param {unknown} rawConfig - loader 传进来的 config
 */
function apply(ctx, rawConfig) {
  /** composition base：loader 行里声明的角色表。 */
  const base = resolveConfig(rawConfig);

  /**
   * 设置文档解析后的值（schema 默认 → composition base → 用户层）。没挂 settings
   * 时保持 composition base。
   */
  let resolved = () => base;

  /**
   * 用户在设置文档里显式写下的角色表（原始用户层，不看 base）。
   *
   * 之所以要单独拿它：设置分层是**递归合并**普通对象，用户层能加/改键，却删不掉
   * base 里的键。若直接吃合并后的值，设置页里"删除"一个内置角色会在保存后原地复活。
   * 所以用户层一旦声明了 roles，就以它为准；把整份节删掉即回落到 base。
   */
  let userLayer = null;

  /**
   * 把权威值收敛成一份"可以放心用"的表：过滤掉手改 `settings.yaml` 可能写坏的
   * 条目，并保证 `defaultRole` 一定命中表内 id。
   *
   * 收敛放在这一个地方，是为了让段落、命令、投影视图三个消费方都不必各自防错 ——
   * 提示词段落尤其不能抛错，抛一次就会让每个模型请求都失败。
   *
   * @returns {{roles: Record<string, {name: string, prompt: string}>, ids: string[], defaultRole: string}|undefined} 空表或不可用时 undefined
   */
  const tableOf = () => {
    const current = userLayer ?? resolved();
    const roles = current !== null && typeof current === 'object' ? current.roles : undefined;
    if (roles === null || typeof roles !== 'object') return undefined;
    const usable = {};
    for (const [id, role] of Object.entries(roles)) {
      if (!ROLE_ID_PATTERN.test(id)) continue;
      if (role === null || typeof role !== 'object') continue;
      if (typeof role.name !== 'string' || typeof role.prompt !== 'string') continue;
      if (role.name.trim() === '' || role.prompt.trim() === '') continue;
      usable[id] = { name: role.name, prompt: role.prompt };
    }
    const ids = Object.keys(usable);
    if (ids.length === 0) return undefined;
    // 用户层只写了 roles 时（手改文档），默认角色仍从解析值里取。
    const wanted = typeof current.defaultRole === 'string' ? current.defaultRole : resolved()?.defaultRole;
    return { roles: usable, ids, defaultRole: ids.includes(wanted) ? wanted : ids[0] };
  };

  /**
   * 读取一个会话当前生效的角色 id。
   *
   * 投影里空字符串表示"这个会话从没显式切换过"，此时跟随当前配置的默认角色 ——
   * 而不是把创建时的默认值钉死，否则改默认角色对已有会话永远不生效。
   * 日志里选中的角色也可能已经被删掉（会话先记录、配置后修改），同样回落到默认角色。
   *
   * @param {object} session - 会话
   * @returns {string|undefined} 角色 id；角色表不可用时 undefined
   */
  const roleIdOf = (session) => {
    const table = tableOf();
    if (table === undefined) return undefined;
    const selected = ctx.sessionProjections.stateOf(session, ROLE_PROJECTION)?.[ROLE_PROJECTION];
    return typeof selected === 'string' && selected !== '' && table.ids.includes(selected) ? selected : table.defaultRole;
  };

  /** 取角色定义；表不可用时返回 undefined，由调用方兜底。 */
  const roleOf = (session) => {
    const table = tableOf();
    const id = roleIdOf(session);
    return table === undefined || id === undefined ? undefined : table.roles[id];
  };

  ctx.sessionProjections.register({
    key: ROLE_PROJECTION,
    // 2：init 从"创建时的默认角色"改成"空串=没选过"，fold 语义变了要作废旧缓存行。
    stateVersion: 2,
    stateSchema: ROLE_STATE_SCHEMA,
    init: () => ({ [ROLE_PROJECTION]: '' }),
    apply: (state, event) => {
      if (event.type !== ROLE_EVENT) return state;
      const roleId = event.data?.role;
      if (typeof roleId !== 'string' || roleId === state[ROLE_PROJECTION]) return state;
      return { [ROLE_PROJECTION]: roleId };
    },
    wire: {
      viewSchema: ROLE_VIEW_SCHEMA,
      // 每次都返回新对象：注册表按引用比较判断视图是否变化，缓存对象会吞掉切换。
      view: (state) => {
        const table = tableOf();
        if (table === undefined) return { current: '', options: [] };
        const selected = table.ids.includes(state[ROLE_PROJECTION]) ? state[ROLE_PROJECTION] : table.defaultRole;
        return {
          current: selected,
          options: table.ids.map((id) => ({ id, name: table.roles[id].name })),
        };
      },
    },
  });

  ctx.systemPrompt.section({
    name: ROLE_SECTION,
    order: ROLE_SECTION_ORDER,
    text: (context) => {
      const agent = context.agent;
      if (agent === undefined || agent === null) return '';
      const role = roleOf(agent.session);
      // 角色表被清空时保持空段落而不是抛错：宁可这一轮没有人设，也不能让请求整体失败。
      return role === undefined ? '' : `## 当前会话角色：${role.name}\n\n${role.prompt}`;
    },
  });

  if (ROLES_SETTINGS_SCHEMA === null) {
    ctx.logger?.warn(`${name}: 找不到 @deepseek-ai/schemastery，跳过「设置 → 角色」页（角色本身不受影响）`);
  } else {
    ctx.inject(['settings'], (settingsCtx) => {
      const settings = settingsCtx.settings;

      /**
       * 读设置文档里的原始用户层。用户层声明了 roles 时它就是权威表 —— 合并语义
       * 让用户层删不掉 base 的键，不吃原始用户层的话设置页的"删除"会失效。
       *
       * @returns {{roles: Record<string, {name: string, prompt: string}>, defaultRole: string|undefined}|null} 用户层未声明 roles 时 null
       */
      const readUserLayer = () => {
        const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE);
        const user = descriptor === undefined ? undefined : descriptor.user;
        const roles = user !== null && typeof user === 'object' ? user.roles : undefined;
        if (roles === null || typeof roles !== 'object') return null;
        return { roles, defaultRole: typeof user.defaultRole === 'string' ? user.defaultRole : undefined };
      };

      // 刻意不挂 validate：它在**注册期**就会跑，手改 settings.yaml 写坏一个字段会让
      // 整个 installSection 抛错、接线被静默吞掉，反而更难查。坏值一律交给 tableOf()
      // 过滤 + 兜底，写入侧的校验由设置页在保存前完成。
      try {
        settings.installSection(
          ctx,
          SETTINGS_NAMESPACE,
          ROLES_SETTINGS_SCHEMA,
          { roles: base.roles, defaultRole: base.defaultRole },
          {
            // 挂上/卸下设置文档时拿到解析值的 thunk；段落与命令都按需读取它。
            setSource: (current) => {
              resolved = current;
              userLayer = readUserLayer();
            },
            onChange: () => {
              userLayer = readUserLayer();
            },
          },
        );
      } catch (error) {
        // 设置这一路挂了不该影响角色本身可用：退回 composition base，但要在日志里留痕。
        ctx.logger?.warn(`${name}: 设置命名空间注册失败，角色表退回 composition base：%o`, error);
      }
    });
  }

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: ROLE_COMMAND,
      description: '查看或切换当前会话的 agent 角色',
      input: { hint: '[角色id]' },
      handler: ({ agent, rawInput }) => {
        const table = tableOf();
        if (table === undefined) {
          return { kind: 'error', text: '角色表为空或不可用，请先在「设置 → 角色」里配置至少一个角色。' };
        }
        const current = roleIdOf(agent.session) ?? table.defaultRole;
        const wanted = rawInput.trim();
        if (wanted === '') {
          const list = table.ids
            .map((id) => (id === current ? `* ${id}（${table.roles[id].name}）` : `  ${id}（${table.roles[id].name}）`))
            .join('\n');
          return { kind: 'success', text: `当前角色：${table.roles[current].name}\n可选角色：\n${list}` };
        }
        if (!table.ids.includes(wanted)) {
          return { kind: 'error', text: `未知角色 "${wanted}"（可选：${table.ids.join(', ')}）` };
        }
        if (wanted === current) {
          return { kind: 'success', text: `当前已经是角色 ${table.roles[wanted].name}，未做改动。` };
        }
        agent.session.append(ROLE_EVENT, { role: wanted, ignorable: true });
        return { kind: 'success', text: `已切换到角色 ${table.roles[wanted].name}，从下一步模型请求开始生效。` };
      },
    });
  });
}

module.exports = {
  name,
  apply,
  inject: ['systemPrompt', 'sessionProjections'],
  Config: undefined,
  ROLE_EVENT,
  ROLE_PROJECTION,
  ROLE_SECTION,
  ROLE_COMMAND,
  SETTINGS_NAMESPACE,
  ROLES_SETTINGS_SCHEMA,
  resolveConfig,
};

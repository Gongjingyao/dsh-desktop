# agent-role —— DSH 会话角色插件

给当前对话设置一个 **agent 角色**（人设），并且可以**随时切换**。角色与模式和工具集无关：无论会话跑在
`standard` / `ptc` / `cordis` / `minimal` 哪个 agent preset 下，同一个角色都能用。

## 它解决什么问题

DSH 的「模式」就是 agent preset，它决定工具集 + 提示词，**只能在会话创建时选定**——中途换会让已记录的
tool call 找不到对应工具，所以官方不支持会话中途切换 preset。

而「角色」只改系统提示词里的人设文本，不需要动工具集，因此可以中途切换。本插件就是按这个思路做的：

- 角色状态随会话日志持久化（`role/selected` 事件 + `role` 投影），resume / fork 会自动恢复；
- 人设段落 `deployment:role` 是**动态段落**，每次模型请求装配时按当前会话角色求值，所以切换后
  下一条消息就生效（与 `dsh-plan-mode` 的 `plan:policy` 同构）；
- 挂在宿主平面（`~/.dsh/cordis.patch.yml`）而不是某个 preset 里，所以对每个 preset 下的会话
  同时生效。

## 用法

### 对话里切换

在输入框输入 `/role`，会弹出角色选择器；选中即切换。当前角色带 `*` 标记。

### 对话里看当前角色

输入框工具行左侧（Plan 芯片左边）有一个只读小标签，形如 `角色：我的常用角色`，实时显示**这个会话**
当前生效的角色：切换后随投影推送立即更新，没显式切换过的会话显示默认角色。鼠标悬停有完整提示。

它读的是宿主按会话日志折出来的 `role` 投影，不自己维护状态，所以不会和真实生效的角色不一致；
投影不可用（宿主半边没加载、会话未就绪）时整个标签不渲染。

### 命令

```
/role                 # 列出当前角色和可选角色
/role my-default      # 切到指定角色
```

### 在设置页里增删改角色

**设置 → 角色**分两级：

- **一级：角色列表**，每行只有一个角色名称（没有 id、没有人设文本），点进去编辑；列表上方是
  **默认角色**下拉（没有显式切换过的会话用它），候选项同样只显示名称。新增角色在这里，点完直接
  进入新角色的二级页。
- **二级：单个角色**，显示这个角色的 id（只读）、名称、人设文本，以及「删除」（至少保留一个）
  和「‹ 角色列表」返回。删除后自动退回一级。

「保存 / 撤销改动」两级都在，作用于整张角色表。改完点「保存」写进 `<DSH_HOME>/settings.yaml`，
立即生效（下一次模型请求即可见）。

编辑留在本地草稿，保存才整表写回：输入过程中不会每敲一个字就写一次文件，也不会因为半成品
（新角色还没填人设）被拒绝。

### 配置角色（改配置文件）

角色也可以直接写在 loader 行的 `config.roles` 里（`角色id: { name, prompt }`），
设置页的保存结果会覆盖它。`defaultRole` 指定默认用哪个：

```yaml
- insert:
    - id: agent-role
      name: agent-role
      config:
        defaultRole: my-default
        roles:
          my-default:
            name: 我的常用角色
            prompt: |
              用户把这次会话固定为「我的常用角色」……（此处是完整的人设文本）
          reviewer:
            name: 严格评审员
            prompt: |
              你只做代码评审，不写实现。逐条列出问题并标注严重度。
```

`roles` 省略时使用内置的**「我的常用角色」**（内容取自 `~/.dsh/AGENTS.md` 的常驻工作准则）。
角色 id 必须匹配 `[a-z0-9][a-z0-9-]*`。

**`description` 字段**显示在「设置 → 插件」那一行的备注里（不写就照旧显示 loader 行 id）。
它由桌面端的运行时补丁透出，见下文「插件列表里的功能说明」。

**分层与"删除"语义**：loader 行里的 `roles` 是 composition base，`settings.yaml` 的 `agent-role` 段是
用户层。用户层一旦声明了 `roles`，就以它为准（设置页首次保存会把当时的表整体写进用户层）——
否则设置分层是递归合并、用户层删不掉 base 里的键，删掉的内置角色会在保存后复活。
把 `settings.yaml` 里的 `agent-role:` 整段删掉即回退到 composition base。

**坏文档不会让角色失灵**：手改 `settings.yaml` 写出非法 id、空名称、不存在的 `defaultRole` 时，
坏条目会被忽略、`defaultRole` 回落到表内第一个角色；整张表为空则这一轮不注入角色段落，
而不是让模型请求整体失败。

## 插件列表里的功能说明

「设置 → 插件」每一行原本只显示模块名（`agent-role`）与 Loader 行 id，没有任何说明字段 ——
这个列表由 shipped 包 `dsh-client-ui-settings-plugin-inventory` 渲染，数据来自
`dsh-host-plugin-inventory` 的 `pluginInventory/list`。

桌面端因此打了一个运行时补丁（`src/runtime-patch.js` 的 `ensurePluginListDescription`）：

1. 宿主半边在每条 entry 上补 `description`，取自该插件行 `config.description`；
2. 浏览器半边让备注行优先显示它，没有该字段时退回原来的行 id（其它插件行为不变）。

于是本插件的行写成：

```yaml
- insert:
    - id: agent-role
      name: agent-role
      config:
        defaultRole: my-default
        description: 会话角色：给当前对话设定 agent 人设，并可在对话中随时切换
```

插件自己不用这个字段（`resolveConfig` 只是放行它）。补丁幂等、每次启动自动重打；dsh 升级后若上游
改了这两处写法，补丁会检测到并只打日志，列表退回显示行 id，不影响其它功能。

## 安装

插件目录以 junction / 依赖的形式暴露给 profile，然后在 `~/.dsh/cordis.patch.yml` 插入 loader 行。

用仓库里的脚本一键装好：

```powershell
powershell -File scripts\install-agent-role.ps1
```

或者手工两步：

1. 让 dsh 能按包名解析到这个包（二选一）：
   - 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 里加
     `"agent-role": "file:C:/path/to/plugins/dsh-plugin-agent-role"`，再在该目录跑 `npm install`；
   - 或直接在 `~/.dsh/profiles/web/node_modules/agent-role` 建一个指向本目录的 junction。
   **别忘了插件自己的依赖**：以 junction/符号链接安装时，Node 会把模块解引用到本目录的真实路径，
   于是 `require('@deepseek-ai/schemastery')` 会去工作区的 node_modules 链里找、找不到。
   所以还要建 `plugins/dsh-plugin-agent-role/node_modules/@deepseek-ai/schemastery`
   → `~/.dsh/profiles/node_modules/@deepseek-ai/schemastery` 的 junction（安装脚本会自动做）。
2. 在 `~/.dsh/cordis.patch.yml` 里插入：

```yaml
- insert:
    - id: agent-role
      name: agent-role
      config:
        defaultRole: my-default
```

改完重启桌面端（或重启 `dsh` 进程）生效（改的是插件代码时才需要；只改 `settings.yaml`
或 `cordis.patch.yml` 是热生效的）。


## 关键约束（踩过的坑）

**loader 行里的 `name` 必须与插件 `package.json` 的 `name` 完全一致。**

`dsh-client-modules` 定位插件包时，会用行里的 specifier 去解析模块，再向上找 `package.json`，并
**要求 manifest 的 `name` 等于该 specifier**；不一致时它把这行当成"没有客户端半边"静默跳过——
宿主半边照常工作，浏览器里却永远看不到选择器，且没有任何报错。所以：
`name: agent-role` ↔ `"name": "agent-role"`。

其它实现细节：

- 段落用独立名字 `deployment:role`，**刻意不去遮蔽** `deployment:persona-prefix`：那个槽位由
  agent preset 的 persona 行占着，宿主平面重复注册同名段落会直接报错。
- 段落排序 `100`，紧跟人设前缀（`0`）之后、先于所有工具引导。
- 事件带 `ignorable: true`：本插件的事件类型不在 DSH 的 `KNOWN_SESSION_EVENT_TYPES` 里，
  没有这个标记的话，resume 时会因为"日志里有本构建不认识的必读事件"而拒绝读取会话。
- 投影里**空字符串表示"这个会话从没显式切换过"**（`stateVersion: 2`），此时跟随当前配置的默认
  角色。若把创建时的默认值钉进投影，改默认角色对已有会话就永远不生效。
- 设置命名空间**不挂 `validate`**：它在注册期就会跑，手改 `settings.yaml` 写坏一个字段会让整个
  `installSection` 抛错、接线被 cordis 静默吞掉（症状是设置页空着、角色却仍是 base），比降级更难查。
- 插件以 junction 安装时 Node 会解引用到真实路径，插件自己的依赖必须在插件目录下有链接
  （见「安装」一节），否则启动报 `Cannot find module '@deepseek-ai/schemastery'`。

## 文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 宿主半边：角色服务、`role` 投影、`/role` 命令、`deployment:role` 动态段落、设置命名空间 |
| `lib/roles.js` | 内置角色与角色表校验 |
| `lib/client.js` | 浏览器半边：`/role` 弹出选择器 + 输入框工具行的当前角色标签（`conversation.input.left` 插槽，`useProjection("role")`）+ 两级「角色」设置页 |


window.__ModuleLoader__.load({
	id: "agent-role",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const el = react.createElement;

		//#region lib/types/client/locales.js
		/** `/role` 选择器与会话内指示器的文案。设置页的文案直接写在组件里，不走 locale。 */
		const zh = {
			"option.unavailable": "角色服务在当前宿主不可用",
			"option.missing": "角色列表尚未就绪，请先打开一次会话",
			"command.failed": "切换角色失败",
			"command.unsupported": "当前宿主没有提供 /role 命令",
			"chip.label": "角色",
			"chip.title": "当前会话角色",
		};
		const en = {
			"option.unavailable": "The role service is not available on this host",
			"option.missing": "The role list is not ready yet; open a session first",
			"command.failed": "Role switch failed",
			"command.unsupported": "This host offers no /role command",
			"chip.label": "Role",
			"chip.title": "Current session role",
		};
		//#endregion

		//#region lib/types/client/index.js
		/** 角色表的设置命名空间，与宿主半边的 SETTINGS_NAMESPACE 一致。 */
		const SETTINGS_NAMESPACE = "agent-role";
		/** 角色 id 规则，与 `lib/roles.js` 里的校验保持一致（客户端先拦，省一次往返）。 */
		const ROLE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

		/**
		 * 需要的客户端服务（cordis fiber inject）。
		 *
		 * 一律走**插件级 inject**：shipped 的设置类插件（`ui-permission-presets`、
		 * `ui-agent-preset`）都是这么声明的。把 `settingsScope` 放进 `ctx.inject(...)`
		 * 的嵌套作用域会拿不到可用实例，回调不触发、section 静默不注册。
		 */
		const inject = [
			"commandUi",
			"sessions",
			"locale",
			"slots",
			"remote",
			"remote.settings",
			"settingsScope",
		];

		/**
		 * 读一个会话的 `role` 投影视图（宿主半边注册的 wire view）。
		 *
		 * @param {object|undefined} session - 已绑定的实时会话
		 * @returns {{current: string, options: Array<{id: string, name: string}>}|undefined} 视图，未就绪时 undefined
		 */
		function roleViewOf(session) {
			const value = session?.projections?.faceOf("role")?.getSnapshot();
			if (value === null || typeof value !== "object") return undefined;
			if (typeof value.current !== "string" || !Array.isArray(value.options)) return undefined;
			return value;
		}

		/**
		 * 把投影视图摊平成选择器条目（设置命名空间还没拿到时的兜底）。
		 *
		 * @param {{current: string, options: Array<{id: string, name: string}>}} view - 角色投影视图
		 * @returns {Array<{id: string, label: string, active?: true}>} 选择器条目
		 */
		function optionsFromView(view) {
			return view.options.map((option) => ({
				id: option.id,
				label: option.name,
				...(option.id === view.current ? { active: true } : {}),
			}));
		}

		/**
		 * 取当前生效的角色表。
		 *
		 * 用户层声明了 `roles` 时以它为准：设置分层是递归合并，用户层删不掉 composition
		 * base 里的键，直接读合并后的 `value` 会让刚删掉的内置角色又出现在列表里。
		 * 用户层没有该字段（用户从没保存过）时才回落到 `value`。
		 *
		 * @param {{value?: unknown, user?: unknown}|undefined} namespaceView - 设置命名空间视图
		 * @returns {{roles: Record<string, {name: string, prompt: string}>|undefined, defaultRole: string|undefined}} 角色表与默认角色
		 */
		function effectiveTable(namespaceView) {
			if (namespaceView === undefined || namespaceView === null) return { roles: undefined, defaultRole: undefined };
			const user = namespaceView.user !== null && typeof namespaceView.user === "object" ? namespaceView.user : undefined;
			const value = namespaceView.value !== null && typeof namespaceView.value === "object" ? namespaceView.value : undefined;
			const source = user !== undefined && user.roles !== null && typeof user.roles === "object" ? user : value;
			const roles = source !== undefined && source.roles !== null && typeof source.roles === "object" ? source.roles : undefined;
			const defaultRole = source !== undefined && typeof source.defaultRole === "string" ? source.defaultRole : undefined;
			return { roles, defaultRole };
		}

		/**
		 * 从设置文档的实时角色表摊平选择器条目。
		 *
		 * 选择器的候选取自设置而不是投影：投影只在新事件落到会话日志时推送，而新增角色
		 * 不会产生会话事件，取投影的话新角色要等到下一次切换才出现在列表里。
		 *
		 * @param {{value?: unknown, user?: unknown}|undefined} namespaceView - 设置命名空间视图
		 * @param {string|undefined} currentId - 当前会话角色 id
		 * @returns {Array<{id: string, label: string, active?: true}>|undefined} 角色表不可用时 undefined
		 */
		function optionsFromSettings(namespaceView, currentId) {
			const { roles } = effectiveTable(namespaceView);
			if (roles === undefined) return undefined;
			const ids = Object.keys(roles);
			if (ids.length === 0) return undefined;
			return ids.map((id) => ({
				id,
				label: typeof roles[id]?.name === "string" && roles[id].name.trim() !== "" ? roles[id].name : id,
				...(id === currentId ? { active: true } : {}),
			}));
		}
		//#endregion

		//#region lib/types/client/RoleSettingsSection.js
		/**
		 * 设置页样式。全部走内联样式 + 中性灰透明度，不依赖设计 token 或 CSS 模块，
		 * 因此在亮色/暗色主题下都能用，也不需要引入 UI 基元包。
		 */
		const S = {
			root: { display: "flex", flexDirection: "column", gap: "16px", padding: "4px 2px", fontSize: "13px", color: "inherit" },
			intro: { display: "flex", flexDirection: "column", gap: "4px" },
			heading: { fontSize: "15px", fontWeight: 600 },
			desc: { opacity: 0.72, lineHeight: 1.6 },
			card: { display: "flex", flexDirection: "column", gap: "8px", padding: "12px", border: "1px solid rgba(127,127,127,0.28)", borderRadius: "8px" },
			cardHead: { display: "flex", alignItems: "center", gap: "8px" },
			idTag: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px", opacity: 0.66, padding: "1px 6px", border: "1px solid rgba(127,127,127,0.3)", borderRadius: "999px" },
			spacer: { flex: 1 },
			label: { fontSize: "12px", opacity: 0.72 },
			input: { background: "transparent", color: "inherit", border: "1px solid rgba(127,127,127,0.4)", borderRadius: "6px", padding: "6px 8px", font: "inherit", width: "100%", boxSizing: "border-box" },
			textarea: { background: "transparent", color: "inherit", border: "1px solid rgba(127,127,127,0.4)", borderRadius: "6px", padding: "8px", font: "inherit", lineHeight: 1.6, minHeight: "140px", resize: "vertical", width: "100%", boxSizing: "border-box" },
			button: { background: "transparent", color: "inherit", border: "1px solid rgba(127,127,127,0.45)", borderRadius: "6px", padding: "5px 12px", font: "inherit", cursor: "pointer" },
			buttonQuiet: { background: "transparent", color: "inherit", border: "1px solid transparent", borderRadius: "6px", padding: "4px 8px", font: "inherit", cursor: "pointer", opacity: 0.72 },
			footer: { display: "flex", alignItems: "center", gap: "10px", paddingTop: "4px" },
			error: { color: "#d9534f", lineHeight: 1.6 },
			ok: { opacity: 0.66 },
			list: { display: "flex", flexDirection: "column", gap: "8px" },
			row: { display: "flex", alignItems: "center", gap: "8px", padding: "8px 12px", border: "1px solid rgba(127,127,127,0.28)", borderRadius: "8px", background: "transparent", color: "inherit", font: "inherit", textAlign: "left", cursor: "pointer" },
			rowName: { flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
			caret: { opacity: 0.5 },
			chip: { display: "inline-flex", alignItems: "center", maxWidth: "200px", padding: "2px 8px", border: "1px solid rgba(127,127,127,0.35)", borderRadius: "999px", fontSize: "12px", lineHeight: "18px", opacity: 0.85, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" },
		};

		/**
		 * 归一化一份设置视图成可编辑草稿，顺手挡掉手改 `settings.yaml` 写出的怪形状。
		 *
		 * @param {{value?: unknown, user?: unknown}|undefined} namespaceView - 设置命名空间视图
		 * @returns {{roles: Record<string, {name: string, prompt: string}>, defaultRole: string}} 草稿
		 */
		function toDraft(namespaceView) {
			const { roles: source, defaultRole } = effectiveTable(namespaceView);
			const roles = {};
			for (const [id, role] of Object.entries(source ?? {})) {
				roles[id] = {
					name: typeof role?.name === "string" ? role.name : "",
					prompt: typeof role?.prompt === "string" ? role.prompt : "",
				};
			}
			return { roles, defaultRole: typeof defaultRole === "string" ? defaultRole : "" };
		}

		/**
		 * 保存前校验，规则与宿主 `normalizeRoleTable` 一致（宿主仍会再校验一遍）。
		 *
		 * @param {{roles: Record<string, {name: string, prompt: string}>, defaultRole: string}} draft - 草稿
		 * @returns {string|null} 问题描述，通过时 null
		 */
		function problemOf(draft) {
			const ids = Object.keys(draft.roles);
			if (ids.length === 0) return "至少要保留一个角色。";
			for (const id of ids) {
				if (!ROLE_ID_PATTERN.test(id)) return `角色 ID「${id}」不合法：只能用小写字母、数字和连字符。`;
				const role = draft.roles[id];
				if (role.name.trim() === "") return `角色「${id}」的名称不能为空。`;
				if (role.prompt.trim() === "") return `角色「${id}」的人设文本不能为空。`;
			}
			if (!Object.hasOwn(draft.roles, draft.defaultRole)) return "默认角色必须是角色表里的一个。";
			return null;
		}

		/**
		 * 生成一个没被占用的新角色 id。
		 *
		 * @param {Record<string, unknown>} roles - 现有角色表
		 * @returns {string} 新 id
		 */
		function nextRoleId(roles) {
			for (let index = 1; ; index += 1) {
				const id = `role-${index}`;
				if (!Object.hasOwn(roles, id)) return id;
			}
		}

		/**
		 * 「角色」设置页：角色表的增删改 + 默认角色选择。
		 *
		 * 编辑留在本地草稿，点「保存」才整表写回 —— 这样输入过程中不会每敲一个字就写一次
		 * 设置文档，也不会因为半成品（比如新角色还没填人设）被宿主校验拒绝。
		 *
		 * 数据源是设置文档的共享镜像（`settingsScope.describe()`）：写入成功后再把返回的
		 * 视图折回镜像，不必等一次额外读取。
		 *
		 * @param {object} props - 插槽注入的 `{ face, remote }`
		 * @returns {object} 设置页元素
		 */
		function RoleSettingsSection(props) {
			const face = props.face;
			const remote = props.remote;
			const [mirror, setMirror] = react.useState(() => face.getSnapshot());
			const [draft, setDraft] = react.useState(null);
			const [dirty, setDirty] = react.useState(false);
			/** 当前打开的角色 id；null 表示停在角色列表（一级）。 */
			const [openId, setOpenId] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState(null);

			react.useEffect(() => face.subscribe(() => setMirror(face.getSnapshot())), [face]);
			react.useEffect(() => {
				void face.ensure();
			}, [face]);

			const namespaceView =
				mirror.view === undefined ? undefined : mirror.view.namespaces.find((entry) => entry.ns === SETTINGS_NAMESPACE);
			const writable = mirror.view !== undefined && mirror.view.writable === true;

			// 没在编辑时跟随宿主；一旦有未保存的改动就保留草稿，不被远端刷新冲掉。
			// 这个 effect 必须排在下面的早返回之前：hooks 的调用顺序不能随分支变化。
			react.useEffect(() => {
				if (dirty) return;
				if (namespaceView === undefined) return;
				setDraft(toDraft(namespaceView));
			}, [namespaceView, dirty]);

			const edit = (mutate) => {
				setDraft((current) => (current === null ? current : mutate(current)));
				setDirty(true);
				setError(null);
			};

			if (mirror.status === "unavailable") {
				return el(
					"div",
					{ style: S.root },
					el("div", { style: S.desc }, "当前宿主没有提供可写的设置通道，角色只能通过配置文件修改。"),
				);
			}
			if (namespaceView === undefined) {
				return el(
					"div",
					{ style: S.root },
					el(
						"div",
						{ style: S.desc },
						mirror.error ?? "正在读取角色设置…（若一直停在这里，说明宿主没有注册 agent-role 设置命名空间）",
					),
				);
			}
			if (draft === null) {
				return el("div", { style: S.root }, el("div", { style: S.desc }, "正在读取角色设置…"));
			}

			const ids = Object.keys(draft.roles);

			const save = async () => {
				const problem = problemOf(draft);
				if (problem !== null) {
					setError(problem);
					return;
				}
				setBusy(true);
				setError(null);
				try {
					const response = await remote.mutate(
						SETTINGS_NAMESPACE,
						[
							{ op: "set", path: ["roles"], value: draft.roles },
							{ op: "set", path: ["defaultRole"], value: draft.defaultRole },
						],
						namespaceView.revision,
					);
					if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
					face.acceptView(response.value);
					setDirty(false);
				} catch (cause) {
					setError(cause instanceof Error ? cause.message : String(cause));
				} finally {
					setBusy(false);
				}
			};

			const revert = () => {
				setDraft(toDraft(namespaceView));
				setDirty(false);
				setError(null);
			};

			/**
			 * 当前打开的角色（二级菜单）。打开的那个角色被删掉、或还没打开过时为 null。
			 * 不额外用 effect 同步：草稿是本地状态，直接按"表里还有没有它"算，不会出现悬空页。
			 */
			const editingId = openId !== null && Object.hasOwn(draft.roles, openId) ? openId : null;

			const listRow = (id) =>
				el(
					"button",
					{ key: id, type: "button", style: S.row, disabled: busy, onClick: () => { setOpenId(id); setError(null); } },
					el("span", { style: S.rowName }, draft.roles[id].name.trim() === "" ? id : draft.roles[id].name),
					el("span", { style: S.caret }, "›"),
				);

			const listPage = el(
				"div",
				{ style: S.list },
				ids.length === 0
					? el("div", { style: S.desc }, "角色表是空的，先新增一个角色。")
					: ids.map(listRow),
			);

			/** 二级菜单：只在打开某个角色时才构造，未打开时不碰 `draft.roles`。 */
			const detailPageOf = (editingId) => el(
				"div",
				{ style: S.card },
				el(
					"div",
					{ style: S.cardHead },
					el("button", { type: "button", style: S.buttonQuiet, disabled: busy, onClick: () => setOpenId(null) }, "‹ 角色列表"),
					el("span", { style: S.spacer }),
					el("span", { style: S.idTag }, editingId),
					el(
						"button",
						{
							type: "button",
							style: S.buttonQuiet,
							disabled: busy || ids.length <= 1,
							title: ids.length <= 1 ? "至少要保留一个角色" : "删除这个角色",
							onClick: () => {
								const roles = { ...draft.roles };
								delete roles[editingId];
								const rest = Object.keys(roles);
								setOpenId(null);
								edit((table) => ({
									roles,
									defaultRole: table.defaultRole === editingId ? (rest[0] ?? "") : table.defaultRole,
								}));
							},
						},
						"删除",
					),
				),
				el("div", { style: S.label }, "名称（在选择器和提示词标题里显示）"),
				el("input", {
					style: S.input,
					value: draft.roles[editingId].name,
					disabled: busy,
					onChange: (event) =>
						edit((table) => ({
							...table,
							roles: { ...table.roles, [editingId]: { ...table.roles[editingId], name: event.target.value } },
						})),
				}),
				el("div", { style: S.label }, "人设文本（作为系统提示词里的一段注入）"),
				el("textarea", {
					style: S.textarea,
					value: draft.roles[editingId].prompt,
					disabled: busy,
					onChange: (event) =>
						edit((table) => ({
							...table,
							roles: { ...table.roles, [editingId]: { ...table.roles[editingId], prompt: event.target.value } },
						})),
				}),
			);

			return el(
				"div",
				{ style: S.root },
				el(
					"div",
					{ style: S.intro },
					el("div", { style: S.heading }, "角色"),
					el(
						"div",
						{ style: S.desc },
						"角色是一段注入系统提示词的人设文本。它只改身份、不动工具集，所以在同一次对话里可以随时用输入框的 /role 切换；没显式切换过的会话用下面的默认角色。改完点保存写入设置文档，立即生效。",
					),
				),
				el(
					"div",
					{ style: S.cardHead },
					el("span", { style: S.label }, "默认角色（没有显式切换过的会话用它）"),
					el(
						"select",
						{
							style: { ...S.input, width: "auto", minWidth: "200px" },
							value: draft.defaultRole,
							disabled: busy,
							onChange: (event) => edit((table) => ({ ...table, defaultRole: event.target.value })),
						},
						ids.map((id) => el("option", { key: id, value: id }, draft.roles[id].name || id)),
					),
				),
				editingId === null ? listPage : detailPageOf(editingId),
				editingId !== null
					? null
					: el(
						"button",
						{
							type: "button",
							style: S.button,
							disabled: busy,
							// 新角色人设为空，保存会被校验拦下，所以直接打开它的详情页让人接着填。
							onClick: () => {
								const id = nextRoleId(draft.roles);
								setOpenId(id);
								edit((table) => ({
									roles: { ...table.roles, [id]: { name: "新角色", prompt: "" } },
									defaultRole: table.defaultRole || id,
								}));
							},
						},
						"新增角色",
					),
				error === null ? null : el("div", { style: S.error, role: "alert" }, error),
				el(
					"div",
					{ style: S.footer },
					el("button", { type: "button", style: S.button, disabled: busy || !dirty || !writable, onClick: save }, busy ? "保存中…" : "保存"),
					el("button", { type: "button", style: S.buttonQuiet, disabled: busy || !dirty, onClick: revert }, "撤销改动"),
					el(
						"span",
						{ style: S.ok },
						!writable ? "当前连接只读，无法保存" : dirty ? "有未保存的改动" : "已与设置文档一致",
					),
				),
			);
		}
		//#endregion

		//#region lib/types/client/RoleChip.js
		/**
		 * 会话里的当前角色指示器：挂在输入框工具行左侧，实时显示这个会话生效的角色名。
		 *
		 * 数据取自 `role` 投影的 wire 视图 `{current, options}` —— 那是宿主按会话日志折出来的
		 * 权威值（没显式切换过的会话是默认角色），切换角色后随下一次投影推送自动更新，
		 * 前端不需要自己维护状态。
		 *
		 * 投影不可用（宿主半边没加载、会话还没就绪）时整个指示器不渲染，不留空壳。
		 *
		 * @param {object} props - 插槽注入的 `{ useProjection, t }`
		 * @returns {object|null} 指示器元素
		 */
		function RoleChip(props) {
			// useProjection 是 session 级插槽的标准 props。宿主万一没给（老版本），降级成不渲染，
			// 而不是让整条输入行崩掉；它有没有在整个挂载期内不变，不存在 hooks 顺序问题。
			const view = typeof props.useProjection === "function" ? props.useProjection("role") : undefined;
			if (view === null || typeof view !== "object") return null;
			const current = view.current;
			if (typeof current !== "string" || current === "") return null;
			const matched = Array.isArray(view.options) ? view.options.find((option) => option?.id === current) : undefined;
			const name = typeof matched?.name === "string" && matched.name.trim() !== "" ? matched.name : current;
			return el("span", { style: S.chip, title: `${props.t("chip.title")}：${name}` }, `${props.t("chip.label")}：${name}`);
		}
		//#endregion

		//#region lib/types/client/index.js
		/**
		 * 客户端插件主体：/role 弹出选择器 + 会话内角色指示器 + 「角色」设置页。
		 *
		 * @param {object} ctx - 客户端根上下文
		 */
		function apply(ctx) {
			const sessions = ctx.sessions;
			ctx.effect(() => ctx.locale.register("agent-role", { zh, en }), "agent-role: dictionaries");
			const t = ctx.locale.bind("agent-role");
			const sessionFor = (session) => sessions.binding(session.sessionId)?.session;

			// 设置文档的共享镜像：设置页与选择器都从它读实时角色表。
			const face = ctx.settingsScope.describe();
			const remoteSettings = ctx.remote.settings;
			const namespaceViewOf = () =>
				face.getSnapshot().view?.namespaces.find((entry) => entry.ns === SETTINGS_NAMESPACE);

			/** 选择器条目：优先取设置的实时角色表，取不到再退回投影视图。 */
			const optionsFor = (session) => {
				const live = sessionFor(session);
				const view = roleViewOf(live);
				const fromSettings = optionsFromSettings(namespaceViewOf(), view?.current);
				if (fromSettings !== undefined) return fromSettings;
				if (view === undefined) throw new Error(t("option.missing"));
				return optionsFromView(view);
			};

			ctx.effect(
				() =>
					ctx.get("commandUi").decorate({
						name: "role",
						// 宿主没有这个命令（插件未加载）时整个入口消失，不留死按钮。
						available: (session) => namespaceViewOf() !== undefined || roleViewOf(sessionFor(session)) !== undefined,
						ui: {
							kind: "popupSelect",
							options: (session) => Promise.resolve(optionsFor(session)),
							onSelect: async (option, session) => {
								const live = sessionFor(session);
								if (live === undefined) throw new Error(t("option.missing"));
								const result = await live.command(`/role ${option.id}`);
								if (!result.ok) throw new Error(`${t("command.failed")}：${result.error.code}: ${result.error.message}`);
								if (!result.value.matched) throw new Error(t("command.unsupported"));
							},
						},
					}),
				"agent-role: /role decoration",
			);

			// 会话内的角色指示器：输入框工具行左侧（Plan 芯片那一排），只读展示。
			ctx.slots.inject("conversation.input.left", () =>
				ctx.slots.register(
					{
						name: "conversation.input.left",
						id: "role",
						order: 20,
						locale: "agent-role",
					},
					RoleChip,
				),
			);

			ctx.slots.inject("settings.section", () =>
				ctx.slots.register(
					{
						name: "settings.section",
						id: SETTINGS_NAMESPACE,
						order: 30,
						label: () => "角色",
						inject: () => ({ face, remote: remoteSettings }),
					},
					RoleSettingsSection,
				),
			);
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});

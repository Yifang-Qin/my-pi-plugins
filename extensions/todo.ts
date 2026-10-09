/**
 * 分层 todo：phase → task，状态仅存在当前分支 toolResult.details 中。
 * 纯状态逻辑见 shared/todo-state.ts；widget 只安装一次，之后请求重绘，保持 powerline 顺序。
 *
 * 注入时机：
 * - before_agent_start：静态 guide + 紧凑状态摘要（一行计数 + 当前任务），并重置本轮 nudge 预算；
 *   清单为空 + 会话首条 user 消息时改为返回 eager prelude（建议先铺计划，不强制）
 * - 工具结果：全展开分层快照，状态的唯一权威载体
 * - tool_result：只统计修改类工具调用次数
 * - turn_end：mid-run nudge（极简、不带清单、永不 continue）
 * - session_compact：压缩会吃掉承载计划的工具结果，当场补一条状态摘要 / 重申 eager
 * - 调用失败：补一条隐藏提醒，本轮末尾 flush
 *
 * 刻意不做控制流干预：不因「还有 todo 未完成」而拦住收工，模型随时可以停。
 * 曾按 omp 的 checkCompletion 做过 agent_before_settle 拦截 + 自动续跑，已整体撑销：
 * 它必须先判断「模型是不是在等用户回答」，而这只能靠关键词/正则启发式；
 * 漏判的后果是强行续跑、让模型替用户做决定——错在危险方向。实测反例：
 * 「要麻烦你确认一下…」不带「请」、不以问号结尾，就被漏判。自然语言里「我在等你」
 * 的说法是无穷的，补正则永远是打地鼠，不要再尝试。
 */
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { stripNonSgrAnsi, toSingleLine } from "./shared/terminal-text.ts";
import {
	activeTask,
	allTasks,
	applyTodo,
	cloneState,
	emptyTodoState,
	isActionable,
	isClosed,
	plainTodoText,
	readTodoSnapshot,
	restoreTodos,
	snapshotText,
	todoCounts,
	TodoSchema,
	type TodoDetails,
	type TodoPhase,
	type TodoTask,
} from "./shared/todo-state.ts";

const NUDGE_MUTATION_THRESHOLD = 12;
const NUDGE_MAX_PER_CYCLE = 2;
// 只数「真的改了东西」的工具（对齐 omp 的 MUTATING_TOOLS）：读文件/搜索再多也不代表有新进度要对账。
const MUTATING_TOOLS = new Set(["bash", "edit", "write", "eval", "ast_edit", "multi_edit", "apply_patch"]);
const PREVIEW_TASKS = 8;
const TODO_GUIDE = `## Task Management

Use the \`todo\` tool for non-trivial work or 3+ steps. Organize tasks into phases (two levels only).
- \`init\` (phases: [{name, items: string[]}]): replace the plan in one call. A single-phase plan may be sent flat as items: [...] with an optional phase name. Cover each requested item; skip filler tasks.
- \`append\` (phase + items): add tasks, creating the phase if missing. Names are unique; task text is unique within its phase.
- \`done\` / \`drop\`: complete / abandon a task (id), phase (phase), or all tasks (neither target).
- \`start\` (id): explicitly select a current task. IDs come from results; never guess. IDs are not reused after init or clear on this branch.
- \`block\` (id or phase, reason?): record an external wait; closed tasks stay closed. \`unblock\` returns blocked tasks to pending.
- \`rm\` (id or phase or neither): remove tasks and empty phases. \`clear\`: remove the whole plan.
- \`view\`: read the full plan, including closed tasks and their IDs.
Fields that don't apply to the action are ignored. For done/drop/block/unblock/rm pass either id or phase, never both.
After each mutation the tool keeps at most one in_progress task, and automatically starts the earliest pending task when none is active. Blocked tasks never start automatically.
Mark done immediately and continue with the next action in the same turn. Pair planning/updates with actual work; don't spend a turn only on todo bookkeeping.
Before the final response, reconcile the plan. Clear it if all tasks are completed or abandoned; otherwise preserve remaining tasks (including blocked ones) and explain them to the user.`;

// eager prelude（对齐 omp preferred 档位）：只建议、不强制，且明说琐碎任务跳过。
const EAGER_PRELUDE =
	"<system-reminder>\nConsider calling `todo` first to lay out a phased plan with a single `init` call. " +
	"A good list covers the whole request — investigation through implementation and verification — not just " +
	"the next step, with task labels a later turn could execute without re-planning. Keep each task to a " +
	"concise 5-10 word label; `init` only accepts phase names and task strings, so don't invent extra fields. " +
	"If you create the list, continue the request in the same turn instead of stopping after the todo call. " +
	"Skip it for trivial single-step work.\n</system-reminder>";

// ASCII 复选框：宽度可预测（固定 3 列）、不依赖字体，和 Markdown 清单一致。
// 对齐 omp：只有 completed 是打勾，其余全是空框，状态靠**颜色 + 删除线**区分。
// 这样纵向扫视时方框列是对齐的，比混排多种图标整齐。
const CHECKED = "[x]";
const UNCHECKED = "[ ]";
// 折叠预览里领头的已关闭任务数（对齐 omp COLLAPSED_CLOSED_CONTEXT）：
// 即使乱序完成，也总有一行打勾行可见，持续给出「在推进」的反馈。
const CLOSED_LEAD = 1;
// 树形连接线（pi 没有 omp renderTreeList 的等价物，自己做一个最小版）。
const BRANCH = "├─ ";
const LAST = "└─ ";

const fit = (text: string, width: number): string =>
	truncateToWidth(toSingleLine(stripNonSgrAnsi(text)), Math.max(1, width));

const taskLine = (task: TodoTask, theme: Theme): string => {
	const id = `#${task.id} `;
	const text = plainTodoText(task.text);
	switch (task.status) {
		case "completed":
			return theme.fg("success", `${CHECKED} ${id}${theme.strikethrough(text)}`);
		case "abandoned":
			return theme.fg("error", `${UNCHECKED} ${id}${theme.strikethrough(text)}`);
		case "blocked":
			return theme.fg(
				"warning",
				`${UNCHECKED} ${id}${text} (${task.blocker ? `blocked: ${plainTodoText(task.blocker)}` : "blocked"})`,
			);
		case "in_progress":
			return theme.fg("accent", `${UNCHECKED} ${id}${text}`);
		default:
			return theme.fg("dim", `${UNCHECKED} ${id}${text}`);
	}
};

// 最后一行用 └─ 收口，其余 ├─；「还有 N 条」作为最后那个 └─ 行（同 omp）。
const withBranches = (rows: string[], theme: Theme): string[] =>
	rows.map((row, index) => theme.fg("dim", index === rows.length - 1 ? LAST : BRANCH) + row);

// 折叠预览的「行走窗口」（对齐 omp selectCollapsedTodos）：末尾的已关闭任务领头（额外加、
// 不占未完成配额），从当前任务开始往后铺；hidden 只数没装下的**未完成**项。
// 与 omp 的唯一偏离：窗口没铺满时（当前任务靠末尾）向前多拉几条已关闭任务填满，
// 比留空白有信息量；窗口满时行为与 omp 一致。
function collapsedTasks(tasks: TodoTask[]): { items: TodoTask[]; hidden: number } {
	const open = tasks.filter((task) => !isClosed(task));
	const base = open.length === 0 ? tasks : open;
	const start = Math.max(
		0,
		base.findIndex((task) => task.status === "in_progress"),
	);
	const items = base.slice(start, start + PREVIEW_TASKS);
	const hidden = base.length - items.length;
	if (open.length === 0) return { items, hidden };
	const closed = tasks.filter(isClosed);
	const lead = closed.slice(-Math.max(CLOSED_LEAD, PREVIEW_TASKS - items.length));
	return { items: [...lead, ...items], hidden };
}

// phase 头：活跃阶段加粗 accent，其余 muted；进度 dim。不放状态图标（同 omp）。
const phaseHeader = (phase: TodoPhase, index: number, isActive: boolean, theme: Theme): string => {
	const counts = todoCounts(phase.tasks);
	const label = `${index + 1}. ${plainTodoText(phase.name)}`;
	const progress = ` · ${counts.closed}/${counts.total}${counts.blocked ? ` · ${counts.blocked} blocked` : ""}`;
	return (isActive ? theme.bold(theme.fg("accent", label)) : theme.fg("muted", label)) + theme.fg("dim", progress);
};

function treeLines(phases: TodoPhase[], theme: Theme, full: boolean, touched: readonly string[] = []): string[] {
	const current = activeTask(phases)?.phase;
	// 没有活跃任务（全部关闭）时，焦点落在最后一个有任务的 phase——否则所有 phase
	// 都折叠，widget 只剩几行光秃秃的标题（reload 后实测到的 bug）。对应 omp 的
	// selectCollapsedTodos：phase 没有未完成项时回退展示自己的已关闭任务。
	const focus = current ?? [...phases].reverse().find((phase) => phase.tasks.length > 0);
	// 单 phase（如扁平 init 的 Tasks）不显示 phase 头：那一行没信息量。
	const multiPhase = phases.length > 1;
	// 任务缩进要对齐 phase **名称**的起点，而不是硬编码 2 格：标签前缀是
	// `N. `（数字位数 + 点 + 空格）。用最宽的编号算，保证各 phase 的任务列不参差不齐。
	// 此前用 2 格，`├` 落在句点与名称之间那个空格上，看着像没对齐。
	const indent = " ".repeat(String(phases.length).length + 2);
	const lines: string[] = [];
	for (const [index, phase] of phases.entries()) {
		const expanded =
			!multiPhase ||
			full ||
			phase === focus ||
			touched.includes(phase.name) ||
			(todoCounts(phase.tasks).blocked > 0 && !current);
		// 标题高亮只跟真正的活跃 phase：计划已全部关闭时不该还有东西被点亮。
		if (multiPhase) lines.push(phaseHeader(phase, index, phase === current, theme));
		if (!expanded) continue;
		const { items, hidden } = full ? { items: phase.tasks, hidden: 0 } : collapsedTasks(phase.tasks);
		const rows = items.map((task) => taskLine(task, theme));
		if (hidden > 0) rows.push(theme.fg("dim", `… ${hidden} more task${hidden === 1 ? "" : "s"}`));
		for (const row of withBranches(rows, theme)) lines.push(multiPhase ? `${indent}${row}` : row);
	}
	return lines;
}

// 总览行：只给大局。状态细分已由 phase 头和任务行分别给出，再列一遍会把
// widget 首行挤爆（实测 76 列就被截）。blocked 非零才显示。
function progressText(phases: TodoPhase[]): string {
	const counts = todoCounts(allTasks(phases));
	return `${counts.closed}/${counts.total} closed${counts.blocked ? ` · ${counts.blocked} blocked` : ""}`;
}

// 给模型的一行计划摘要；todo_state 与 compaction 提醒共用。
function planSummary(phases: TodoPhase[]): string {
	const counts = todoCounts(allTasks(phases));
	const current = activeTask(phases);
	return (
		`${counts.open} open, ${counts.blocked} blocked, ${counts.closed}/${counts.total} closed.` +
		(current
			? ` Current: #${current.task.id} ${plainTodoText(current.task.text)}.`
			: " No actionable task; the rest is blocked.")
	);
}

/** /todos 全量树支持滚动；任务很多时仍能查看每一项。 */
class TodoListComponent {
	private scroll = 0;
	private maxScroll = 0;
	private pageSize = 1;
	constructor(
		private phases: TodoPhase[],
		private theme: Theme,
		private rows: () => number,
		private repaint: () => void,
		private close: () => void,
	) {}
	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}
		if (matchesKey(data, "up")) this.scroll--;
		else if (matchesKey(data, "down")) this.scroll++;
		else if (matchesKey(data, "pageUp")) this.scroll -= this.pageSize;
		else if (matchesKey(data, "pageDown")) this.scroll += this.pageSize;
		else if (matchesKey(data, "home")) this.scroll = 0;
		else if (matchesKey(data, "end")) this.scroll = this.maxScroll;
		else return;
		this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
		this.repaint();
	}
	render(width: number): string[] {
		const body = treeLines(this.phases, this.theme, true);
		if (!body.length) body.push(this.theme.fg("dim", "No todos"));
		this.pageSize = Math.max(1, this.rows() - 8);
		this.maxScroll = Math.max(0, body.length - this.pageSize);
		this.scroll = Math.min(this.scroll, this.maxScroll);
		// 统一留一列左边距；treeLines 本身不带边距（工具结果走 pi 的 outputPad）。
		return [
			this.theme.fg("accent", "Todos"),
			this.theme.fg("muted", progressText(this.phases)),
			"",
			...body.slice(this.scroll, this.scroll + this.pageSize),
			"",
			this.theme.fg(
				"dim",
				`↑/↓ PgUp/PgDn: scroll · Esc: close · ${this.scroll + 1}–${Math.min(body.length, this.scroll + this.pageSize)}/${body.length}`,
			),
		].map((line) => fit(line === "" ? line : ` ${line}`, width));
	}
	invalidate(): void {}
}

export default function (pi: ExtensionAPI) {
	let state = emptyTodoState();
	let touchedPhases: string[] = [];
	// mid-run nudge 的两个计数器，每个 user prompt 重置。
	let mutationsSinceTouch = 0;
	let nudgesThisCycle = 0;
	let tuiRef: { requestRender(): void } | undefined;
	let widgetInstalled = false;

	const renderWidget = (theme: Theme, width: number): string[] => {
		const tasks = allTasks(state.phases);
		if (!tasks.length) return [];
		const counts = todoCounts(tasks);
		const active = tasks.filter((task) => task.status === "in_progress").length;
		const closedCells = Math.round((20 * counts.closed) / counts.total);
		const progressCells = Math.round((20 * (counts.closed + active * 0.5)) / counts.total);
		const bar =
			theme.fg("success", "█".repeat(closedCells)) +
			theme.fg("muted", "▓".repeat(progressCells - closedCells)) +
			theme.fg("dim", "░".repeat(20 - progressCells));
		return [
			`${theme.fg("accent", "Todos")} ${bar} ${theme.fg("muted", progressText(state.phases))}`,
			...treeLines(state.phases, theme, false, touchedPhases),
			"",
		].map((line) => fit(line === "" ? line : ` ${line}`, width));
	};

	// 同 key setWidget 会把组件移到 aboveEditor 队尾；只安装一次，空清单仍保留位置。
	const refreshWidget = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (widgetInstalled) {
			tuiRef?.requestRender();
			return;
		}
		widgetInstalled = true;
		ctx.ui.setWidget(
			"todo",
			(tui, theme) => {
				tuiRef = tui;
				return {
					render: (width: number) => renderWidget(theme, width),
					invalidate: () => {},
					dispose: () => {
						tuiRef = undefined;
						widgetInstalled = false;
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	};

	// 静态 guide + 紧凑的状态摘要。摘要是「轮开头一定看得见」的唯一保障
	// （没有收工拦截兜底），但只放一行计数 + 当前任务，详情让模型自己 view：
	// 既有可见性，又不把全量清单每轮重述一遍。顺便重置本轮 nudge 预算。
	//
	// 清单为空且是会话首条 user 消息时，改为返回一条 eager prelude（建议先铺计划）。
	// 两者天然互斥：有清单才有 todo_state，没清单才谈 eager，不会重复施压。
	// pi 把 handler 返回的消息放在 user 消息**之后**（agent-session.js 1605–1624），
	// 与 omp 的 prependMessages 相反；强制 tool_choice pi 没有接口，所以只对齐
	// omp 的 preferred 档位（建议、不强制）。
	pi.on("before_agent_start", async (event, ctx) => {
		mutationsSinceTouch = 0;
		nudgesThisCycle = 0;
		const options = event.systemPromptOptions;
		if (!options.selectedTools?.includes("todo")) return;
		options.sections.todo_guide = TODO_GUIDE;
		const counts = todoCounts(allTasks(state.phases));
		if (counts.total === 0) {
			// 只在会话开局推一把：本次 user 消息此时还未进分支（pi 先 emit 再 push），
			// 所以分支里没有 user 消息 = 首条。以问号/叹号结尾的是提问而非派活，不推。
			const firstPrompt = !ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "message" && entry.message.role === "user");
			if (!firstPrompt || /[?？!！]$/.test(event.prompt.trimEnd())) return;
			return {
				message: {
					customType: "todo-eager-prelude",
					display: false,
					content: [{ type: "text" as const, text: EAGER_PRELUDE }],
				},
			};
		}
		if (counts.open === 0 && counts.blocked === 0) {
			options.sections.todo_state =
				`The previous plan is fully closed (${counts.closed}/${counts.total}). ` +
				"If the new request is unrelated, clear it or init a new plan.";
			return;
		}
		options.sections.todo_state =
			`Unfinished plan from earlier work: ${planSummary(state.phases)} ` +
			"Call todo view for the full plan. Reconcile stale items with done/drop; it is fine to stop and hand back to the user.";
	});

	// compaction 会把承载计划的工具结果摘要掉，模型可能当场失去对清单的视野；
	// 而 before_agent_start 只在 user prompt 时触发，补不上这个窗口（压缩后的自动续跑不走那里）。
	// 所以在 session_compact 当场补一条：有计划就补状态摘要，没计划就重申 eager。
	// 用 triggerTurn:false（进 _pendingCustomMessages，本轮末尾 flush），不自己拉起一轮。
	pi.on("session_compact", async () => {
		if (!pi.getActiveTools().includes("todo")) return;
		const counts = todoCounts(allTasks(state.phases));
		const text =
			counts.total === 0
				? EAGER_PRELUDE
				: "<system-reminder>\nCompaction dropped earlier context, including the todo results that carried " +
					`the plan. The plan itself is intact: ${planSummary(state.phases)} ` +
					"Call todo view for the full plan before continuing.\n</system-reminder>";
		pi.sendMessage(
			{ customType: "todo-compaction-reminder", display: false, content: [{ type: "text", text }] },
			{ triggerTurn: false },
		);
	});

	// 计数信号：任何 todo 调用清零，成功的修改类工具累加。
	pi.on("tool_result", async (event) => {
		if (event.toolName === "todo") mutationsSinceTouch = 0;
		else if (!event.isError && MUTATING_TOOLS.has(event.toolName)) mutationsSinceTouch++;
	});

	// mid-run nudge：只追加一条极简提醒，**永不返回 continue**。
	// turn_end 每轮 assistant 消息都触发，但不给 continue 就不会延长 run、也拦不住收工。
	// 本轮没调工具 = 模型正在收工，这时不插话（提醒会躺到下个 user prompt 才被看到，
	// 而我们刻意不拦收工）。内容不带清单：状态由最近一次工具结果承载，nudge 只负责催对账。
	pi.on("turn_end", async (event) => {
		if (event.toolResults.length === 0) return;
		if (mutationsSinceTouch < NUDGE_MUTATION_THRESHOLD || nudgesThisCycle >= NUDGE_MAX_PER_CYCLE) return;
		if (!pi.getActiveTools().includes("todo")) return;
		const open = allTasks(state.phases).filter(isActionable).length;
		if (open === 0) return;
		mutationsSinceTouch = 0;
		nudgesThisCycle++;
		return {
			entries: [
				{
					type: "custom_message" as const,
					customType: "todo-nudge",
					display: false,
					content:
						`<system-reminder>\n${open} todo item${open === 1 ? "" : "s"} still open. ` +
						"If you finished a task since the last todo update, mark it done now so progress stays visible; " +
						"otherwise keep working.\n</system-reminder>",
				},
			],
		};
	});

	const restore = (ctx: ExtensionContext) => {
		state = restoreTodos(ctx.sessionManager.getBranch());
		touchedPhases = [];
		mutationsSinceTouch = 0;
		nudgesThisCycle = 0;
		refreshWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a two-level phase/task plan. init replaces phases [{name,items[]}], and also accepts a flat items[] (optionally with phase) as a single-phase plan; append adds items to a phase. start requires id; done/drop/rm target id, phase, or all when neither is given. block/unblock require id or phase; block accepts reason. view returns all IDs; clear removes the whole plan. Fields that don't apply are ignored; for done/drop/block/unblock/rm pass either id or phase. Mutations are atomic and auto-start the earliest pending task if none is active. Status: pending/in_progress/completed/abandoned/blocked; IDs stay unique across init/clear on the current branch.",
		parameters: TodoSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			let result: ReturnType<typeof applyTodo>;
			try {
				result = applyTodo(state, params); // throw 由 pi 转为失败 toolResult，状态不提交
			} catch (error) {
				// 失败提醒：错误文本本身没说「计划未变、用户看不到进度」，补上这层语义。
				// 用 triggerTurn:false 而不是 deliverAs:"nextTurn"——后者在 pi 里要等到下个 user
				// prompt 才投递（_pendingNextTurnMessages），对 mid-run 失败太晩；前者进
				// _pendingCustomMessages，本轮工具结果落盘后 flush，下一次 LLM call 即可见。
				pi.sendMessage(
					{
						customType: "todo-error-reminder",
						display: false,
						content: [
							{
								type: "text",
								text:
									"<system-reminder>\nThe todo call failed, so the plan is unchanged and its progress is not visible to the user.\n" +
									`Failure: ${error instanceof Error ? error.message : String(error)}\n` +
									"Fix the arguments and call todo again before continuing.\n</system-reminder>",
							},
						],
					},
					{ triggerTurn: false },
				);
				throw error;
			}
			if (params.action !== "view") {
				state = result.state;
				touchedPhases = result.touchedPhases;
				refreshWidget(ctx);
			}
			const details: TodoDetails = {
				version: 2,
				action: params.action,
				...cloneState(state),
				touchedPhases: [...result.touchedPhases],
			};
			return {
				content: [
					{
						type: "text",
						// 始终全展开：工具结果是状态的唯一权威载体。
						text: (result.message ? `${result.message}\n\n` : "") + snapshotText(state.phases),
					},
				],
				details,
			};
		},
		renderCall(args, theme) {
			// 流式参数可能不完整；旧 add/set/toggle 历史也须可渲染。
			const old = args as unknown as { text?: unknown; status?: unknown };
			let text =
				theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", plainTodoText(String(args.action ?? "")));
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (typeof args.phase === "string") text += ` ${plainTodoText(args.phase)}`;
			if (Array.isArray(args.phases)) text += theme.fg("dim", ` (${args.phases.length} phases)`);
			if (Array.isArray(args.items)) text += theme.fg("dim", ` (+${args.items.length} tasks)`);
			if (typeof old.text === "string") text += ` ${plainTodoText(old.text)}`;
			if (typeof old.status === "string") text += ` → ${plainTodoText(old.status)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details as unknown as { error?: string; touchedPhases?: unknown } | undefined;
			if (details?.error) return new Text(theme.fg("error", plainTodoText(details.error)), 0, 0);
			const snapshot = readTodoSnapshot(result.details);
			const content = result.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			if (!snapshot) return new Text(content.split("\n").map(plainTodoText).join("\n"), 0, 0);
			const touched = Array.isArray(details?.touchedPhases)
				? details.touchedPhases.filter((name): name is string => typeof name === "string")
				: [];
			const lines = treeLines(snapshot.phases, theme, expanded, touched);
			if (!lines.length) return new Text(theme.fg("dim", "No todos"), 0, 0);
			return new Text([theme.fg("muted", plainTodoText(content.split("\n")[0] ?? "")), ...lines].join("\n"), 0, 0);
		},
	});

	pi.registerCommand("todos", {
		description: "Show all phases and tasks on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}
			await ctx.ui.custom<void>(
				(tui, theme, _kb, done) =>
					new TodoListComponent(
						cloneState(state).phases,
						theme,
						() => tui.terminal.rows,
						() => tui.requestRender(),
						done,
					),
			);
		},
	});
}

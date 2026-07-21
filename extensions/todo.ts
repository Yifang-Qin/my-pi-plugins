/**
 * Todo Extension - 三态任务清单 + 常驻进度 widget
 *
 * - 注册 `todo` 工具给 LLM：list / add / set / clear
 *   （add/set 的 tool result 回显全量清单快照，对齐 cc/codex 的「全量替换」语义，
 *   让对话历史里始终有新鲜快照而非只有增量日志，降低长会话中被遗忘的概率）
 * - 注册 `/todos` 命令给用户查看清单
 * - context 事件反应式 reminder：agentic loop 深处距上次 todo 调用过久时，
 *   向本次请求 payload 注入非持久的 <system-reminder>（当前快照 + 对账提示），
 *   对齐 cc 的「hasn't been used recently」机制；不落盘、不在历史里累积
 * - editor 上方常驻 widget：进度条 + 三态图标（○ pending / ◼ in_progress / ✓ completed）
 *
 * 状态存在工具结果的 details 里（非外部文件），因此分支切换时状态自动正确。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

// 反应式 reminder（cc「hasn't been used recently」风格）的两个阈值（单位：消息条数）：
// GAP：距上次 todo 工具调用 / 距本 turn 的 user 消息都超过这个数才注入。
//      tool-heavy loop 下每个 LLM call ≈ assistant + toolResult 两条，12 条 ≈ 6 个 call。
// COOLDOWN：一次注入后至少再积累这么多条消息才允许下一次，防刷屏/防脱敏。
const REMINDER_GAP = 12;
const REMINDER_COOLDOWN = 12;

// 常驻 system prompt 段落：Codex 风格，只讲工具用法（静态部分）。
// 状态感知的注入（未完成快照 / 全完成 nudge）在 before_agent_start 里按当前状态另行追加。
// 措辞必须与下方 registerTool 的 schema 对齐（action: list/add/set/clear，status 三态）。
const TODO_GUIDE = `

## Task Management

You have a \`todo\` tool for tracking multi-step work. Actions:
- \`add\` (text): append a new todo (starts as pending).
- \`set\` (id + status): move a todo to pending / in_progress / completed.
- \`list\`: show the current todos.
- \`clear\`: remove all todos.

Use it when a task has 3+ distinct steps or is non-trivial:
- Lay out the steps with \`add\` before starting the work.
- Keep exactly one todo \`in_progress\` at a time; mark it \`completed\` as soon as it's done, then start the next.
- Skip the tool for trivial single-step tasks — don't invent filler steps.
- Before the final response, reconcile the todo list with the work actually completed. Mark finished items \`completed\`; if no unfinished items remain, call \`clear\`. Otherwise keep the remaining items and mention them to the user.`;

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

// 兼容旧会话：早期版本用 done 布尔而非 status
type LegacyTodo = { id: number; text: string; done?: boolean; status?: TodoStatus };

interface TodoDetails {
	action: "list" | "add" | "set" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "set", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for set)" })),
	status: Type.Optional(
		StringEnum(["pending", "in_progress", "completed"] as const, {
			description: "New status (for set)",
		}),
	),
});

// 旧数据（done 布尔）→ 新三态 status 的规范化
const normalizeTodo = (t: LegacyTodo): Todo => ({
	id: t.id,
	text: t.text,
	status: t.status ?? (t.done ? "completed" : "pending"),
});

// 三态图标（带主题色）：pending ○ / in_progress ◼ / completed ✓
const statusIcon = (status: TodoStatus, theme: Theme): string => {
	switch (status) {
		case "completed":
			return theme.fg("success", "✓");
		case "in_progress":
			return theme.fg("accent", "◼");
		default:
			return theme.fg("dim", "○");
	}
};

// 三态文本配色：completed 最暗、in_progress 最亮、pending 居中
const statusText = (status: TodoStatus, text: string, theme: Theme): string => {
	switch (status) {
		case "completed":
			return theme.fg("dim", text);
		case "in_progress":
			return theme.fg("text", text);
		default:
			return theme.fg("muted", text);
	}
};

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos yet. Ask the agent to add some!")}`, width));
		} else {
			const completed = this.todos.filter((t) => t.status === "completed").length;
			const total = this.todos.length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${completed}/${total} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const icon = statusIcon(todo.status, th);
				const id = th.fg("accent", `#${todo.id}`);
				const text = statusText(todo.status, todo.text, th);
				lines.push(truncateToWidth(`  ${icon} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos.map((t) => normalizeTodo(t));
				nextId = details.nextId;
			}
		}
	};

	// 渲染常驻 widget 的内容（editor 上方）：首行进度条 + 每条 todo
	const renderWidgetLines = (theme: Theme, width: number): string[] => {
		const total = todos.length;
		const completed = todos.filter((t) => t.status === "completed").length;
		const inProgress = todos.filter((t) => t.status === "in_progress").length;
		const barWidth = 20;
		// 三段式进度条：completed 记满格、in_progress 记半格（进度条惯例：进行中 ≈ 半程）
		const completedCells = total > 0 ? Math.round((barWidth * completed) / total) : 0;
		const progressCells = total > 0 ? Math.round((barWidth * (completed + inProgress * 0.5)) / total) : 0;
		const inProgressCells = Math.max(0, progressCells - completedCells);
		const emptyCells = Math.max(0, barWidth - completedCells - inProgressCells);
		const bar =
			theme.fg("success", "█".repeat(completedCells)) +
			theme.fg("muted", "▓".repeat(inProgressCells)) + // 浅灰：正在进行
			theme.fg("dim", "░".repeat(emptyCells));
		const pct = total > 0 ? Math.round(((completed + inProgress * 0.5) / total) * 100) : 0;

		const lines: string[] = [];
		lines.push(
			truncateToWidth(
				` ${theme.fg("accent", "Todos")} ${bar} ${theme.fg("muted", `${completed}/${total} · ${pct}%`)}`,
				width,
			),
		);
		for (const t of todos) {
			const icon = statusIcon(t.status, theme);
			const id = theme.fg("accent", `#${t.id}`);
			const text = statusText(t.status, t.text, theme);
			lines.push(truncateToWidth(` ${icon} ${id} ${text}`, width));
		}
		lines.push(""); // widget 与输入框之间留一行边距
		return lines;
	};

	// 状态变化后刷新 widget（无 todo 时清除）
	const refreshWidget = (ctx: ExtensionContext) => {
		if (todos.length === 0) {
			ctx.ui.setWidget("todo", undefined);
			return;
		}
		ctx.ui.setWidget("todo", (_tui, theme) => ({
			render: (width: number) => renderWidgetLines(theme, width),
			invalidate: () => {},
		}));
	};

	// 全量快照文本（发给 LLM 的纯文本格式）。add/set 的 tool result 与 system prompt 注入共用。
	// 对齐 cc/codex 的「全量替换」语义：每次操作后历史里都留一份完整清单，而非只有增量日志。
	const snapshotText = (): string => {
		if (todos.length === 0) return "No todos";
		const completed = todos.filter((t) => t.status === "completed").length;
		const lines = todos.map((t) => `#${t.id} [${t.status}] ${t.text}`);
		return `Todo list (${completed}/${todos.length} completed):\n${lines.join("\n")}`;
	};

	// 常驻注入：仅当本插件的 todo 工具在当前提示里激活时才追加 guide。
	// before_agent_start 每个 user turn 触发一次，system prompt 逐轮重建，
	// 因此每个发给 LLM 的请求都会带上这段（等价于常驻）。
	// 另做两处「状态感知」注入（互斥分支）：
	// - 有未完成项：把全量快照带进本 turn 的 system prompt，开局即知有活没干完，
	//   避免清单沉在历史深处被遗忘（长 agentic loop 场景的第一道保险）。
	// - 全部完成但列表仍挂着：追加一句 nudge 让模型在开无关新任务前主动 clear
	//   （只提示，不自动清——「全完成」不代表用户要开新活，同任务追问时
	//   自动清会丢掉刚做完的清单上下文）。
	pi.on("before_agent_start", async (event) => {
		const active = event.systemPromptOptions.selectedTools?.includes("todo") ?? false;
		if (!active) return;

		let systemPrompt = event.systemPrompt + TODO_GUIDE;

		if (todos.length > 0 && todos.every((t) => t.status === "completed")) {
			systemPrompt +=
				`\n\n**Note:** All ${todos.length} todos from the previous task are completed. ` +
				"If the user's new request is unrelated, call `todo clear` before starting " +
				"(or clear and re-populate for the new task). Don't carry a stale completed list forward.";
		} else if (todos.length > 0) {
			systemPrompt +=
				`\n\n**Note:** There are unfinished todos from earlier work:\n\n${snapshotText()}\n\n` +
				"Continue from the `in_progress` item unless the user's new request changes priorities. " +
				"Keep statuses up to date as you work; if the list no longer matches what you're doing, clean it up.";
		}

		return { systemPrompt };
	});

	// 反应式 reminder（②）：context 事件在**每次 LLM call 前**触发——含 agentic loop 中途，
	// 这是 before_agent_start（每 user turn 一次）覆盖不到的。返回的 messages 是深拷贝，
	// 只影响本次请求 payload、不写入 session（瞬时注入，不会在历史里累积）。
	// 条件：有未完成项 && 距上次 todo 调用与距本 turn user 消息都超过 GAP && 冷却已过。
	// （sinceUser 门槛：turn 开头的 system prompt 已由上方分支带上快照，只需覆盖深入 loop 之后）
	// 注入在消息列表末尾：注意力位置最好，且不动前缀、对 prompt cache 友好。
	// role:"custom" 的消息由 convertToLlm 转成 user 角色发给 provider。
	let lastRemindedAt = -1; // 上次注入时的消息总数（用作冷却基准）

	pi.on("context", async (event) => {
		const msgs = event.messages;
		if (msgs.length < lastRemindedAt) lastRemindedAt = -1; // 换分支/压缩后长度回退，重置冷却

		if (todos.length === 0 || todos.every((t) => t.status === "completed")) return;
		if (lastRemindedAt >= 0 && msgs.length - lastRemindedAt < REMINDER_COOLDOWN) return;

		// 从尾部扫：距上次 todo 工具结果 / 距最近一条 user 消息的距离（没找到按无穷大算）
		let sinceTodo = Number.POSITIVE_INFINITY;
		let sinceUser = Number.POSITIVE_INFINITY;
		for (let i = msgs.length - 1; i >= 0; i--) {
			const m = msgs[i];
			if (sinceTodo === Number.POSITIVE_INFINITY && m.role === "toolResult" && m.toolName === "todo") {
				sinceTodo = msgs.length - 1 - i;
			}
			if (sinceUser === Number.POSITIVE_INFINITY && m.role === "user") {
				sinceUser = msgs.length - 1 - i;
			}
			if (sinceTodo !== Number.POSITIVE_INFINITY && sinceUser !== Number.POSITIVE_INFINITY) break;
		}
		if (sinceTodo < REMINDER_GAP || sinceUser < REMINDER_GAP) return;

		lastRemindedAt = msgs.length;
		const reminder: AgentMessage = {
			role: "custom",
			customType: "todo-reminder",
			content: [
				{
					type: "text",
					// 快照放前、指令放后；只说「对账」不催进度；结尾软化词防脱敏（对齐 cc 措辞）
					text:
						`<system-reminder>\n${snapshotText()}\n\n` +
						"The `todo` tool hasn't been used in a while. If any of these items are already done, " +
						"mark them completed (`todo set`); keep exactly one item in_progress. If the list no " +
						"longer matches the work, clean it up. This is just a gentle reminder — ignore if not " +
						"applicable.\n</system-reminder>",
				},
			],
			display: false,
			timestamp: Date.now(),
		};
		return { messages: [...msgs, reminder] };
	});

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
		lastRemindedAt = -1;
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
		lastRemindedAt = -1;
	});

	// Register the todo tool for the LLM
	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list, add (text), set (id + status), clear. Status values: pending, in_progress, completed.",
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			switch (params.action) {
				case "list":
					return {
						content: [{ type: "text", text: snapshotText() }],
						details: { action: "list", todos: [...todos], nextId } as TodoDetails,
					};

				case "add": {
					if (!params.text) {
						return {
							content: [{ type: "text", text: "Error: text required for add" }],
							details: { action: "add", todos: [...todos], nextId, error: "text required" } as TodoDetails,
						};
					}
					const newTodo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(newTodo);
					refreshWidget(ctx);
					// content 回显全量快照（进 LLM 上下文）；TUI 侧 renderResult 只显示增量行，不受影响
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}\n\n${snapshotText()}` }],
						details: { action: "add", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "set": {
					if (params.id === undefined) {
						return {
							content: [{ type: "text", text: "Error: id required for set" }],
							details: { action: "set", todos: [...todos], nextId, error: "id required" } as TodoDetails,
						};
					}
					if (!params.status) {
						return {
							content: [{ type: "text", text: "Error: status required for set" }],
							details: {
								action: "set",
								todos: [...todos],
								nextId,
								error: "status required",
							} as TodoDetails,
						};
					}
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) {
						return {
							content: [{ type: "text", text: `Todo #${params.id} not found` }],
							details: {
								action: "set",
								todos: [...todos],
								nextId,
								error: `#${params.id} not found`,
							} as TodoDetails,
						};
					}
					todo.status = params.status;
					refreshWidget(ctx);
					// content 回显全量快照（进 LLM 上下文）；TUI 侧 renderResult 只显示增量行，不受影响
					return {
						content: [{ type: "text", text: `Todo #${todo.id} → ${todo.status}\n\n${snapshotText()}` }],
						details: { action: "set", todos: [...todos], nextId } as TodoDetails,
					};
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					refreshWidget(ctx);
					return {
						content: [{ type: "text", text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					};
				}

				default:
					return {
						content: [{ type: "text", text: `Unknown action: ${params.action}` }],
						details: {
							action: "list",
							todos: [...todos],
							nextId,
							error: `unknown action: ${params.action}`,
						} as TodoDetails,
					};
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("muted", `→ ${args.status}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			// 兼容旧会话：details.todos 可能是 done 布尔格式，统一规范化
			const todoList = details.todos.map((t) => normalizeTodo(t));

			switch (details.action) {
				case "list": {
					if (todoList.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${todoList.length} todo(s):`);
					const display = expanded ? todoList : todoList.slice(0, 5);
					for (const t of display) {
						const icon = statusIcon(t.status, theme);
						const itemText = statusText(t.status, t.text, theme);
						listText += `\n${icon} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && todoList.length > 5) {
						listText += `\n${theme.fg("dim", `... ${todoList.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				case "add": {
					const added = todoList[todoList.length - 1];
					return new Text(
						theme.fg("success", "✓ Added ") +
							theme.fg("accent", `#${added.id}`) +
							" " +
							theme.fg("muted", added.text),
						0,
						0,
					);
				}

				case "set": {
					// content 现在带全量快照（给 LLM 的），UI 只取首行增量（清单本身有 widget/展开可看）
					const text = result.content[0];
					const msg = text?.type === "text" ? (text.text.split("\n")[0] ?? "") : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}

				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);

				default: {
					// 兜底：兼容旧会话遗留的未知 action（如早期版本的 "toggle"）。
					// 缺了它，switch 落空会返回 undefined，reload 重渲染历史时会让 TUI 崩溃退出。
					const text = result.content[0];
					return new Text(text?.type === "text" ? text.text : "", 0, 0);
				}
			}
		},
	});

	// Register the /todos command for users
	pi.registerCommand("todos", {
		description: "Show all todos on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}

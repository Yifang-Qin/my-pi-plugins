/**
 * Todo Extension - 三态任务清单 + 常驻进度 widget
 *
 * - 注册 `todo` 工具给 LLM：list / add / set / clear
 * - 注册 `/todos` 命令给用户查看清单
 * - editor 上方常驻 widget：进度条 + 三态图标（○ pending / ◼ in_progress / ✓ completed）
 *
 * 状态存在工具结果的 details 里（非外部文件），因此分支切换时状态自动正确。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "completed";

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

	// Reconstruct state on session events
	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
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
						content: [
							{
								type: "text",
								text: todos.length
									? todos.map((t) => `#${t.id} [${t.status}] ${t.text}`).join("\n")
									: "No todos",
							},
						],
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
					return {
						content: [{ type: "text", text: `Added todo #${newTodo.id}: ${newTodo.text}` }],
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
					return {
						content: [{ type: "text", text: `Todo #${todo.id} → ${todo.status}` }],
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
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
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

// 分层 todo 的纯状态逻辑；无模块级可变状态，入口和测试共同使用。
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { stripAnsi, toSingleLine } from "./terminal-text.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "abandoned" | "blocked";
export interface TodoTask {
	id: number;
	text: string;
	status: TodoStatus;
	blocker?: string;
}
export interface TodoPhase {
	name: string;
	tasks: TodoTask[];
}
export interface TodoState {
	phases: TodoPhase[];
	nextId: number;
}
export interface TodoDetails extends TodoState {
	version: 2;
	action: TodoParams["action"];
	touchedPhases: string[];
}

const label = (description: string) => Type.String({ minLength: 1, description });
const TODO_ACTIONS = ["init", "append", "start", "done", "drop", "block", "unblock", "rm", "view", "clear"] as const;
export const TodoSchema = Type.Object(
	{
		action: StringEnum(TODO_ACTIONS),
		phases: Type.Optional(
			Type.Array(
				Type.Object(
					{
						name: label("Unique phase name"),
						items: Type.Array(label("Task text; unique within this phase"), { minItems: 1 }),
					},
					{ additionalProperties: false },
				),
				{ description: "Full replacement for init; [] clears the plan" },
			),
		),
		// 没有 minItems：无关 action 上的 items: [] 应被忽略，而不是 schema 硬报错；
		// init / append 自己校验非空，错误文案更明确。
		items: Type.Optional(Type.Array(label("Task text"), { description: "Tasks for append, or a flat init" })),
		id: Type.Optional(
			Type.Integer({
				minimum: 1,
				maximum: Number.MAX_SAFE_INTEGER - 1,
				description: "Task ID from the latest result; for done/drop/block/unblock/rm pass either id or phase",
			}),
		),
		phase: Type.Optional(
			label("Phase name: append target, default name for a flat init, or phase-wide done/drop/block/unblock/rm target"),
		),
		reason: Type.Optional(Type.String({ description: "Optional blocker note for block" })),
	},
	{ additionalProperties: false },
);
export type TodoParams = Static<typeof TodoSchema>;

export const emptyTodoState = (): TodoState => ({ phases: [], nextId: 1 });
export const allTasks = (phases: TodoPhase[]): TodoTask[] => phases.flatMap((phase) => phase.tasks);
export const isClosed = (task: TodoTask): boolean => task.status === "completed" || task.status === "abandoned";
export const isActionable = (task: TodoTask): boolean => task.status === "pending" || task.status === "in_progress";
export const cloneState = (state: TodoState): TodoState => ({
	nextId: state.nextId,
	phases: state.phases.map((phase) => ({ name: phase.name, tasks: phase.tasks.map((task) => ({ ...task })) })),
});

// 新输入归一成无 ANSI 的单行标签；旧快照只在显示时清洗，保留原始任务文本。
export const plainTodoText = (text: string): string => toSingleLine(stripAnsi(text).replace(/\s+/g, " ")).trim();
const requiredLabel = (text: string | undefined, field: string): string => {
	const normalized = plainTodoText(text ?? "");
	if (!normalized) throw new Error(`${field} must not be empty`);
	return normalized;
};

export function todoCounts(tasks: TodoTask[]) {
	const completed = tasks.filter((task) => task.status === "completed").length;
	const abandoned = tasks.filter((task) => task.status === "abandoned").length;
	const blocked = tasks.filter((task) => task.status === "blocked").length;
	return {
		total: tasks.length,
		completed,
		abandoned,
		blocked,
		closed: completed + abandoned,
		open: tasks.length - completed - abandoned - blocked,
	};
}

export function activeTask(phases: TodoPhase[]): { phase: TodoPhase; task: TodoTask } | undefined {
	for (const status of ["in_progress", "pending"] as const) {
		for (const phase of phases) {
			const task = phase.tasks.find((candidate) => candidate.status === status);
			if (task) return { phase, task };
		}
	}
	return undefined;
}

function normalizeActive(phases: TodoPhase[]): void {
	let active: TodoTask | undefined;
	const tasks = allTasks(phases);
	for (const task of tasks) {
		if (task.status !== "blocked") delete task.blocker;
		if (task.status !== "in_progress") continue;
		if (active) task.status = "pending";
		else active = task;
	}
	if (!active) {
		const pending = tasks.find((task) => task.status === "pending");
		if (pending) pending.status = "in_progress";
	}
}

/** 同时接受 id 和 phase 的操作：目标二选一，两个都传属于歧义。 */
const DUAL_TARGET: readonly TodoParams["action"][] = ["done", "drop", "block", "unblock", "rm"];
/** 扁平 init 的默认 phase 名。 */
const DEFAULT_PHASE = "Tasks";

/** 在副本上执行；校验失败直接 throw，调用方只提交成功返回的 state。 */
export function applyTodo(
	state: TodoState,
	params: TodoParams,
): { state: TodoState; message: string; touchedPhases: string[] } {
	if (!TODO_ACTIONS.includes(params.action)) throw new Error(`Unknown todo action: ${params.action}`);
	// 不适用于当前 action 的字段一律忽略；只有「目标歧义」才报错。
	if (DUAL_TARGET.includes(params.action) && params.id !== undefined && params.phase !== undefined) {
		throw new Error("Use either id or phase, not both");
	}
	if (params.action === "clear" && (params.id !== undefined || params.phase !== undefined)) {
		throw new Error("clear removes the whole plan; use rm with id or phase to remove specific tasks");
	}
	const next = cloneState(state);
	const touched = new Set<string>();
	let message = "";

	const newTasks = (items: string[] | undefined, existing: TodoTask[] = []): TodoTask[] => {
		if (!items?.length) throw new Error("items must contain at least one task");
		const seen = new Set(existing.map((task) => plainTodoText(task.text)));
		return items.map((item) => {
			const text = requiredLabel(item, "Task text");
			if (seen.has(text)) throw new Error(`Duplicate task in phase: "${text}"`);
			seen.add(text);
			if (!Number.isSafeInteger(next.nextId) || next.nextId >= Number.MAX_SAFE_INTEGER)
				throw new Error("Todo ID limit reached");
			return { id: next.nextId++, text, status: "pending" };
		});
	};
	// usePhase=false 的操作（start）忽略 phase，不能让它静默命中整组任务。
	const targets = (usePhase: boolean, required: boolean): TodoTask[] => {
		if (params.id !== undefined) {
			if (!Number.isSafeInteger(params.id) || params.id < 1) throw new Error("id must be a positive integer");
			for (const phase of next.phases) {
				const task = phase.tasks.find((candidate) => candidate.id === params.id);
				if (task) {
					touched.add(phase.name);
					return [task];
				}
			}
			throw new Error(`Todo #${params.id} not found. Use view to read the current IDs.`);
		}
		if (usePhase && params.phase !== undefined) {
			const name = requiredLabel(params.phase, "phase");
			const phase = next.phases.find((candidate) => candidate.name === name);
			if (!phase) throw new Error(`Phase "${name}" not found`);
			touched.add(phase.name);
			return phase.tasks;
		}
		if (required) throw new Error(`${params.action} requires ${usePhase ? "id or phase" : "id"}`);
		for (const phase of next.phases) touched.add(phase.name);
		return allTasks(next.phases);
	};

	switch (params.action) {
		case "view":
			// 纯读取绝不推进状态（包括旧会话里的多个 active）。
			return { state: next, message: "", touchedPhases: [] };
		case "init": {
			// 模型常把单 phase 的 init 写成扁平 items（可能带一个裸 phase）；
			// 这是可恢复的常见写法，合成一个默认 phase 而不是逼它重试。
			const list =
				params.phases ??
				(params.items?.length ? [{ name: params.phase ?? DEFAULT_PHASE, items: params.items }] : undefined);
			if (!list) throw new Error("init requires phases: [{name, items}] or items: [...]; use phases: [] to clear");
			next.phases = list.map((phase) => {
				const name = requiredLabel(phase.name, "Phase name");
				if (touched.has(name)) throw new Error(`Duplicate phase: "${name}"`);
				touched.add(name);
				return { name, tasks: newTasks(phase.items) };
			});
			message = `Planned ${allTasks(next.phases).length} tasks in ${next.phases.length} phases`;
			break;
		}
		case "append": {
			const name = requiredLabel(params.phase, "phase");
			let phase = next.phases.find((candidate) => candidate.name === name);
			const tasks = newTasks(params.items, phase?.tasks);
			if (!phase) {
				phase = { name, tasks: [] };
				next.phases.push(phase);
			}
			phase.tasks.push(...tasks);
			touched.add(name);
			message = `Appended ${tasks.length} tasks to "${name}"`;
			break;
		}
		case "start": {
			const [task] = targets(false, true);
			for (const other of allTasks(next.phases)) {
				if (other.status === "in_progress") other.status = "pending";
			}
			task.status = "in_progress";
			message = `Started #${task.id}: ${task.text}`;
			break;
		}
		case "done":
		case "drop":
		case "block":
		case "unblock": {
			const tasks = targets(true, params.action === "block" || params.action === "unblock");
			let changed = 0;
			for (const task of tasks) {
				if (params.action === "block" && isClosed(task)) continue;
				if (params.action === "unblock" && task.status !== "blocked") continue;
				const status: TodoStatus =
					params.action === "done"
						? "completed"
						: params.action === "drop"
							? "abandoned"
							: params.action === "block"
								? "blocked"
								: "pending";
				const blocker = status === "blocked" ? plainTodoText(params.reason ?? "") || undefined : undefined;
				if (task.status !== status || task.blocker !== blocker) changed++;
				task.status = status;
				if (blocker) task.blocker = blocker;
				else delete task.blocker;
			}
			message = `${params.action}: updated ${changed} tasks`;
			break;
		}
		case "rm": {
			const remove = new Set(targets(true, false));
			for (const phase of next.phases) phase.tasks = phase.tasks.filter((task) => !remove.has(task));
			next.phases = next.phases.filter((phase) => phase.tasks.length > 0);
			message = `Removed ${remove.size} tasks`;
			break;
		}
		case "clear":
			message = `Cleared ${allTasks(next.phases).length} tasks`;
			next.phases = [];
			break;
	}
	normalizeActive(next.phases);
	return { state: next, message, touchedPhases: [...touched] };
}

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const positiveInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const statuses: readonly string[] = ["pending", "in_progress", "completed", "abandoned", "blocked"];

/** 新分层快照 / 旧 todos（含 done 布尔）→ 防御性副本；坏快照整体跳过。 */
export function readTodoSnapshot(details: unknown): TodoState | undefined {
	if (!record(details)) return;
	const readTasks = (input: unknown, legacy = false): TodoTask[] | undefined => {
		if (!Array.isArray(input)) return;
		const result: TodoTask[] = [];
		for (const raw of input) {
			if (!record(raw) || !positiveInteger(raw.id) || raw.id >= Number.MAX_SAFE_INTEGER || typeof raw.text !== "string")
				return;
			const status = raw.status ?? (legacy ? (raw.done ? "completed" : "pending") : undefined);
			if (typeof status !== "string" || !statuses.includes(status)) return;
			const task: TodoTask = { id: raw.id, text: raw.text, status: status as TodoStatus };
			if (status === "blocked" && typeof raw.blocker === "string") task.blocker = raw.blocker;
			result.push(task);
		}
		return result;
	};
	const phases: TodoPhase[] = [];
	if (Array.isArray(details.phases)) {
		for (const raw of details.phases) {
			if (!record(raw) || typeof raw.name !== "string") return;
			const tasks = readTasks(raw.tasks);
			if (!tasks) return;
			phases.push({ name: raw.name, tasks });
		}
	} else {
		const tasks = readTasks(details.todos, true);
		if (!tasks) return;
		if (tasks.length > 0) phases.push({ name: "Tasks", tasks });
	}
	const ids = new Set<number>();
	let nextId = positiveInteger(details.nextId) ? details.nextId : 1;
	for (const task of allTasks(phases)) {
		if (ids.has(task.id)) return;
		ids.add(task.id);
		nextId = Math.max(nextId, task.id + 1);
	}
	return { phases, nextId };
}

/** 仅遍历当前分支，避免把被放弃分支的状态带回来。 */
export function restoreTodos(entries: readonly unknown[]): TodoState {
	let state = emptyTodoState();
	for (const entry of entries) {
		if (!record(entry) || entry.type !== "message" || !record(entry.message)) continue;
		const message = entry.message;
		if (message.role !== "toolResult" || message.toolName !== "todo" || message.isError) continue;
		const details = message.details;
		if (!record(details) || details.error || details.action === "view") continue;
		const snapshot = readTodoSnapshot(details);
		if (!snapshot) continue;
		// 老 clear 会把 nextId 重置为 1；迁移时仍保留这条分支已分配过的 ID 上界。
		state = { phases: snapshot.phases, nextId: Math.max(state.nextId, snapshot.nextId) };
	}
	return state;
}

/** 完整分层快照：工具结果是状态的唯一权威载体，所以不做折叠。 */
export function snapshotText(phases: TodoPhase[]): string {
	const counts = todoCounts(allTasks(phases));
	if (counts.total === 0) return "No todos";
	const lines = [
		`Todos: ${counts.completed} completed, ${counts.abandoned} abandoned, ${counts.open} open, ${counts.blocked} blocked (${counts.total} total).`,
	];
	const current = activeTask(phases);
	if (current) {
		lines.push(
			`Current: #${current.task.id} [${current.task.status}] ${plainTodoText(current.task.text)} — phase "${plainTodoText(current.phase.name)}".`,
		);
		const index = phases.indexOf(current.phase);
		if (phases.slice(index + 1).some((phase) => phase.tasks.some(isClosed))) {
			lines.push("Automatic advance follows phase order; later completed tasks stay closed.");
		}
	} else if (counts.blocked) lines.push("No actionable tasks; remaining work is blocked.");
	for (const phase of phases) {
		const closed = phase.tasks.filter(isClosed).length;
		lines.push(`${plainTodoText(phase.name)} (${closed}/${phase.tasks.length} closed):`);
		for (const task of phase.tasks) {
			lines.push(
				`  #${task.id} [${task.status}] ${plainTodoText(task.text)}${task.blocker ? ` — ${plainTodoText(task.blocker)}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

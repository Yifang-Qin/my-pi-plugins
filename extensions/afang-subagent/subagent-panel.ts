// afang-subagent 的用户侧交互面板：`/subagent`（别名 `/sa`）命令唤起的 overlay 组件。
//
// 与 tmux-bash 的 `/bg` 面板同构（列表 → Enter 看轨迹 → x 单杀带 y/n 确认 → 1s 自刷新），
// 但数据源不同：这里读 afang-subagent 的统一任务快照（snapshotSubagentTasks），覆盖
//   - 前台 live 任务（parallel/chain/single 的每个 child，同步跑在某次工具调用里）；
//   - 后台 background 任务（detached 子 pi）。
// 每个 child 持有自己的 AbortController，故 x 可单杀某一个而不动同批其余（见 index.ts
// runTrackedAgent）。因为扩展命令在流式期间也能立即执行，所以并行还在同步跑的当口，用户照样
// 能开面板挑一个杀掉。
//
// 「完成轨迹」= 该 child 子进程流式积累的 messages，用 index.ts 的 getDisplayItems +
// formatToolCall 渲成一条时间线（→ read x / → bash … / text…），与单 agent expanded 结果一致，
// 只是改成从 registry 实时读、每秒刷新。
//
// 前台任务被 kill 无需额外通知 assistant：它那条聚合结果会在正在 await 的工具输出里显示为
// aborted，模型自然看得到（这点与 `/bg` 面板 kill 后台任务需 notifyUserKilled 不同）。

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type BgStatus,
	formatToolCall,
	formatUsageStats,
	getDisplayItems,
	isFailedResult,
	type SubagentPanelTask,
} from "./render-helpers.ts";

// index.ts 通过依赖注入把「读取 pi 入口那个实例的状态」的闭包传进来。为什么不直接
// import index.ts：见 render-helpers.ts 头注释（/reload 的 cache-busting query 会令 index.ts 双实例，
// 面板若 import 它会读到空的另一份 registry）。
export interface SubagentPanelDeps {
	snapshot: () => SubagentPanelTask[];
	kill: (id: string) => "killed" | "not-running" | "unknown";
	setRunningCount: (running: number) => void;
}

const REFRESH_MS = 1000;
const PANEL_WIDTH_PCT = 0.9;
const PANEL_HEIGHT_PCT = 0.85;
const MIN_BODY_ROWS = 3;
const TASK_PREVIEW_CHARS = 100;

function fmtElapsed(startedAtMs: number): string {
	const s = (Date.now() - startedAtMs) / 1000;
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	return `${m}m${Math.floor(s % 60)}s`;
}

function statusIcon(status: BgStatus): string {
	switch (status) {
		case "running":
			return "●";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
		case "cancelled":
			return "⊘";
	}
}

function statusColor(t: SubagentPanelTask) {
	switch (t.status) {
		case "running":
			return "accent";
		case "completed":
			return isFailedResult(t.result) ? "error" : "success";
		default:
			return "error";
	}
}

function kindLabel(t: SubagentPanelTask): string {
	return t.kind === "background" ? "bg" : t.kind;
}

// 运行中排前，其余按开始时间。
function sortTasks(tasks: SubagentPanelTask[]): SubagentPanelTask[] {
	const rank = (s: BgStatus) => (s === "running" ? 0 : 1);
	return [...tasks].sort((a, b) => {
		const d = rank(a.status) - rank(b.status);
		return d !== 0 ? d : a.startedAtMs - b.startedAtMs;
	});
}

// 把某任务的子进程轨迹拍平成「已上色」的行数组（供输出视图滚动展示）。
function trajectoryLines(t: SubagentPanelTask, th: Theme): string[] {
	const lines: string[] = [];
	const topic = t.topic ? th.fg("muted", ` (${t.topic})`) : "";
	lines.push(th.fg("muted", "Agent: ") + th.fg("accent", t.agentName) + topic + th.fg("muted", ` · ${t.agentSource}`));
	lines.push(th.fg("muted", "Task: ") + th.fg("dim", t.task));
	lines.push("");

	const items = getDisplayItems(t.result.messages);
	if (items.length === 0) {
		lines.push(th.fg("muted", t.status === "running" ? "(running… no output yet)" : "(no output)"));
	} else {
		for (const item of items) {
			if (item.type === "toolCall") {
				lines.push(th.fg("muted", "→ ") + formatToolCall(item.name, item.args, th.fg.bind(th)));
			} else {
				const text = item.text.trimEnd();
				if (text) for (const l of text.split("\n")) lines.push(th.fg("toolOutput", l));
			}
		}
	}

	if (isFailedResult(t.result) && t.result.errorMessage) {
		lines.push("");
		lines.push(th.fg("error", `Error: ${t.result.errorMessage}`));
	}
	const usage = formatUsageStats(t.result.usage, t.result.model);
	if (usage) {
		lines.push("");
		lines.push(th.fg("dim", usage));
	}
	if (t.resultFile) lines.push(th.fg("dim", `Full result: ${t.resultFile}`));
	return lines;
}

function pad2(s: string, len: number): string {
	const vis = visibleWidth(s);
	return vis >= len ? s : s + " ".repeat(len - vis);
}
function padVisible(s: string, len: number): string {
	return s + " ".repeat(Math.max(0, len - visibleWidth(s)));
}

class SubagentPanel implements Component {
	private view: "list" | "output" = "list";
	private tasks: SubagentPanelTask[] = [];
	private selected = 0;

	// 输出（轨迹）视图状态。
	private outputId: string | null = null;
	private outputTitle = "";
	private outputLines: string[] = [];
	private outputScroll = 0;
	private outputFollow = true;
	private lastBodyRows = 10;

	private confirmKillId: string | null = null; // 非空 = 正在等 y/n 确认
	private notice = "";
	private disposed = false;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (result: undefined) => void,
		private notify: (message: string, level?: "info" | "warning" | "error") => void,
		private deps: SubagentPanelDeps,
	) {
		this.refresh();
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.refresh();
			if (this.view === "output") this.reloadOutput();
			this.tui.requestRender();
		}, REFRESH_MS);
	}

	private runningNow(): number {
		return this.tasks.filter((t) => t.status === "running").length;
	}

	// —— 数据 —— //

	private refresh(): void {
		this.tasks = sortTasks(this.deps.snapshot());
		if (this.selected >= this.tasks.length) this.selected = Math.max(0, this.tasks.length - 1);
		this.deps.setRunningCount(this.runningNow());
	}

	private currentTask(): SubagentPanelTask | undefined {
		return this.tasks[this.selected];
	}

	private outputTask(): SubagentPanelTask | undefined {
		return this.outputId ? this.tasks.find((t) => t.id === this.outputId) : undefined;
	}

	private reloadOutput(): void {
		const t = this.outputTask();
		if (!t) return;
		this.outputLines = trajectoryLines(t, this.theme);
	}

	private openOutput(t: SubagentPanelTask): void {
		this.outputId = t.id;
		const preview = t.task.length > TASK_PREVIEW_CHARS ? `${t.task.slice(0, TASK_PREVIEW_CHARS)}…` : t.task;
		this.outputTitle = `${t.id} · ${t.agentName} · ${preview}`;
		this.outputScroll = 0;
		this.outputFollow = true;
		this.reloadOutput();
		this.view = "output";
	}

	private doKill(id: string): void {
		const r = this.deps.kill(id);
		let msg: string;
		let level: "info" | "warning";
		if (r === "killed") {
			msg = `已终止 ${id}`;
			level = "info";
		} else if (r === "not-running") {
			msg = `${id} 已结束，无需终止`;
			level = "info";
		} else {
			msg = `未找到任务 ${id}`;
			level = "warning";
		}
		this.notice = msg;
		this.notify(msg, level);
		this.refresh();
	}

	private maxOutputScroll(): number {
		return Math.max(0, this.outputLines.length - this.lastBodyRows);
	}

	private clampOutputScroll(): void {
		const max = this.maxOutputScroll();
		if (this.outputScroll >= max) {
			this.outputScroll = max;
			this.outputFollow = true;
		}
	}

	// —— 键盘 —— //

	handleInput(data: string): void {
		if (this.confirmKillId) {
			if (matchesKey(data, "escape") || matchesKey(data, "n")) {
				this.confirmKillId = null;
			} else if (matchesKey(data, "y") || matchesKey(data, "return")) {
				const id = this.confirmKillId;
				this.confirmKillId = null;
				this.doKill(id);
			} else {
				return;
			}
			this.tui.requestRender();
			return;
		}

		if (this.view === "list") this.handleListInput(data);
		else this.handleOutputInput(data);
	}

	private handleListInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done(undefined);
			return;
		}
		if (matchesKey(data, "up")) {
			this.selected = Math.max(0, this.selected - 1);
			this.notice = "";
		} else if (matchesKey(data, "down")) {
			this.selected = Math.min(Math.max(0, this.tasks.length - 1), this.selected + 1);
			this.notice = "";
		} else if (matchesKey(data, "return")) {
			const t = this.currentTask();
			if (t) this.openOutput(t);
		} else if (matchesKey(data, "x")) {
			const t = this.currentTask();
			if (t?.killable) this.confirmKillId = t.id;
			else if (t) this.notice = `任务已${t.status === "cancelled" ? "终止" : "结束"}，无需 kill`;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private handleOutputInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.view = "list";
			this.outputId = null;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "x")) {
			const t = this.outputTask();
			if (t?.killable) {
				this.confirmKillId = t.id;
				this.tui.requestRender();
			}
			return;
		}
		const page = Math.max(1, this.lastBodyRows - 1);
		if (matchesKey(data, "up")) {
			this.outputScroll = Math.max(0, this.outputScroll - 1);
			this.outputFollow = false;
		} else if (matchesKey(data, "down")) {
			this.outputScroll += 1;
			this.clampOutputScroll();
		} else if (matchesKey(data, "pageUp")) {
			this.outputScroll = Math.max(0, this.outputScroll - page);
			this.outputFollow = false;
		} else if (matchesKey(data, "pageDown")) {
			this.outputScroll += page;
			this.clampOutputScroll();
		} else if (matchesKey(data, "home")) {
			this.outputScroll = 0;
			this.outputFollow = false;
		} else if (matchesKey(data, "end")) {
			this.outputFollow = true;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	// —— 绘制 —— //

	private panelWidth(termWidth: number): number {
		return Math.max(40, Math.min(termWidth - 2, Math.floor(termWidth * PANEL_WIDTH_PCT)));
	}

	private bodyRows(): number {
		const rows = this.tui.terminal?.rows ?? 24;
		const budget = Math.max(MIN_BODY_ROWS + 4, Math.floor(rows * PANEL_HEIGHT_PCT));
		return Math.max(MIN_BODY_ROWS, budget - 5);
	}

	render(width: number): string[] {
		const w = this.panelWidth(width);
		const innerW = w - 2;
		const th = this.theme;
		const bodyRows = this.bodyRows();
		this.lastBodyRows = bodyRows;

		const pad = (s: string, len: number) => s + " ".repeat(Math.max(0, len - visibleWidth(s)));
		const fit = (s: string) => truncateToWidth(s, innerW);
		const row = (content: string) => th.fg("border", "│") + pad(fit(content), innerW) + th.fg("border", "│");
		const top = th.fg("border", `╭${"─".repeat(innerW)}╮`);
		const bottom = th.fg("border", `╰${"─".repeat(innerW)}╯`);
		const sep = th.fg("border", `├${"─".repeat(innerW)}┤`);

		if (this.view === "output") return this.renderOutput(th, innerW, bodyRows, row, top, bottom, sep);
		return this.renderList(th, innerW, bodyRows, row, top, bottom, sep);
	}

	private renderList(
		th: Theme,
		innerW: number,
		bodyRows: number,
		row: (c: string) => string,
		top: string,
		bottom: string,
		sep: string,
	): string[] {
		const running = this.runningNow();
		const titleText = ` ${th.fg("accent", "⚙ subagent 任务")}  ${th.fg("muted", `${running} 运行中 / ${this.tasks.length} 共`)}`;
		const notice = this.notice ? `  ${th.fg("warning", this.notice)}` : "";
		const lines: string[] = [top, row(titleText + notice), sep];

		if (this.tasks.length === 0) {
			lines.push(row(""));
			lines.push(row(` ${th.fg("muted", "（当前没有 subagent 任务）")}`));
			for (let i = 3; i < bodyRows; i++) lines.push(row(""));
		} else {
			let start = 0;
			if (this.tasks.length > bodyRows) {
				start = Math.min(Math.max(0, this.selected - Math.floor(bodyRows / 2)), this.tasks.length - bodyRows);
			}
			const slice = this.tasks.slice(start, start + bodyRows);
			for (let i = 0; i < bodyRows; i++) {
				const t = slice[i];
				if (!t) {
					lines.push(row(""));
					continue;
				}
				lines.push(row(this.taskLine(th, t, start + i === this.selected, innerW)));
			}
		}

		lines.push(this.footer(th, innerW, this.listHint(th)));
		lines.push(bottom);
		return lines;
	}

	private taskLine(th: Theme, t: SubagentPanelTask, selected: boolean, innerW: number): string {
		const iconRaw = statusIcon(t.status);
		const dur = fmtElapsed(t.startedAtMs);
		const prefixRaw = selected ? " ▶ " : "   ";
		const turns = t.result.usage.turns > 0 ? `${t.result.usage.turns}t` : "";
		// 定宽头部（prefix + id + 图标 + kind + agent + turns + dur），task 铺满剩余。
		const headPlain = `${prefixRaw}${pad2(t.id, 8)} ${iconRaw} ${pad2(kindLabel(t), 9)} ${pad2(t.agentName, 14)} ${pad2(turns, 4)} ${pad2(dur, 6)}  `;
		const taskBudget = Math.max(4, innerW - visibleWidth(headPlain));
		const taskText = truncateToWidth(t.task, taskBudget);
		const prefix = selected ? th.fg("accent", prefixRaw) : prefixRaw;
		const icon = th.fg(statusColor(t), iconRaw);
		const taskStyled = selected ? th.fg("text", taskText) : th.fg("dim", taskText);
		return (
			`${prefix}${th.fg("muted", pad2(t.id, 8))} ${icon} ${th.fg("dim", pad2(kindLabel(t), 9))} ` +
			`${th.fg("accent", pad2(t.agentName, 14))} ${th.fg("dim", pad2(turns, 4))} ${th.fg("muted", pad2(dur, 6))}  ${taskStyled}`
		);
	}

	private renderOutput(
		th: Theme,
		innerW: number,
		bodyRows: number,
		row: (c: string) => string,
		top: string,
		bottom: string,
		sep: string,
	): string[] {
		const t = this.outputTask();
		const statusText = t ? t.status : "已结束";
		const titleText = ` ${th.fg("accent", "轨迹")} ${th.fg("muted", this.outputTitle)}  ${th.fg("muted", `[${statusText}]`)}`;
		const lines: string[] = [top, row(titleText), sep];

		if (this.outputFollow) this.outputScroll = this.maxOutputScroll();
		const start = Math.min(this.outputScroll, this.maxOutputScroll());
		const slice = this.outputLines.slice(start, start + bodyRows);
		for (let i = 0; i < bodyRows; i++) {
			const line = slice[i];
			lines.push(row(line === undefined ? "" : ` ${line}`));
		}

		lines.push(this.footer(th, innerW, this.outputHint(th, start)));
		lines.push(bottom);
		return lines;
	}

	private footer(th: Theme, innerW: number, hint: string): string {
		const content = this.confirmKillId
			? ` ${th.fg("error", `⚠ kill ${this.confirmKillId} ?`)}  ${th.fg("accent", "y")} 确认 · ${th.fg("accent", "n")} 取消`
			: ` ${hint}`;
		return th.fg("border", "│") + padVisible(truncateToWidth(content, innerW), innerW) + th.fg("border", "│");
	}

	private listHint(th: Theme): string {
		return th.fg(
			"muted",
			`↑↓ 选择 · ${th.fg("dim", "Enter")} 看轨迹 · ${th.fg("dim", "x")} kill · ${th.fg("dim", "Esc")} 退出`,
		);
	}

	private outputHint(th: Theme, start: number): string {
		const follow = this.outputFollow ? th.fg("success", "跟随尾部") : th.fg("dim", `行 ${start + 1}+`);
		return th.fg(
			"muted",
			`↑↓/PgUp/PgDn 滚动 · ${follow} · ${th.fg("dim", "x")} kill · ${th.fg("dim", "Esc")} 返回`,
		);
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

// 打开 /subagent 面板。返回 Promise，用户 Esc/q 关闭后 resolve。
// deps 由 index.ts 注入（snapshot/kill/setRunningCount），确保读写的是 pi 入口实例的 registry。
export async function openSubagentPanel(ctx: ExtensionCommandContext, deps: SubagentPanelDeps): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new SubagentPanel(tui, theme, done, (msg, level) => ctx.ui.notify(msg, level), deps),
		{
			overlay: true,
			overlayOptions: {
				width: `${Math.round(PANEL_WIDTH_PCT * 100)}%`,
				maxHeight: `${Math.round(PANEL_HEIGHT_PCT * 100)}%`,
				anchor: "center",
			},
		},
	);
}

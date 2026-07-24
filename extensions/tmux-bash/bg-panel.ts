// tmux-bash 的用户侧交互面板：`/bg` 命令唤起的 overlay 组件。
//
// 交互（用户反馈定制）：
//   - 列表视图：↑↓ 移动，Enter 查看选中任务输出，x 请求 kill（内联 y/n 二次确认），
//     Esc/q 退出面板。
//   - 输出视图：↑↓/PageUp/PageDown/Home/End 滚动（默认跟随尾部），x kill 当前查看的任务，
//     Esc/q 返回列表。
//   - 面板每秒自刷新：运行中任务的耗时实时增长、状态从 running→completed 自动更新、输出视图
//     跟随尾部。完成通知仍由 runtime 的 fs.watch watcher 独立发送，面板刷新纯展示、无副作用
//     （listJobsForSession 只读）；只有 x kill 这类用户动作才 reconcile + 改状态。
//
// 与模型用的 `bg` 工具共用同一套 runtime helper（listJobsForSession / readJobLogs /
// killWindow+markJobKilled / reconcileCompletedJobs），只多包一层键盘交互与绘制。

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateLine } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { fmtDuration, fmtJobStatus } from "./format.js";
import {
	listJobsForSession,
	markJobKilled,
	notifyUserKilled,
	readJobLogs,
	reconcileCompletedJobs,
	type BackgroundJobInfo,
	type JobLogSnapshot,
	type RuntimeState,
} from "./runtime.js";
import { killWindow } from "./tmux.js";

const REFRESH_MS = 1000;
const CMD_CHARS = 100;
const PANEL_WIDTH_PCT = 0.9;
const PANEL_HEIGHT_PCT = 0.85;
const MIN_BODY_ROWS = 3;

function statusIcon(status: string): string {
	if (status === "running") return "●";
	if (status === "completed") return "✓";
	if (status === "killed") return "✗";
	if (status === "missing") return "⚠";
	return "·";
}

// 运行中/缺失窗口的任务排前，其余按开始时间。
function sortJobsForPanel(jobs: BackgroundJobInfo[]): BackgroundJobInfo[] {
	const active = (s: string) => (s === "running" || s === "missing" ? 0 : 1);
	return [...jobs].sort((a, b) => {
		const d = active(a.status) - active(b.status);
		return d !== 0 ? d : (a.startedAt ?? 0) - (b.startedAt ?? 0);
	});
}

function isKillable(job: BackgroundJobInfo): boolean {
	return job.status === "running" || job.status === "missing";
}

class BgPanel implements Component {
	private view: "list" | "output" = "list";
	private jobs: BackgroundJobInfo[] = [];
	private selected = 0;

	// 输出视图状态。
	private outputWindowId: string | null = null;
	private outputTitle = "";
	private outputLines: string[] = [];
	private outputTruncated = false;
	private outputFullPath?: string;
	private outputScroll = 0; // 顶部起始行
	private outputFollow = true; // 是否跟随尾部
	private lastBodyRows = 10; // render 时算出的可视正文行数，供翻页用

	private confirmKillWindow: string | null = null; // 非空 = 正在等 y/n 确认
	private notice = ""; // 顶部临时提示（kill 结果等）
	private disposed = false;
	private timer: ReturnType<typeof setInterval>;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: (result: undefined) => void,
		private pi: ExtensionAPI,
		private state: RuntimeState,
		private notify: (message: string, level?: "info" | "warning" | "error") => void,
		// 用户从面板手动杀掉一个仍在运行的任务时回调（用于通知 assistant）；logs 在杀之前读好。
		private onUserKill: (info: BackgroundJobInfo, logs: JobLogSnapshot) => void,
		// 把当前运行中数写回 footer 状态栏（面板开着时也能实时刷新，不必等关面板）。
		private setRunningCount: (running: number) => void,
	) {
		this.refreshJobs();
		this.setRunningCount(this.runningNow());
		this.timer = setInterval(() => {
			if (this.disposed) return;
			this.refreshJobs();
			this.setRunningCount(this.runningNow());
			if (this.view === "output") this.reloadOutput();
			this.tui.requestRender();
		}, REFRESH_MS);
	}

	// 当前快照里的运行中任务数（与 footer 统计口径一致）。
	private runningNow(): number {
		return this.jobs.filter((j) => j.status === "running").length;
	}

	// —— 数据 —— //

	private refreshJobs(): void {
		this.jobs = sortJobsForPanel(listJobsForSession(this.state));
		if (this.selected >= this.jobs.length) this.selected = Math.max(0, this.jobs.length - 1);
	}

	private currentJob(): BackgroundJobInfo | undefined {
		return this.jobs[this.selected];
	}

	private outputJob(): BackgroundJobInfo | undefined {
		return this.outputWindowId ? this.jobs.find((j) => j.windowId === this.outputWindowId) : undefined;
	}

	private reloadOutput(): void {
		if (!this.outputWindowId) return;
		const job = this.outputJob();
		const { text, truncated, fullPath } = readJobLogs(
			this.state,
			this.outputWindowId,
			job?.outputFile,
			this.state.options.maxLines,
		);
		this.outputLines = (text || "(no output)").split("\n");
		this.outputTruncated = truncated;
		this.outputFullPath = fullPath;
	}

	private openOutput(job: BackgroundJobInfo): void {
		this.outputWindowId = job.windowId;
		this.outputTitle = `${job.windowId} · ${truncateLine(job.command || "(shell)", CMD_CHARS).text}`;
		this.outputScroll = 0;
		this.outputFollow = true;
		this.reloadOutput();
		this.view = "output";
	}

	private doKill(windowId: string): void {
		// 面板当前快照里的任务信息（含命令/outputFile/startedAt，供通知 assistant 用）。
		const info = this.jobs.find((j) => j.windowId === windowId);
		// 【先读日志再杀】：趁窗口还活着，.out 读不到时 capture-pane 可兜底（避免杀后窗口消失
		// 导致通知里“(no output)”，尤其多次 reload 后 .out 可能已被回收）。
		const logs = readJobLogs(this.state, windowId, info?.outputFile, this.state.options.maxLines);
		// 先后各对一次哨兵，避免「命令刚完成、watcher 尚未处理」时误杀（对齐 bg 工具）。
		reconcileCompletedJobs(this.state, this.pi);
		const ok = killWindow(this.state.options, windowId);
		reconcileCompletedJobs(this.state, this.pi);
		const job = [...this.state.jobs.values()].find((j) => j.windowId === windowId);
		// 以 killWindow 结果为准（权威信号）；markJobKilled 仅更新内存状态（reload 后从 tmux 标签
		// 恢复的运行中任务不在 state.jobs，但窗口仍可被 kill）。
		let msg: string;
		let level: "info" | "warning";
		if (job?.status === "completed") {
			// 杀之前刚好自然完成：handleCompletion 已发过完成通知，这里不再重复通知 assistant。
			msg = `任务 ${windowId} 已完成（exit ${job.exitCode ?? "?"}），无需 kill`;
			level = "info";
		} else if (ok) {
			markJobKilled(this.state, windowId);
			msg = `已 kill ${windowId}`;
			level = "info";
			// 确实杀掉了一个运行中任务 → 通知 assistant（用户手动 kill，附杀前读好的尾部输出）。
			if (info) this.onUserKill(info, logs);
		} else {
			msg = `窗口 ${windowId} 已不存在（可能已结束）`;
			level = "warning";
		}
		this.notice = msg; // 面板内即时反馈
		this.notify(msg, level); // 持久 TUI 通知（关面板后仍可见）
		this.refreshJobs();
		this.setRunningCount(this.runningNow()); // kill 后立即刷新 footer 计数
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
		// kill 确认态优先，吞掉其余按键。
		if (this.confirmKillWindow) {
			if (matchesKey(data, "escape") || matchesKey(data, "n")) {
				this.confirmKillWindow = null;
			} else if (matchesKey(data, "y") || matchesKey(data, "return")) {
				const w = this.confirmKillWindow;
				this.confirmKillWindow = null;
				this.doKill(w);
			} else {
				return; // 其它键无效，不重绘
			}
			this.tui.requestRender();
			return;
		}

		if (this.view === "list") {
			this.handleListInput(data);
			return;
		}
		this.handleOutputInput(data);
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
			this.selected = Math.min(Math.max(0, this.jobs.length - 1), this.selected + 1);
			this.notice = "";
		} else if (matchesKey(data, "return")) {
			const job = this.currentJob();
			if (job) this.openOutput(job);
		} else if (matchesKey(data, "x")) {
			const job = this.currentJob();
			if (job && isKillable(job)) this.confirmKillWindow = job.windowId;
			else if (job) this.notice = `任务已${job.status === "killed" ? "终止" : "结束"}，无需 kill`;
		} else {
			return;
		}
		this.tui.requestRender();
	}

	private handleOutputInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.view = "list";
			this.outputWindowId = null;
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "x")) {
			const job = this.outputJob();
			if (job && isKillable(job)) {
				this.confirmKillWindow = job.windowId;
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
		// chrome：上边框 + 标题 + 分隔 + 底部提示 + 下边框 = 5 行。
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
		const running = this.jobs.filter((j) => j.status === "running").length;
		const titleText = ` ${th.fg("accent", "⏻ 后台任务")}  ${th.fg("muted", `${running} 运行中 / ${this.jobs.length} 共`)}`;
		const notice = this.notice ? `  ${th.fg("warning", this.notice)}` : "";

		const lines: string[] = [top, row(titleText + notice), sep];

		if (this.jobs.length === 0) {
			lines.push(row(""));
			lines.push(row(` ${th.fg("muted", "（当前会话没有后台任务）")}`));
			for (let i = 3; i < bodyRows; i++) lines.push(row(""));
		} else {
			// 让选中项保持可见的滚动窗口。
			let start = 0;
			if (this.jobs.length > bodyRows) {
				start = Math.min(
					Math.max(0, this.selected - Math.floor(bodyRows / 2)),
					this.jobs.length - bodyRows,
				);
			}
			const slice = this.jobs.slice(start, start + bodyRows);
			for (let i = 0; i < bodyRows; i++) {
				const job = slice[i];
				if (!job) {
					lines.push(row(""));
					continue;
				}
				lines.push(row(this.jobLine(th, job, start + i === this.selected, innerW)));
			}
		}

		lines.push(this.footer(th, innerW, this.listHint(th)));
		lines.push(bottom);
		return lines;
	}

	private jobLine(th: Theme, job: BackgroundJobInfo, selected: boolean, innerW: number): string {
		const iconRaw = statusIcon(job.status);
		const iconColor =
			job.status === "running"
				? "success"
				: job.status === "completed"
					? job.exitCode === 0
						? "success"
						: "error"
					: job.status === "killed" || job.status === "missing"
						? "error"
						: "muted";
		const status = fmtJobStatus(job);
		const dur = fmtDuration(job.startedAt, job.finishedAt);
		const prefixRaw = selected ? " ▶ " : "   ";
		// 定宽头部（window_id + 图标 + 状态 + 耗时 + "$ "）；命令铺满剩余。用 plain 串精确算
		// 预算（visibleWidth 忽略 ANSI），与下方 styled 拼串宽度一致 → 总宽 ≤ innerW，row() 只需补白。
		const headPlain = `${prefixRaw}${job.windowId}  ${iconRaw} ${pad2(status, 18)} ${pad2(dur, 5)}  $ `;
		const cmdBudget = Math.max(4, innerW - visibleWidth(headPlain));
		const cmd = truncateToWidth(job.command || "(shell)", cmdBudget);
		const prefix = selected ? th.fg("accent", prefixRaw) : prefixRaw;
		const icon = th.fg(iconColor, iconRaw);
		const cmdStyled = selected ? th.fg("text", cmd) : th.fg("dim", cmd);
		return `${prefix}${job.windowId}  ${icon} ${pad2(status, 18)} ${pad2(dur, 5)}  ${th.fg("muted", "$ ")}${cmdStyled}`;
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
		const job = this.outputJob();
		const statusText = job ? fmtJobStatus(job) : "已结束";
		const titleText = ` ${th.fg("accent", "输出")} ${th.fg("muted", this.outputTitle)}  ${th.fg("muted", `[${statusText}]`)}`;
		const lines: string[] = [top, row(titleText), sep];

		// 跟随尾部时把 scroll 钉到底部。
		if (this.outputFollow) this.outputScroll = this.maxOutputScroll();
		const start = Math.min(this.outputScroll, this.maxOutputScroll());
		const slice = this.outputLines.slice(start, start + bodyRows);
		for (let i = 0; i < bodyRows; i++) {
			const line = slice[i];
			lines.push(row(line === undefined ? "" : ` ${th.fg("toolOutput", line)}`));
		}

		lines.push(this.footer(th, innerW, this.outputHint(th, start)));
		lines.push(bottom);
		return lines;
	}

	// 底部提示行；kill 确认态时改显确认提示。
	private footer(th: Theme, innerW: number, hint: string): string {
		const content = this.confirmKillWindow
			? ` ${th.fg("error", `⚠ kill ${this.confirmKillWindow} ?`)}  ${th.fg("accent", "y")} 确认 · ${th.fg("accent", "n")} 取消`
			: ` ${hint}`;
		return th.fg("border", "│") + padVisible(truncateToWidth(content, innerW), innerW) + th.fg("border", "│");
	}

	private listHint(th: Theme): string {
		return th.fg(
			"muted",
			`↑↓ 选择 · ${th.fg("dim", "Enter")} 看输出 · ${th.fg("dim", "x")} kill · ${th.fg("dim", "Esc")} 退出`,
		);
	}

	private outputHint(th: Theme, start: number): string {
		const follow = this.outputFollow ? th.fg("success", "跟随尾部") : th.fg("dim", `行 ${start + 1}+`);
		const trunc = this.outputTruncated && this.outputFullPath ? th.fg("dim", ` · 完整日志: ${this.outputFullPath}`) : "";
		return th.fg(
			"muted",
			`↑↓/PgUp/PgDn 滚动 · ${follow} · ${th.fg("dim", "x")} kill · ${th.fg("dim", "Esc")} 返回${trunc}`,
		);
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

// 定宽右侧补空格（按显示宽度）。
function pad2(s: string, len: number): string {
	const vis = visibleWidth(s);
	return vis >= len ? s : s + " ".repeat(len - vis);
}
function padVisible(s: string, len: number): string {
	return s + " ".repeat(Math.max(0, len - visibleWidth(s)));
}

// 打开 /bg 面板。返回 Promise，用户 Esc/q 关闭后 resolve。
export async function openBgPanel(
	pi: ExtensionAPI,
	state: RuntimeState,
	ctx: ExtensionCommandContext,
	setRunningCount: (running: number) => void,
): Promise<void> {
	await ctx.ui.custom<undefined>(
		(tui, theme, _keybindings, done) =>
			new BgPanel(
				tui,
				theme,
				done,
				pi,
				state,
				(msg, level) => ctx.ui.notify(msg, level),
				// turn 内 steer / idle nextTurn；每次 kill 时实时判断 idle（面板开着时也可能因
				// 后台完成 triggerTurn 而进入 streaming）。logs 由面板在杀之前读好传入。
				(info, logs) => notifyUserKilled(state, pi, info, !ctx.isIdle(), logs),
				setRunningCount,
			),
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

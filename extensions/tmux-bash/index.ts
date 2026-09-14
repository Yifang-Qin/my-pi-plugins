// tmux-bash — 用 tmux 后台化覆盖 pi 内置 bash：
//
//   - 覆盖内置 bash（同名 registerTool 完全替换）：命令始终在 detached tmux 窗口里跑，
//     execute 前台同步等待并「流式转发」输出；未显式 timeout 时等 PI_TMUX_BASH_FOREGROUND_TIMEOUT
//     秒（默认 120s）超时「自动转后台」（不杀命令），完成后经 steer 自动通知模型；
//     显式 timeout 时保留内置「硬超时杀死（退出码 124）」语义，不转后台。
//   - background:true 立即后台，不等待（取代旧的 bg_start，用于 dev server / watcher 等）。
//   - 新增 bg 管理工具（action=list/logs/kill）管理转后台/显式后台的任务。
//
// 覆盖时对齐内置 bash 的所有形状（结果 content / details / isError / 错误文案 / 截断），
// 逐条清单见同目录 BUILTIN-BASH-REFERENCE.md。进程交给 tmux server 持有，pi 重启/reload/
// 退出都不影响后台任务。

import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { truncateLine, truncateTail, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toSingleLine, stripAnsi, collapseCarriageReturns } from "../shared/terminal-text.js";
import { COMPLETION_CUSTOM_TYPE, loadOptions, stripBgNotifyFrame } from "./config.js";
import { fmtDuration, fmtJobStatus } from "./format.js";
import { openBgPanel } from "./bg-panel.js";
import {
	cleanup,
	createState,
	listJobsForSession,
	listWindowsForSession,
	markJobKilled,
	readJobLogs,
	reconcileCompletedJobs,
	resetRunDir,
	resolveTimeoutMs,
	runForegroundBash,
	startBackgroundCommand,
	startWatcher,
	type RuntimeState,
	type SessionEnv,
} from "./runtime.js";
import { killWindow, tmuxAvailable } from "./tmux.js";

const STATUS_KEY = "tmux-bash";
const MAX_BG_LIST_JOBS = 50;
const MAX_BG_COMMAND_CHARS = 300;
// 完成/kill 通知在 TUI 历史里的折叠阈值（折叠时只显头部状态行 + 尾部最新输出，
// 可展开看全文）。发给 LLM 的 content 不受影响，仍按 maxLines/maxBytes 截断。
const COMPLETION_FOLD_HEAD = 4;
const COMPLETION_FOLD_TAIL = 10;
// 从内置 bash 的非零退出文案里回捞退出码（合并自原 bash-status-line 扩展）。
const EXIT_CODE_PATTERN = /Command exited with code (\d+)/;

// renderCall/renderResult 之间共享、跨重绘持久的渲染态（= tool-execution 的 rendererState）：
// 前台运行中的实时计时器，对齐内置 bash 的 "Elapsed X.Xs" 活计时。
type TimerState = { startedAt?: number; interval?: ReturnType<typeof setInterval> };

// renderer 只根据当前 tool args + 扩展配置推导「运行上限」；不把参数复制进 rendererState。
// 这样每个 tool row 的状态天然隔离，且 /reload 后不会留下另一份 args 快照。
type BashRenderArgs = {
	command?: string;
	timeout?: number;
	background?: boolean;
};

type RunningLimit =
	| { kind: "hard-timeout"; totalMs: number }
	| { kind: "foreground-timeout"; totalMs: number };

function runningLimitFor(args: BashRenderArgs | undefined, foregroundTimeoutMs: number): RunningLimit | null {
	// 拿不到 args（理论上不该发生，契约里 call/result 共享）时宁可不显示，也不按默认路径
	// 显示 auto-bg——那对带显式 timeout 的调用是误导。
	if (!args) return null;
	// background:true 当前会立即分离，timeout 也不会被执行；不能显示一个实际上不生效的上限。
	if (args.background) return null;
	const hardTimeoutMs = resolveTimeoutMs(args.timeout);
	if (hardTimeoutMs !== null) return { kind: "hard-timeout", totalMs: hardTimeoutMs };
	return { kind: "foreground-timeout", totalMs: foregroundTimeoutMs };
}

function formatLimitValue(totalMs: number): string {
	const seconds = totalMs / 1000;
	return Number.isInteger(seconds) ? `${seconds}s` : `${seconds.toFixed(1)}s`;
}

// 「配置上限」的文案单一来源：formatConfiguredLimit / formatRunningLimit 都从这里拼。
function describeLimit(limit: RunningLimit): string {
	return limit.kind === "hard-timeout"
		? `hard timeout ${formatLimitValue(limit.totalMs)}`
		: `auto-bg after ${formatLimitValue(limit.totalMs)}`;
}

function formatConfiguredLimit(args: BashRenderArgs | undefined, foregroundTimeoutMs: number): string {
	const limit = runningLimitFor(args, foregroundTimeoutMs);
	return limit ? describeLimit(limit) : "";
}

function formatRunningLimit(
	args: BashRenderArgs | undefined,
	foregroundTimeoutMs: number,
	startedAt: number | undefined,
	now: number,
): string {
	const limit = runningLimitFor(args, foregroundTimeoutMs);
	if (!limit || startedAt === undefined) return "";
	const remainingMs = Math.max(0, limit.totalMs - Math.max(0, now - startedAt));
	const remaining = remainingMs > 0 ? `${Math.ceil(remainingMs / 1000)}s left` : "due now";
	return ` · ${describeLimit(limit)} · ${remaining}`;
}

// 内置 bash 形状（command + timeout）保持不变，仅新增 background 开关。见 BUILTIN-BASH-REFERENCE.md §2/§7。
const BashParams = Type.Object({
	command: Type.String({ description: "The shell command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description:
				"Hard timeout in seconds. If set, the command is KILLED at the deadline (exit code 124) — it is NOT moved to the background. Leave unset to use the default foreground wait that auto-backgrounds long-running commands.",
		}),
	),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Start immediately in the background and return at once. Use for dev servers, watchers, or tasks you explicitly want detached. Do not wait or poll after starting it; completion is delivered automatically.",
		}),
	),
});

const BgParams = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("logs"), Type.Literal("kill")], {
		description: "list: all background jobs; logs: peek one job's output; kill: stop a job.",
	}),
	window: Type.Optional(Type.String({ description: "tmux #{window_id}, e.g. @123 (required for logs/kill)." })),
	lines: Type.Optional(
		Type.Number({
			description:
				"Max lines to return for logs. Shows the TAIL (most recent lines), not the head — read the full-log " +
				"path printed in the output for the complete log. Defaults to the configured cap.",
		}),
	),
});

const BASH_DESCRIPTION =
	"Execute a shell command in the current working directory. Returns stdout and stderr (merged), " +
	"truncated to the last 2000 lines / 50KB (full output saved to a temp file when truncated). " +
	"Output streams live while the command runs. If it does not finish within the foreground wait window " +
	"(default 120s), it is automatically moved to a background tmux window and keeps running. Completion is " +
	"delivered automatically. Once backgrounded, do NOT wait for it or check merely to detect completion: never " +
	"call bash with sleep/polling loops or repeatedly call bg list/logs. Set timeout to enforce a hard kill at the " +
	"deadline instead (exit code 124, no background handoff). Set background:true to detach immediately.";

function reply(text: string, details: unknown = null, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

type StatusCtx = { hasUI: boolean; ui: { setStatus: (k: string, v?: string) => void } };

// 直接把运行中数写到 footer 状态栏（供面板实时刷新复用，避免重复统计）。
function setBgStatus(ctx: StatusCtx, running: number): void {
	if (!ctx.hasUI) return;
	ctx.ui.setStatus(STATUS_KEY, running > 0 ? `bg: ${running} running` : undefined);
}

// 统计运行中任务数：用 listJobsForSession（tmux 权威源，含 reload 后恢复的任务、按哨兵反映完成），
// 与 /bg 面板一致；旧的 runningCount(state.jobs) 在 reload 后会漏掉恢复的任务而偏少。
function updateStatus(state: RuntimeState, ctx: StatusCtx): void {
	setBgStatus(ctx, listJobsForSession(state).filter((j) => j.status === "running").length);
}

// 组装 0.82.0 的 Bash Tool Session Environment（PI_* session 元数据），交给 wrapper 脚本注入。
// 与内置 bash 一致：值在每条命令启动时从 ctx 现取，切换模型/思考级别后下一条命令即生效；
// ephemeral session 无 session file、未选定模型时留空（wrapper 会 unset，不透传 stale 继承值）。
function buildSessionEnv(ctx: ExtensionContext): SessionEnv {
	return {
		PI_SESSION_ID: ctx.sessionManager.getSessionId(),
		PI_SESSION_FILE: ctx.sessionManager.getSessionFile(),
		PI_PROVIDER: ctx.model?.provider,
		PI_MODEL: ctx.model?.id,
		PI_REASONING_LEVEL: ctx.thinkingLevel,
	};
}

export default function (pi: ExtensionAPI): void {
	const state = createState(loadOptions());

	// 完成 / 用户 kill 通知的自定义渲染：大输出任务折叠显示（头部 + 尾部），避免刷屏消息历史；
	// options.expanded 时展开全文（与工具结果一致的交互）。
	pi.registerMessageRenderer(COMPLETION_CUSTOM_TYPE, (message, options, theme) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		// 注入时加的「系统通知框」只给模型看，UI 里剔掉；再去掉尾部空行避免多余空行。
		const text = stripBgNotifyFrame(raw).replace(/\s+$/, "");
		const label = theme.fg("accent", "⏻ background bash");
		const lines = text.split("\n");
		const foldable = lines.length > COMPLETION_FOLD_HEAD + COMPLETION_FOLD_TAIL + 2;
		let body: string;
		if (options.expanded || !foldable) {
			body = lines.map((l) => theme.fg("toolOutput", l)).join("\n");
		} else {
			const head = lines.slice(0, COMPLETION_FOLD_HEAD).map((l) => theme.fg("toolOutput", l));
			const tail = lines.slice(-COMPLETION_FOLD_TAIL).map((l) => theme.fg("toolOutput", l));
			const omitted = lines.length - COMPLETION_FOLD_HEAD - COMPLETION_FOLD_TAIL;
			body = [...head, theme.fg("muted", `  … +${omitted} 行（展开查看全部）`), ...tail].join("\n");
		}
		return new Text(`${label}\n${body}`, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		resetRunDir(state, ctx.sessionManager.getSessionId());
		startWatcher(state, pi, () => updateStatus(state, ctx));
		updateStatus(state, ctx);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		// 不杀 tmux 任务，让后台命令在 pi 退出后继续跑；reason 决定磁盘产物如何回收（见 cleanup）。
		cleanup(state, event.reason);
	});

	// —— 覆盖内置 bash —— //
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: BASH_DESCRIPTION,
		promptGuidelines: [
			"Use bash for shell commands; a long command auto-moves to the background after ~120s and notifies on completion — never wait or poll for it.",
			"Set bash timeout only when you want a hard kill at the deadline (exit code 124), not a background handoff.",
			"Set bash background:true to detach immediately (dev servers, watchers, long builds).",
			"Once bash reports a background job, NEVER call bash with sleep or polling loops, and NEVER call bg list/logs merely to check whether it has finished. Continue only with independent useful work; otherwise end your turn immediately. Its completion notification will automatically trigger a new turn when the session is idle.",
			"Use bg list/logs only for deliberate inspection, never as a waiting strategy; use bg kill to stop a background job.",
		],
		parameters: BashParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!tmuxAvailable(state.options)) {
				return reply("tmux is unavailable: install tmux and ensure it is on PATH.", null, true);
			}
			try {
				if (params.background) {
					const r = startBackgroundCommand(state, params.command, undefined, ctx.cwd, "background", buildSessionEnv(ctx));
					updateStatus(state, ctx);
					return {
						content: [
							{
								type: "text" as const,
								text: [
									`Started background job ${r.jobId} in tmux window ${r.windowId}.`,
									"The command is already detached. Do not wait for it: NEVER call bash with sleep or polling loops, and NEVER call bg list/logs merely to check whether it has finished.",
									"Continue only with independent useful work; otherwise end your turn now. Completion is delivered automatically and will trigger a new turn when the session is idle.",
									`For deliberate manual inspection only (not polling): bg action=logs window=${r.windowId} · Stop: bg action=kill window=${r.windowId}`,
									`Attach: ${r.attach}`,
								].join("\n"),
							},
						],
						details: { jobId: r.jobId, windowId: r.windowId, outputFile: r.outputFile, backgrounded: true },
					};
				}

				const result = await runForegroundBash(state, {
					command: params.command,
					cwd: ctx.cwd,
					timeoutSec: params.timeout,
					signal,
					onUpdate,
					sessionEnv: buildSessionEnv(ctx),
				});
				updateStatus(state, ctx);
				return result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return reply(`Failed to execute command: ${msg}`, null, true);
			}
		},

		renderCall(args, theme, context) {
			// 执行一开始就打点，供 renderResult 的实时计时器读取（对齐内置 bash：executionStarted 时记 startedAt）。
			const st = context?.state as TimerState | undefined;
			if (st && context?.executionStarted && st.startedAt === undefined) st.startedAt = Date.now();
			const command = args?.command ?? "";
			// 防御带：命令回显是模型作者文本，没过 normalizeForegroundOutput。万一带了裸 \r / 光标移动
			// 序列，会毁掉 pi-tui「1 字符串 = 1 物理行」契约；逐行 collapse（保 SGR）后应仍是单行。
			const lines = command.split("\n").map((l) => collapseCarriageReturns(l));
			const maxLines = context?.expanded ? Infinity : 3;
			const shown = lines.slice(0, maxLines);
			let text = theme.fg("toolTitle", theme.bold("$ "));
			text += shown.map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");
			if (lines.length > maxLines) text += theme.fg("muted", `\n  … +${lines.length - maxLines} lines`);
			const configuredLimit = formatConfiguredLimit(args, state.options.foregroundTimeoutMs);
			if (configuredLimit) text += theme.fg("muted", ` (${configuredLimit})`);
			if (args?.background) text += theme.fg("accent", " &");
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const st = context?.state as TimerState | undefined;
			// 运行中（流式）：预览在上、Running · X.Xs 实时计时行在下——与完成后的 ✓ done 状态行同一个位置。
			if (options?.isPartial) {
				// 起一个每秒重绘的活计时器，让 Running · X.Xs 跟着涨（对齐内置 bash 的 setInterval → invalidate）。
				if (st && st.startedAt !== undefined && !st.interval && context?.invalidate) {
					st.interval = setInterval(() => context.invalidate(), 1000);
				}
				const now = Date.now();
				const elapsed =
					st?.startedAt !== undefined ? ` · ${Math.floor((now - st.startedAt) / 1000)}s` : "";
				const limit = formatRunningLimit(
					context?.args as BashRenderArgs | undefined,
					state.options.foregroundTimeoutMs,
					st?.startedAt,
					now,
				);
				const preview = output.trim();
				const previewBody = preview
					? preview.split("\n").slice(-5).map((l) => theme.fg("dim", l)).join("\n")
					: "";
				const runningLine = theme.fg("muted", `Running${elapsed}${limit}`);
				const wrapper = new Container();
				if (previewBody) wrapper.addChild(new Text(previewBody, 0, 0));
				wrapper.addChild(new Text(previewBody ? `\n${runningLine}` : runningLine, 0, 0));
				return wrapper;
			}
			// 已结束（含 error / 转后台）：停掉活计时器；最终总耗时仍由下方状态行用 details.durationMs 显示。
			if (st?.interval) {
				clearInterval(st.interval);
				st.interval = undefined;
			}

			// 输出主体（15 行折叠 / expanded 全展开）。
			const trimmed = output.trim();
			let body: string;
			if (!trimmed) {
				body = theme.fg("muted", "(no output)");
			} else {
				const lines = trimmed.split("\n");
				const max = options?.expanded ? Infinity : 15;
				const shown = lines.slice(0, max);
				body = shown.map((l) => theme.fg("toolOutput", l)).join("\n");
				if (lines.length > max) body += theme.fg("muted", `\n… +${lines.length - max} lines`);
			}

			// 末尾彩色状态行（合并自原 bash-status-line 扩展）：
			// ✓ done / ✗ exit N / ✗ aborted / ✗ timeout / ⧉ background，附耗时。
			const details = (result.details ?? {}) as {
				exitCode?: number;
				durationMs?: number;
				backgrounded?: boolean;
			};
			let status: string;
			if (details.backgrounded) {
				status = theme.fg("accent", "⧉ running in background");
			} else if (!context?.isError) {
				status = theme.fg("success", "✓ done");
			} else if (/Command aborted/.test(output)) {
				status = theme.fg("error", "✗ aborted");
			} else if (/timed out after/.test(output)) {
				status = theme.fg("error", "✗ timeout");
			} else {
				const code =
					typeof details.exitCode === "number" ? details.exitCode : Number(EXIT_CODE_PATTERN.exec(output)?.[1]);
				status = theme.fg("error", Number.isFinite(code) ? `✗ exit ${code}` : "✗ failed");
			}
			if (!details.backgrounded && typeof details.durationMs === "number") {
				status += theme.fg("muted", ` · ${(details.durationMs / 1000).toFixed(1)}s`);
			}

			const wrapper = new Container();
			wrapper.addChild(new Text(body, 0, 0));
			wrapper.addChild(new Text(`\n${status}`, 0, 0));
			return wrapper;
		},
	});

	// —— 后台任务管理（合并原 bg_list / bg_logs / bg_kill）—— //
	pi.registerTool({
		name: "bg",
		label: "Background jobs",
		description:
			"Manage background bash jobs (those auto-moved to background after the foreground wait, or started with " +
			"bash background:true). action=list shows running jobs; action=logs deliberately inspects the TAIL (most " +
			"recent lines) of one job's output (snapshot, never blocks) — never use list/logs repeatedly to wait for " +
			"completion; read the full-log path it prints for the complete log. action=kill stops a job by window id.",
		promptSnippet: "Manage background bash jobs: deliberately inspect status/logs, or kill by window id; never poll",
		promptGuidelines: [
			"Use bg action=list or action=logs only for deliberate inspection, never repeatedly to wait for completion; use bg action=kill window=@id to stop one.",
		],
		parameters: BgParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!tmuxAvailable(state.options)) return reply("tmux is unavailable.", null, true);

			if (params.action === "list") {
				reconcileCompletedJobs(state, pi);
				updateStatus(state, ctx);
				const allJobs = listJobsForSession(state);
				if (allJobs.length === 0) return reply("No background jobs recorded in this session.");
				const activeJobs = allJobs.filter((job) => job.status === "running" || job.status === "missing");
				const finishedJobs = allJobs
					.filter((job) => job.status !== "running" && job.status !== "missing")
					.sort((a, b) => (a.finishedAt ?? a.startedAt ?? 0) - (b.finishedAt ?? b.startedAt ?? 0));
				const selectedJobs =
					activeJobs.length >= MAX_BG_LIST_JOBS
						? activeJobs.slice(-MAX_BG_LIST_JOBS)
						: [...activeJobs, ...finishedJobs.slice(-(MAX_BG_LIST_JOBS - activeJobs.length))].sort(
								(a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0),
							);
				const omittedJobs = Math.max(0, allJobs.length - selectedJobs.length);
				const jobs = selectedJobs.map((job) => ({
					...job,
					// 先单行化：多行 heredoc 命令会把「一行一个 job」的列表格式撞成多行，模型难以解析。
					command: truncateLine(toSingleLine(job.command), MAX_BG_COMMAND_CHARS).text,
				}));
				const lines = jobs.map((job) => {
					const status = fmtJobStatus(job);
					const duration = fmtDuration(job.startedAt, job.finishedAt);
					return `${job.windowId}  [${status} · ${duration}]  ${job.name}  $ ${job.command}`.trimEnd();
				});
				if (omittedJobs > 0) lines.unshift(`[${omittedJobs} older background jobs omitted]`);
				const snapshot = truncateTail(lines.join("\n"), {
					maxLines: state.options.maxLines,
					maxBytes: state.options.maxBytes,
				});
				const footer = snapshot.truncated ? "\n\n[background job list truncated]" : "";
				return reply(`${snapshot.content}${footer}`, {
					jobs,
					totalJobs: allJobs.length,
					truncated: snapshot.truncated || omittedJobs > 0,
				});
			}

			if (!params.window) {
				return reply(`action=${params.action} requires a window id (e.g. window=@123). Use action=list first.`, null, true);
			}

			if (params.action === "logs") {
				const lines = params.lines && params.lines > 0 ? params.lines : state.options.maxLines;
				const job = [...state.jobs.values()].find((j) => j.windowId === params.window);
				const outputFile =
					job?.outputFile ?? listWindowsForSession(state).find((w) => w.id === params.window)?.outputFile;
				const { text, truncated, fullPath } = readJobLogs(state, params.window, outputFile, lines);
				const footer = truncated && fullPath ? `\n\n[output truncated; full log: ${fullPath}]` : "";
				// 模型侧日志剥掉 ANSI（CR 覆盖已在 readJobLogs 里做过）。
				return reply(`${stripAnsi(text)}${footer}`, { window: params.window, truncated, fullPath });
			}

			// action === "kill"。先后各对一次哨兵，避免「命令已完成、40ms watcher 尚未处理」时误标 killed。
			reconcileCompletedJobs(state, pi);
			const ok = killWindow(state.options, params.window);
			reconcileCompletedJobs(state, pi);
			const job = [...state.jobs.values()].find((candidate) => candidate.windowId === params.window);
			if (job?.status === "completed") {
				updateStatus(state, ctx);
				const text = ok
					? `Background job in window ${params.window} had already completed; closed its retained tmux window.`
					: `Background job in window ${params.window} had already completed (exit ${job.exitCode ?? "?"}).`;
				return reply(text, { window: params.window, status: job.status, exitCode: job.exitCode });
			}
			if (ok) markJobKilled(state, params.window);
			updateStatus(state, ctx);
			return ok
				? reply(`Killed background job in window ${params.window}.`, { window: params.window })
				: reply(`No such tmux window: ${params.window} (already finished or closed).`, null, true);
		},

		// —— 调用行：明确显示这次 bg 调用的 action 与目标 ——
		// 没有 renderCall 时 TUI 只显示工具名，看不出是 list / logs / kill，只能从输出反推。
		// 风格对齐 bash 的 renderCall（toolTitle 加粗前缀 + 参数）；kill 是破坏性动作，用 error 色警示。
		renderCall(args, theme) {
			const action = args?.action ?? "?";
			let text = theme.fg("toolTitle", theme.bold("bg "));
			text += action === "kill" ? theme.fg("error", theme.bold(action)) : theme.fg("accent", action);
			if (args?.window) text += ` ${args.window}`;
			if (action === "logs" && args?.lines) text += theme.fg("muted", ` · last ${args.lines} lines`);
			return new Text(text, 0, 0);
		},

		// —— 结果：按 action 上色，15 行折叠（与 bash 结果一致，expanded 全展开）——
		// 进入这里的文本已在 execute 边界归一化（list 逐行 toSingleLine；logs 经 readJobLogs 的 CR 折叠
		// + stripAnsi），满足「1 字符串 = 1 物理行」契约，无需再过 collapseCarriageReturns。
		renderResult(result, options, theme, context) {
			const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			const trimmed = output.trim();
			if (!trimmed) return new Text(theme.fg("muted", "(no output)"), 0, 0);

			const action = context?.args?.action;
			const isError = context?.isError === true;

			// list 的任务行：`@241  [completed exit 0 · 3s]  name  $ cmd` —— 只给状态括号上色，
			// 其余保持 toolOutput，一眼区分 running / 成功 / 失败，又不至于整屏大块颜色。
			const colorListLine = (line: string): string => {
				const m = /^(\S+\s+)\[([^\]]+)\](.*)$/.exec(line);
				if (!m) return theme.fg("muted", line); // 元信息行（omitted / truncated / 无任务）
				const [, head, status, rest] = m;
				const statusColor = /^running\b/.test(status)
					? ("accent" as const)
					: /^completed exit 0\b/.test(status)
						? ("success" as const)
						: /^window missing\b/.test(status)
							? ("warning" as const)
							: ("error" as const); // killed / completed exit 非零
				return theme.fg("toolOutput", head) + theme.fg(statusColor, `[${status}]`) + theme.fg("toolOutput", rest);
			};

			const colorLine = (line: string): string => {
				if (isError) return theme.fg("error", line);
				if (action === "list") return colorListLine(line);
				if (action === "kill") return theme.fg("success", line);
				// logs：正文 toolOutput，截断脚注 muted。
				return /^\[output truncated;/.test(line) ? theme.fg("muted", line) : theme.fg("toolOutput", line);
			};

			const lines = trimmed.split("\n");
			const max = options?.expanded ? Infinity : 15;
			let body = lines.slice(0, max).map(colorLine).join("\n");
			if (lines.length > max) body += theme.fg("muted", `\n… +${lines.length - max} lines`);
			return new Text(body, 0, 0);
		},
	});

	// —— /bg 面向用户的交互面板（overlay：列表 → Enter 看输出 / x kill）—— //
	// 组件实现见 bg-panel.ts；与模型用的 `bg` 工具共用同一套 runtime helper。
	pi.registerCommand("bg", {
		description: "查看/管理后台 bash 任务（列表、看输出、kill）",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;
			if (!tmuxAvailable(state.options)) {
				ctx.ui.notify("tmux 不可用：请安装 tmux 并确保在 PATH 中。", "error");
				return;
			}
			await openBgPanel(pi, state, ctx, (n) => setBgStatus(ctx, n));
			updateStatus(state, ctx);
		},
	});
}

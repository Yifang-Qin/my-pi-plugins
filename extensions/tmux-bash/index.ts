// tmux-bash — 用 tmux 后台化覆盖 pi 内置 bash：
//
//   - 覆盖内置 bash（同名 registerTool 完全替换）：命令始终在 detached tmux 窗口里跑，
//     execute 前台同步等待并「流式转发」输出；未显式 timeout 时等 PI_TMUX_BASH_FOREGROUND_TIMEOUT
//     秒（默认 120s）超时「自动转后台」（不杀命令），完成后经 followUp 自动通知模型；
//     显式 timeout 时保留内置「硬超时杀死（退出码 124）」语义，不转后台。
//   - background:true 立即后台，不等待（取代旧的 bg_start，用于 dev server / watcher 等）。
//   - 新增 bg 管理工具（action=list/logs/kill）管理转后台/显式后台的任务。
//
// 覆盖时对齐内置 bash 的所有形状（结果 content / details / isError / 错误文案 / 截断），
// 逐条清单见同目录 BUILTIN-BASH-REFERENCE.md。进程交给 tmux server 持有，pi 重启/reload/
// 退出都不影响后台任务。

import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPLETION_CUSTOM_TYPE, loadOptions, stripBgNotifyFrame } from "./config.js";
import {
	cleanup,
	createState,
	listWindowsForSession,
	readJobLogs,
	resetRunDir,
	runForegroundBash,
	runningCount,
	startBackgroundCommand,
	startWatcher,
	type RuntimeState,
} from "./runtime.js";
import { killWindow, tmuxAvailable } from "./tmux.js";

const STATUS_KEY = "tmux-bash";
// 从内置 bash 的非零退出文案里回捞退出码（合并自原 bash-status-line 扩展）。
const EXIT_CODE_PATTERN = /Command exited with code (\d+)/;

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
				"Start immediately in the background and return at once (do not wait). Use for dev servers, watchers, or tasks you explicitly want detached. A completion message is delivered automatically when it finishes.",
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
	"(default 120s), it is automatically moved to a background tmux window and keeps running — a completion " +
	"message is delivered automatically when it finishes, so do NOT poll for it. Set timeout to enforce a hard " +
	"kill at the deadline instead (exit code 124, no background handoff). Set background:true to detach immediately.";

function reply(text: string, details: unknown = null, isError = false) {
	return { content: [{ type: "text" as const, text }], details, ...(isError ? { isError: true } : {}) };
}

function fmtAge(startedAtSec: number | undefined): string {
	if (!startedAtSec) return "?";
	const s = Math.max(0, Math.floor(Date.now() / 1000 - startedAtSec));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

function updateStatus(state: RuntimeState, ctx: { hasUI: boolean; ui: { setStatus: (k: string, v?: string) => void } }): void {
	if (!ctx.hasUI) return;
	const n = runningCount(state);
	ctx.ui.setStatus(STATUS_KEY, n > 0 ? `bg: ${n} running` : undefined);
}

export default function (pi: ExtensionAPI): void {
	const state = createState(loadOptions());

	// 完成通知的自定义渲染。
	pi.registerMessageRenderer(COMPLETION_CUSTOM_TYPE, (message, _options, theme) => {
		const raw =
			typeof message.content === "string"
				? message.content
				: message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		// 注入时加的「系统通知框」只给模型看，UI 里剔掉。
		const text = stripBgNotifyFrame(raw);
		return new Text(`${theme.fg("accent", "⏻ background bash")}\n${theme.fg("toolOutput", text)}`, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		resetRunDir(state, ctx.sessionManager.getSessionId());
		startWatcher(state, pi);
		updateStatus(state, ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
		cleanup(state); // 不杀 tmux 任务，让后台命令在 pi 退出后继续跑。
	});

	// —— 覆盖内置 bash —— //
	pi.registerTool({
		name: "bash",
		label: "bash",
		description: BASH_DESCRIPTION,
		promptGuidelines: [
			"Use bash for shell commands; a long command auto-moves to the background after ~120s and notifies on completion — do not poll for it.",
			"Set bash timeout only when you want a hard kill at the deadline (exit code 124), not a background handoff.",
			"Set bash background:true to detach immediately (dev servers, watchers, long builds).",
			"Use bg (action=list/logs/kill) to inspect or stop background jobs started by bash.",
		],
		parameters: BashParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!tmuxAvailable(state.options)) {
				return reply("tmux is unavailable: install tmux and ensure it is on PATH.", null, true);
			}
			try {
				if (params.background) {
					const r = startBackgroundCommand(state, params.command, undefined, ctx.cwd, "background");
					updateStatus(state, ctx);
					return {
						content: [
							{
								type: "text" as const,
								text: [
									`Started background job ${r.jobId} in tmux window ${r.windowId}.`,
									`A completion message will arrive when it finishes; continue other work.`,
									`Peek: bg action=logs window=${r.windowId} · Stop: bg action=kill window=${r.windowId}`,
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
				});
				updateStatus(state, ctx);
				return result;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return reply(`Failed to execute command: ${msg}`, null, true);
			}
		},

		renderCall(args, theme, context) {
			const command = args?.command ?? "";
			const lines = command.split("\n");
			const maxLines = context?.expanded ? Infinity : 3;
			const shown = lines.slice(0, maxLines);
			let text = theme.fg("toolTitle", theme.bold("$ "));
			text += shown.map((l, i) => (i === 0 ? l : `  ${l}`)).join("\n");
			if (lines.length > maxLines) text += theme.fg("muted", `\n  … +${lines.length - maxLines} lines`);
			if (args?.background) text += theme.fg("accent", " &");
			return new Text(text, 0, 0);
		},

		renderResult(result, options, theme, context) {
			const output = result.content?.[0]?.type === "text" ? result.content[0].text : "";
			// 运行中（流式）：只显示 Running + 尾部预览，不加状态行。
			if (options?.isPartial) {
				let t = theme.fg("muted", "Running");
				const preview = output.trim();
				if (preview) {
					t += "\n" + preview.split("\n").slice(-5).map((l) => theme.fg("dim", l)).join("\n");
				}
				return new Text(t, 0, 0);
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
			"bash background:true). action=list shows running jobs; action=logs peeks the TAIL (most recent lines) of " +
			"one job's output (snapshot, never blocks) — read the full-log path it prints for the complete log; " +
			"action=kill stops a job by window id.",
		promptSnippet: "Manage background bash jobs: list running, peek logs, or kill by window id",
		promptGuidelines: [
			"Use bg action=list to see background jobs, action=logs window=@id to peek output, action=kill window=@id to stop one.",
		],
		parameters: BgParams,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			if (!tmuxAvailable(state.options)) return reply("tmux is unavailable.", null, true);

			if (params.action === "list") {
				const windows = listWindowsForSession(state);
				if (windows.length === 0) return reply("No background jobs running in this session.");
				const lines = windows.map(
					(w) => `${w.id}  [${fmtAge(w.startedAt)}]  ${w.name}  $ ${w.command ?? ""}`.trimEnd(),
				);
				return reply(lines.join("\n"), { windows });
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
				return reply(`${text}${footer}`, { window: params.window, truncated, fullPath });
			}

			// action === "kill"
			const ok = killWindow(state.options, params.window);
			const job = [...state.jobs.values()].find((j) => j.windowId === params.window);
			if (job) job.done = true;
			updateStatus(state, ctx);
			return ok
				? reply(`Killed background job in window ${params.window}.`, { window: params.window })
				: reply(`No such tmux window: ${params.window} (already finished or closed).`, null, true);
		},
	});
}

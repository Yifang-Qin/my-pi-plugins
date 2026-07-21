// tmux-bash 运行时：wrapper 脚本生成、后台窗口启动、runDir 管理、
// 退出码哨兵文件监听（fs.watch）与日志读取。
//
// 核心思路（借鉴 pi-tmux-bash，但做了简化与改进）：
//   - 进程不由 Node 持有，交给 tmux server；pi 重启/reload/退出都不影响后台任务。
//   - 每个任务写一个 wrapper .sh：tee 输出到 .out 文件，用 ${PIPESTATUS[0]} 取真实
//     退出码，写入「退出码哨兵文件」，最后 exec $SHELL -l 让窗口在命令结束后仍可 attach。
//   - 「是否完成」= 哨兵文件是否出现；用 fs.watch(runDir) 监听，完成后通过
//     pi.sendMessage(followUp + triggerTurn) 唤醒模型。
//   - 工作目录用 ctx.cwd（不强制 git 仓库，这点比 pi-tmux-bash 宽松）。

import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { join } from "node:path";
import { truncateTail, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { COMPLETION_CUSTOM_TYPE, WINDOW_OPTIONS, frameBgNotify, type TmuxBashOptions } from "./config.js";
import {
	attachHint,
	ensureSession,
	killWindow,
	listTaskWindows,
	newWindow,
	setWindowOptions,
	capturePane,
} from "./tmux.js";

interface Job {
	id: string; // 我们生成的短 id（hex）
	windowId: string; // tmux #{window_id}
	command: string;
	outputFile: string; // runDir/<id>.<windowId>.out
	startedAt: number; // Date.now()
	done: boolean;
}

export interface RuntimeState {
	options: TmuxBashOptions;
	runDir: string | null;
	scriptDir: string | null;
	piSessionId: string;
	watcher: FSWatcher | null;
	jobs: Map<string, Job>;
	pendingTimers: Set<NodeJS.Timeout>;
	shuttingDown: boolean;
}

export function createState(options: TmuxBashOptions): RuntimeState {
	return {
		options,
		runDir: null,
		scriptDir: null,
		piSessionId: "",
		watcher: null,
		jobs: new Map(),
		pendingTimers: new Set(),
		shuttingDown: false,
	};
}

// 每个 pi 会话一个独立 runDir，避免不同会话的哨兵文件互相干扰。
export function resetRunDir(state: RuntimeState, piSessionId: string): void {
	state.piSessionId = piSessionId;
	const encoded = Buffer.from(piSessionId).toString("base64url").slice(0, 16);
	const id = `${encoded}-${process.pid}-${randomBytes(4).toString("hex")}`;
	const runDir = join(state.options.outputDir, id);
	const scriptDir = join(runDir, "s");
	mkdirSync(scriptDir, { recursive: true, mode: 0o700 });
	chmodSync(runDir, 0o700);
	state.runDir = runDir;
	state.scriptDir = scriptDir;
	state.shuttingDown = false;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// 把父进程环境导出到 wrapper 脚本里（跳过 denylist 和非法变量名）。
function formatEnvExports(state: RuntimeState): string {
	const denied = new Set(state.options.envDenylist);
	return Object.entries(process.env)
		.filter(([name, value]) => value !== undefined && IDENTIFIER.test(name) && !denied.has(name))
		.map(([name, value]) => `export ${name}=${shellQuote(value ?? "")}`)
		.join("\n");
}

// 生成一次性 wrapper 脚本的字符串（纯函数，便于单测 / bash -n 校验）。
// 哨兵文件命名：<id>.<window_id>（id 在前，便于 watcher 按 id 前缀匹配）；
// 对应输出文件 <id>.<window_id>.out。脚本内部用 display-message 解析自己的
// window_id，与 Node 从 new-window -P 拿到的应当一致。
export function buildWrapperScript(params: {
	runDir: string;
	tmuxBinary: string;
	id: string;
	command: string;
	displayCommand: string;
	envExports: string;
}): string {
	return `#!/usr/bin/env bash
__run_dir=${shellQuote(params.runDir)}
__id=${shellQuote(params.id)}
__tmux=${shellQuote(params.tmuxBinary)}
__window_id=$("$__tmux" display-message -p -t "\${TMUX_PANE:-}" '#{window_id}' 2>/dev/null || printf '@0')
__exit_file="$__run_dir/$__id.$__window_id"
__out_file="$__exit_file.out"
: > "$__out_file"
printf '$ %s\\n' ${shellQuote(params.displayCommand)}
${params.envExports}
(
${params.command}
) 2>&1 | tee -a "$__out_file"
__rc=\${PIPESTATUS[0]}
# 先写 .tmp 再 mv，保证 fs.watch 看到的是完整的哨兵文件（原子出现）。
printf '%s\\n' "$__rc" > "$__exit_file.tmp"
mv -f "$__exit_file.tmp" "$__exit_file"
# 命令结束后保持窗口存活、可 attach（autoClose 关闭时才真正有意义）。
exec "\${SHELL:-/bin/bash}" -l 2>/dev/null || exec bash -l
`;
}

function writeScript(state: RuntimeState, id: string, command: string, displayCommand: string): string {
	const scriptPath = join(state.scriptDir!, `${id}.sh`);
	const script = buildWrapperScript({
		runDir: state.runDir!,
		tmuxBinary: state.options.tmuxBinary,
		id,
		command,
		displayCommand,
		envExports: formatEnvExports(state),
	});
	writeFileSync(scriptPath, script, { mode: 0o755 });
	return scriptPath;
}

function windowNameFor(command: string, name: string | undefined): string {
	if (name) return name;
	const first = command.trim().split(/[|;&\s]/)[0] ?? "shell";
	return first.split("/").pop() || "shell";
}

export interface StartResult {
	jobId: string;
	windowId: string;
	outputFile: string;
	attach: string;
}

// 启动一个后台命令：建脚本 → 建窗口 → 打标签 → 登记 job。立即返回，不等待完成。
export function startBackgroundCommand(
	state: RuntimeState,
	command: string,
	name: string | undefined,
	cwd: string,
	_origin?: string, // “background”（显式后台）/ “foreground-timeout”（自动转后台），仅供调用方语义标记。
): StartResult {
	const { options } = state;
	ensureSession(options, cwd);

	const id = randomBytes(4).toString("hex");
	const displayCommand = command.replace(/\s+/g, " ").trim();
	const scriptPath = writeScript(state, id, command, displayCommand);
	const windowId = newWindow(options, windowNameFor(command, name), cwd, scriptPath);
	const outputFile = join(state.runDir!, `${id}.${windowId}.out`);

	setWindowOptions(options, windowId, {
		[WINDOW_OPTIONS.piSession]: state.piSessionId,
		[WINDOW_OPTIONS.startedAt]: String(Math.floor(Date.now() / 1000)),
		[WINDOW_OPTIONS.jobId]: id,
		[WINDOW_OPTIONS.outputFile]: outputFile,
		[WINDOW_OPTIONS.command]: displayCommand,
	});

	state.jobs.set(id, { id, windowId, command: displayCommand, outputFile, startedAt: Date.now(), done: false });
	return { jobId: id, windowId, outputFile, attach: attachHint(options, windowId) };
}

// —— 前台同步执行（覆盖内置 bash 的核心路径）—— //

type ToolTextResult = {
	content: { type: "text"; text: string }[];
	details: unknown;
	isError?: boolean;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function readOutputFile(outputFile: string): string {
	try {
		return existsSync(outputFile) ? readFileSync(outputFile, "utf-8") : "";
	} catch {
		return "";
	}
}

// 组装最终结果，尽量对齐内置 bash 的 content/details/isError/错误文案。
// statusOverride 非空（超时/中断）时作为错误状态行拼到输出末尾。
function buildFinalResult(
	state: RuntimeState,
	outputFile: string,
	exitCode: number,
	durationMs: number,
	statusOverride?: string,
): ToolTextResult {
	const t = truncateTail(readOutputFile(outputFile), {
		maxLines: state.options.maxLines,
		maxBytes: state.options.maxBytes,
	});
	const body = t.content;
	const footer = t.truncated ? `\n\n[output truncated; full log: ${outputFile}]` : "";
	const details = { exitCode, outputFile, truncated: t.truncated, durationMs };

	if (statusOverride) {
		const text = `${body ? `${body}${footer}\n\n` : ""}${statusOverride}`;
		return { content: [{ type: "text", text }], details, isError: true };
	}
	if (exitCode !== 0) {
		const text = `${body ? `${body}${footer}\n\n` : ""}Command exited with code ${exitCode}`;
		return { content: [{ type: "text", text }], details, isError: true };
	}
	return { content: [{ type: "text", text: (body || "(no output)") + footer }], details };
}

function readExitCode(exitFile: string): number {
	try {
		return parseInt(readFileSync(exitFile, "utf-8").trim(), 10);
	} catch {
		return NaN;
	}
}

// 前台同步执行：命令始终在 detached tmux 窗口里跑，这里流式转发 .out 输出并等待完成。
//   - 完成 → 返回最终结果（对齐内置 bash 形状）。
//   - 未显式 timeout 且超过前台等待窗口 → 自动转后台（不杀），登记 job 交给 watcher 通知。
//   - 显式 timeout 到点 → 硬杀（退出码 124，不转后台）。
//   - signal 中断 → 杀窗口并返回中断。
// 只对 tmux 建窗口失败等「基础设施异常」抛错（交给 index.ts 的 catch），命令自身失败一律以 isError 结果返回。
export async function runForegroundBash(
	state: RuntimeState,
	params: {
		command: string;
		cwd: string;
		timeoutSec?: number;
		signal?: AbortSignal;
		onUpdate?: (partial: ToolTextResult) => void;
	},
): Promise<ToolTextResult> {
	const { options } = state;
	ensureSession(options, params.cwd);

	const id = randomBytes(4).toString("hex");
	const displayCommand = params.command.replace(/\s+/g, " ").trim();
	const scriptPath = writeScript(state, id, params.command, displayCommand);
	const windowId = newWindow(options, windowNameFor(params.command, undefined), params.cwd, scriptPath);
	const outputFile = join(state.runDir!, `${id}.${windowId}.out`);
	const exitFile = join(state.runDir!, `${id}.${windowId}`);

	setWindowOptions(options, windowId, {
		[WINDOW_OPTIONS.piSession]: state.piSessionId,
		[WINDOW_OPTIONS.startedAt]: String(Math.floor(Date.now() / 1000)),
		[WINDOW_OPTIONS.jobId]: id,
		[WINDOW_OPTIONS.outputFile]: outputFile,
		[WINDOW_OPTIONS.command]: displayCommand,
	});

	const startedAt = Date.now();
	const hardTimeoutMs =
		params.timeoutSec != null && Number.isFinite(params.timeoutSec) && params.timeoutSec > 0
			? params.timeoutSec * 1000
			: null;
	const POLL_MS = 150;

	params.onUpdate?.({ content: [], details: undefined });
	let lastEmitted = "";

	// 命令已完成：清哨兵、按配置关窗口、返回最终结果。
	const finishInline = (exitCode: number): ToolTextResult => {
		try {
			unlinkSync(exitFile);
		} catch {
			/* ignore */
		}
		if (options.autoCloseOnComplete) killWindow(options, windowId);
		return buildFinalResult(state, outputFile, exitCode, Date.now() - startedAt);
	};

	while (true) {
		// 流式转发当前输出（内容有变化才发）。
		if (params.onUpdate) {
			const current = readOutputFile(outputFile);
			if (current !== lastEmitted) {
				lastEmitted = current;
				const t = truncateTail(current, { maxLines: options.maxLines, maxBytes: options.maxBytes });
				params.onUpdate({ content: [{ type: "text", text: t.content }], details: undefined });
			}
		}

		// 完成？
		if (existsSync(exitFile)) {
			const exitCode = readExitCode(exitFile);
			if (!Number.isNaN(exitCode)) return finishInline(exitCode);
		}

		// 用户中断：杀窗口，返回中断（对齐内置 bash 文案）。
		if (params.signal?.aborted) {
			killWindow(options, windowId);
			return buildFinalResult(state, outputFile, 130, Date.now() - startedAt, "Command aborted");
		}

		const elapsed = Date.now() - startedAt;

		// 显式 timeout：到点硬杀，退出码 124，不转后台。
		if (hardTimeoutMs != null && elapsed >= hardTimeoutMs) {
			killWindow(options, windowId);
			return buildFinalResult(state, outputFile, 124, elapsed, `Command timed out after ${params.timeoutSec} seconds`);
		}

		// 未显式 timeout 且超过前台等待窗口：自动转后台（不杀），登记 job 供 watcher 通知。
		if (hardTimeoutMs == null && elapsed >= options.foregroundTimeoutMs) {
			// 先登记再复查哨兵文件，消除「刚好在切换瞬间完成」导致漏发通知的竞态。
			state.jobs.set(id, { id, windowId, command: displayCommand, outputFile, startedAt, done: false });
			if (existsSync(exitFile)) {
				const exitCode = readExitCode(exitFile);
				if (!Number.isNaN(exitCode)) {
					const job = state.jobs.get(id);
					if (job) job.done = true;
					return finishInline(exitCode);
				}
			}
			const waitSec = Math.round(options.foregroundTimeoutMs / 1000);
			return {
				content: [
					{
						type: "text",
						text: [
							`Command still running after ${waitSec}s — moved to background as job ${id} (tmux window ${windowId}).`,
							`A completion message will arrive when it finishes; continue other work — do NOT poll for it.`,
							`Peek: bg action=logs window=${windowId} · Stop: bg action=kill window=${windowId}`,
							`Attach: ${attachHint(options, windowId)}`,
						].join("\n"),
					},
				],
				details: { jobId: id, windowId, outputFile, backgrounded: true },
			};
		}

		await sleep(POLL_MS);
	}
}

// 读日志：优先读 .out 文件（精确），拿不到再退回 capture-pane。按 tail 截断。
export function readJobLogs(
	state: RuntimeState,
	windowId: string,
	outputFile: string | undefined,
	lines: number,
): { text: string; truncated: boolean; fullPath?: string } {
	let raw: string | null = null;
	if (outputFile && existsSync(outputFile)) raw = readFileSync(outputFile, "utf-8");
	if (raw === null) raw = capturePane(state.options, windowId, lines);

	const t = truncateTail(raw, { maxLines: lines, maxBytes: state.options.maxBytes });
	return { text: t.content || "(no output)", truncated: t.truncated, fullPath: outputFile };
}

// 启动完成监听：watch runDir，哨兵文件出现即读退出码 + .out，发完成通知唤醒模型。
export function startWatcher(state: RuntimeState, pi: ExtensionAPI): void {
	if (state.watcher || !state.runDir) return;
	state.watcher = watch(state.runDir, (_event, filename) => {
		if (!filename) return;
		const name = filename.toString();
		if (name.endsWith(".out") || name.endsWith(".tmp") || name.endsWith(".sh")) return;
		const dot = name.indexOf(".");
		if (dot <= 0) return;
		const id = name.slice(0, dot);
		const job = state.jobs.get(id);
		if (!job || job.done) return;
		const exitPath = join(state.runDir!, name);
		if (!existsSync(exitPath)) return;
		// 稍等一拍确保 .out 写盘完成，再处理。
		const timer = setTimeout(() => {
			state.pendingTimers.delete(timer);
			handleCompletion(state, pi, id, exitPath);
		}, 40);
		state.pendingTimers.add(timer);
	});
}

function handleCompletion(state: RuntimeState, pi: ExtensionAPI, id: string, exitPath: string): void {
	const job = state.jobs.get(id);
	if (!job || job.done || state.shuttingDown) return;
	if (!existsSync(exitPath)) return;

	let exitCode = NaN;
	try {
		exitCode = parseInt(readFileSync(exitPath, "utf-8").trim(), 10);
	} catch {
		return;
	}
	job.done = true;

	const { text, truncated } = readJobLogs(state, job.windowId, job.outputFile, state.options.maxLines);
	const durSec = ((Date.now() - job.startedAt) / 1000).toFixed(1);
	const status = exitCode === 0 ? "exited 0" : `exited ${exitCode}`;
	const header = `Background job ${job.id} (${job.windowId}) ${status} after ${durSec}s\n$ ${job.command}`;
	const footer = truncated ? `\n\n[output truncated; full log: ${job.outputFile}]` : "";
	// 加上「系统通知框」：此消息会被 pi 降级成 role:"user"，不加框模型会误当成用户新指令。
	const content = frameBgNotify(`${header}\n\n${text}${footer}`);

	// 清理哨兵文件；按配置关闭窗口。
	try {
		unlinkSync(exitPath);
	} catch {
		/* ignore */
	}
	if (state.options.autoCloseOnComplete) killWindow(state.options, job.windowId);

	if (state.shuttingDown) return;
	pi.sendMessage(
		{
			customType: COMPLETION_CUSTOM_TYPE,
			content,
			display: true,
			details: {
				jobId: job.id,
				windowId: job.windowId,
				exitCode,
				command: job.command,
				outputFile: job.outputFile,
				durationMs: Date.now() - job.startedAt,
			},
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

// 当前 pi 会话仍在运行的任务数（供状态栏显示）。
export function runningCount(state: RuntimeState): number {
	return [...state.jobs.values()].filter((j) => !j.done).length;
}

export function listWindowsForSession(state: RuntimeState) {
	return listTaskWindows(state.options, state.piSessionId);
}

// 会话结束/reload 时清理：关掉 watcher 和定时器，清空 job 表。
// 注意：故意不杀 tmux 窗口/会话——后台任务应当在 pi 退出后继续存活。
export function cleanup(state: RuntimeState): void {
	state.shuttingDown = true;
	state.watcher?.close();
	state.watcher = null;
	for (const t of state.pendingTimers) clearTimeout(t);
	state.pendingTimers.clear();
	state.jobs.clear();
	// runDir 里的 .out 是任务输出，保留；脚本目录可清。
	if (state.scriptDir && existsSync(state.scriptDir)) {
		try {
			rmSync(state.scriptDir, { recursive: true, force: true });
		} catch {
			/* ignore */
		}
	}
}

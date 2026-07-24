// tmux-bash 运行时：wrapper 脚本生成、后台窗口启动、runDir 管理、
// 退出码哨兵文件监听（fs.watch）与日志读取。
//
// 核心思路（借鉴 pi-tmux-bash，但做了简化与改进）：
//   - 进程不由 Node 持有，交给 tmux server；pi 重启/reload/退出都不影响后台任务。
//   - 每个任务写一个 wrapper .sh：tee 输出到 .out 文件，用 ${PIPESTATUS[0]} 取真实
//     退出码，写入「退出码哨兵文件」，最后 exec $SHELL -l 让窗口在命令结束后仍可 attach。
//   - 「是否完成」= 哨兵文件是否出现；用 fs.watch(runDir) 监听，完成后通过
//     pi.sendMessage(steer + triggerTurn) 唤醒模型。
//   - 建窗口前先用 bash -n 对 wrapper 脚本做语法预检：解析不过的命令（典型如 macOS
//     系统 bash 3.2 对 $(…) 内 heredoc 撚号的误判）立即以 isError 返回，不会变成
//     「窗口秒死但前台空等 120s 后误转后台」的僵尸任务。
//   - 前台等待循环附带窗口存活探测（约每秒一次）：窗口未写哨兵文件就消失
//     （wrapper 崩溃 / 被外部 kill）时立即报错返回，而不是等满等待窗口假装转后台。
//   - 工作目录用 ctx.cwd（不强制 git 仓库，这点比 pi-tmux-bash 宽松）。

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	watch,
	writeFileSync,
	type FSWatcher,
} from "node:fs";
import { basename, join } from "node:path";
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
	windowExists,
	type TmuxWindow,
} from "./tmux.js";

type JobStatus = "running" | "completed" | "killed";
const MAX_RETAINED_FINISHED_JOBS = 100;

interface Job {
	id: string; // 我们生成的短 id（hex）
	windowId: string; // tmux #{window_id}
	name: string;
	command: string;
	outputFile: string; // runDir/<id>.<windowId>.out
	startedAt: number; // Date.now()
	status: JobStatus;
	exitCode?: number;
	finishedAt?: number; // Date.now()
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

// —— session 元数据注入（对齐 0.82.0 内置 bash 的 Bash Tool Session Environment）—— //
//
// 0.82.0 起 pi 内置 bash / createBashTool() 会在每条命令启动时注入这批 PI_* 变量，描述当前
// session/model 状态。我们用 registerTool 完全覆盖了内置 bash，走自己的 wrapper 脚本，不会自动
// 获得它们，需在此手动对齐。值在 execute 时从 ctx 现取（见 index.ts buildSessionEnv），因此切换
// 模型/思考级别后下一条命令即生效，与内置语义一致。
const SESSION_ENV_KEYS = [
	"PI_SESSION_ID",
	"PI_SESSION_FILE",
	"PI_PROVIDER",
	"PI_MODEL",
	"PI_REASONING_LEVEL",
] as const;
export type SessionEnv = Partial<Record<(typeof SESSION_ENV_KEYS)[number], string | undefined>>;

// 生成这批受管变量的 export/unset 行。追加在 formatEnvExports 之后 → 覆盖 process.env 里可能
// 残留的父 session stale 值（尤其 afang-subagent spawn 的子 pi 会继承父 env）。值缺失时（如
// ephemeral session 无 session file，或未选定模型）显式 unset，对齐内置「removes inherited
// values so nested Pi processes do not expose stale parent-session metadata」的语义。
export function formatSessionEnvExports(sessionEnv: SessionEnv | undefined): string {
	if (!sessionEnv) return "";
	return SESSION_ENV_KEYS.map((key) => {
		const value = sessionEnv[key];
		return value !== undefined && value !== "" ? `export ${key}=${shellQuote(value)}` : `unset ${key}`;
	}).join("\n");
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
# 收紧内部文件权限（0o600），且只在子 shell 里临时改 umask——不影响下面用户命令自己创建的文件。
( umask 077; : > "$__out_file" )
printf '$ %s\\n' ${shellQuote(params.displayCommand)}
${params.envExports}
(
${params.command}
) 2>&1 | tee -a "$__out_file"
__rc=\${PIPESTATUS[0]}
# 先写 .tmp 再 mv，保证 fs.watch 看到的是完整的哨兵文件（原子出现）；同样局部 umask 收紧权限，mv 会保留 0o600。
( umask 077; printf '%s\\n' "$__rc" > "$__exit_file.tmp" )
mv -f "$__exit_file.tmp" "$__exit_file"
# 命令结束后保持窗口存活、可 attach（autoClose 关闭时才真正有意义）。
exec "\${SHELL:-/bin/bash}" -l 2>/dev/null || exec bash -l
`;
}

function writeScript(
	state: RuntimeState,
	id: string,
	command: string,
	displayCommand: string,
	sessionEnv?: SessionEnv,
): string {
	const scriptPath = join(state.scriptDir!, `${id}.sh`);
	const script = buildWrapperScript({
		runDir: state.runDir!,
		tmuxBinary: state.options.tmuxBinary,
		id,
		command,
		displayCommand,
		// session 元数据放在 process.env 导出之后，覆盖任何 stale 继承值。
		envExports: [formatEnvExports(state), formatSessionEnvExports(sessionEnv)].filter(Boolean).join("\n"),
	});
	// 脚本里内联了导出的环境变量（可能含密钥），且只需 owner 执行/预检读取 → 0o700，不给 group/other。
	writeFileSync(scriptPath, script, { mode: 0o700 });
	return scriptPath;
}

function windowNameFor(command: string, name: string | undefined): string {
	if (name) return name;
	const first = command.trim().split(/[|;&\s]/)[0] ?? "shell";
	return first.split("/").pop() || "shell";
}

// —— bash -n 语法预检 —— //
//
// 背景：wrapper 脚本若有语法错误，bash 会在执行完前面的简单命令（含 `: > $__out_file`）后
// 才在解析复合命令时报错退出——错误打到 pane 的 stderr（不进 .out）、哨兵文件永不出现、
// 窗口秒关。典型诱因：macOS 系统 bash 3.2 的 $(…) 扫描器会把 heredoc 正文里的撚号（don't）
// 误判为未闭合单引号。故建窗口前先 bash -n 预检，把错误在启动前直接返给模型。

let cachedBashVersion: string | null | undefined;
function bashVersion(): string | null {
	if (cachedBashVersion === undefined) {
		try {
			cachedBashVersion =
				execFileSync("bash", ["--version"], {
					encoding: "utf-8",
					timeout: 10_000,
					stdio: ["ignore", "pipe", "ignore"],
				})
					.split("\n")[0]
					?.trim() || null;
		} catch {
			cachedBashVersion = null;
		}
	}
	return cachedBashVersion;
}

// 返回 null 表示通过；否则返回人类可读的语法错误信息（附本机 bash 版本，方便定位
// 「老 bash 解析器」一类问题）。权威校验对象是 wrapper 脚本（它才是真正要跑的东西）；
// 但报错信息优先用「直接 -n -c 校验原始命令」的结果——行号相对用户命令，更可读；
// 命令本身校验通过而 wrapper 失败则说明是脚本生成的 bug，报 wrapper 错误（含脚本路径）。
// 校验器自身不可用（bash 不在 PATH、超时等）时放行，不挡执行。
export function checkBashSyntax(scriptPath: string, command: string): string | null {
	const run = (args: string[]): string | null => {
		try {
			execFileSync("bash", args, {
				encoding: "utf-8",
				timeout: 10_000,
				stdio: ["ignore", "ignore", "pipe"],
			});
			return null;
		} catch (err) {
			const e = err as { status?: unknown; stderr?: unknown };
			// 非「带退出码的失败」（spawn 失败 / 超时被杀）不算语法错误，放行。
			if (typeof e.status !== "number" || e.status === 0) return null;
			const stderr = typeof e.stderr === "string" ? e.stderr.trim() : "";
			return stderr || `bash -n exited with code ${e.status}`;
		}
	};
	const wrapperError = run(["-n", scriptPath]);
	if (wrapperError === null) return null;
	const commandError = run(["-n", "-c", command]);
	const message = commandError ?? wrapperError;
	const version = bashVersion();
	return version ? `${message}\n[checked with ${version}]` : message;
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
	sessionEnv?: SessionEnv,
): StartResult {
	const { options } = state;
	ensureSession(options, cwd);

	const id = randomBytes(4).toString("hex");
	const displayCommand = command.replace(/\s+/g, " ").trim();
	const scriptPath = writeScript(state, id, command, displayCommand, sessionEnv);
	const syntaxError = checkBashSyntax(scriptPath, command);
	if (syntaxError) {
		// 抛错交给 index.ts 的 catch → 「Failed to execute command: …」（isError）。
		throw new Error(`bash -n pre-check failed; the command was never started:\n${syntaxError}`);
	}
	const windowName = windowNameFor(command, name);
	const windowId = newWindow(options, windowName, cwd, scriptPath);
	const outputFile = join(state.runDir!, `${id}.${windowId}.out`);

	setWindowOptions(options, windowId, {
		[WINDOW_OPTIONS.piSession]: state.piSessionId,
		[WINDOW_OPTIONS.startedAt]: String(Math.floor(Date.now() / 1000)),
		[WINDOW_OPTIONS.jobId]: id,
		[WINDOW_OPTIONS.outputFile]: outputFile,
		[WINDOW_OPTIONS.command]: displayCommand,
	});

	state.jobs.set(id, {
		id,
		windowId,
		name: windowName,
		command: displayCommand,
		outputFile,
		startedAt: Date.now(),
		status: "running",
	});
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
		sessionEnv?: SessionEnv;
	},
): Promise<ToolTextResult> {
	const { options } = state;
	ensureSession(options, params.cwd);

	const id = randomBytes(4).toString("hex");
	const displayCommand = params.command.replace(/\s+/g, " ").trim();
	// 前台窗口与「自动转后台」复用同一 wrapper 脚本（同 id），故 session 元数据在此一次性写入即可。
	const scriptPath = writeScript(state, id, params.command, displayCommand, params.sessionEnv);
	const syntaxError = checkBashSyntax(scriptPath, params.command);
	if (syntaxError) {
		// 对齐内置 bash 行为：语法错误 = stderr 正文 + 「Command exited with code 2」（bash 对
		// 语法错误的真实退出码就是 2）；额外注明命令根本没启动，无任何副作用。
		return {
			content: [
				{
					type: "text",
					text: `${syntaxError}\n\nCommand exited with code 2\n[rejected by bash -n pre-check; the command was never started]`,
				},
			],
			details: { exitCode: 2, syntaxCheckFailed: true, durationMs: 0 },
			isError: true,
		};
	}
	const windowName = windowNameFor(params.command, undefined);
	const windowId = newWindow(options, windowName, params.cwd, scriptPath);
	const outputFile = join(state.runDir!, `${id}.${windowId}.out`);
	const exitFile = join(state.runDir!, `${id}.${windowId}`);

	// 注意：前台窗口此时【不打标签】——正在跑的前台命令不应被 listTaskWindows 计入（否则 /bg
	// 会列出、footer 会计数、用户还能误杀正在执行的前台命令）。仅当它真正「转后台」时
	// 才打标签（见下方自动转后台分支）。
	const startedAt = Date.now();
	const hardTimeoutMs =
		params.timeoutSec != null && Number.isFinite(params.timeoutSec) && params.timeoutSec > 0
			? params.timeoutSec * 1000
			: null;
	const POLL_MS = 150;

	params.onUpdate?.({ content: [], details: undefined });
	let lastEmitted = "";
	let lastLivenessCheckAt = startedAt;

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

		// 窗口死亡检测（约每秒一次，避免每拍都起 tmux 子进程）：语法预检拦不住的崩溃
		// （OOM、被外部 kill-window、tmux server 挂掉）会让窗口在没写哨兵文件的情况下
		// 消失；不检测就会空等到前台窗口结束、把早已死透的任务误转后台（哨兵永不出现
		// → 完成通知永不到来）。
		if (Date.now() - lastLivenessCheckAt >= 1000) {
			lastLivenessCheckAt = Date.now();
			if (!windowExists(options, windowId)) {
				// 留一拍复查：消除「哨兵刚写完、窗口随即被关」与本检测的竞态。
				await sleep(200);
				if (existsSync(exitFile)) {
					const exitCode = readExitCode(exitFile);
					if (!Number.isNaN(exitCode)) return finishInline(exitCode);
				}
				return buildFinalResult(
					state,
					outputFile,
					-1,
					Date.now() - startedAt,
					`Command's tmux window ${windowId} disappeared without recording an exit code — the wrapper crashed or the window was killed externally. The command is no longer running.`,
				);
			}
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
			state.jobs.set(id, {
				id,
				windowId,
				name: windowName,
				command: displayCommand,
				outputFile,
				startedAt,
				status: "running",
			});
			if (existsSync(exitFile)) {
				const exitCode = readExitCode(exitFile);
				if (!Number.isNaN(exitCode)) {
					// 恰在切换点完成，仍按前台结果返回；不要把它留进「后台任务历史」。
					state.jobs.delete(id);
					return finishInline(exitCode);
				}
			}
			// 真正转后台了 → 现在才给窗口打标签（startedAt 用创建时刻，保证耗时显示正确；
			// 到此前的前台执行期间窗口无标签，不会被 list/count）。
			setWindowOptions(options, windowId, {
				[WINDOW_OPTIONS.piSession]: state.piSessionId,
				[WINDOW_OPTIONS.startedAt]: String(Math.floor(startedAt / 1000)),
				[WINDOW_OPTIONS.jobId]: id,
				[WINDOW_OPTIONS.outputFile]: outputFile,
				[WINDOW_OPTIONS.command]: displayCommand,
			});
			const waitSec = Math.round(options.foregroundTimeoutMs / 1000);
			return {
				content: [
					{
						type: "text",
						text: [
							`Command still running after ${waitSec}s — moved to background as job ${id} (tmux window ${windowId}).`,
							"The command is already detached. Do not wait for it: NEVER call bash with sleep or polling loops, and NEVER call bg list/logs merely to check whether it has finished.",
							"Continue only with independent useful work; otherwise end your turn now. Completion is delivered automatically and will trigger a new turn when the session is idle.",
							`For deliberate manual inspection only (not polling): bg action=logs window=${windowId} · Stop: bg action=kill window=${windowId}`,
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
export function startWatcher(
	state: RuntimeState,
	pi: ExtensionAPI,
	onJobsChanged?: () => void,
): void {
	if (state.watcher || !state.runDir) return;
	state.watcher = watch(state.runDir, (_event, filename) => {
		if (!filename) return;
		const name = filename.toString();
		if (name.endsWith(".out") || name.endsWith(".tmp") || name.endsWith(".sh")) return;
		const dot = name.indexOf(".");
		if (dot <= 0) return;
		const id = name.slice(0, dot);
		const job = state.jobs.get(id);
		if (!job || job.status !== "running") return;
		const exitPath = join(state.runDir!, name);
		if (!existsSync(exitPath)) return;
		// 稍等一拍确保 .out 写盘完成，再处理。
		const timer = setTimeout(() => {
			state.pendingTimers.delete(timer);
			handleCompletion(state, pi, id, exitPath, onJobsChanged);
		}, 40);
		state.pendingTimers.add(timer);
	});
}

function handleCompletion(
	state: RuntimeState,
	pi: ExtensionAPI,
	id: string,
	exitPath: string,
	onJobsChanged?: () => void,
): void {
	const job = state.jobs.get(id);
	if (!job || job.status !== "running" || state.shuttingDown) return;
	if (!existsSync(exitPath)) return;

	let exitCode = NaN;
	try {
		exitCode = parseInt(readFileSync(exitPath, "utf-8").trim(), 10);
	} catch {
		return;
	}
	job.status = "completed";
	job.exitCode = exitCode;
	job.finishedAt = Date.now();
	// 状态先落地再通知 UI：即使 steer 尚在等待当前工具批次结束，footer 也应立即反映真实运行数。
	// UI 刷新失败不能阻断终态标签、日志读取与完成消息投递。
	try {
		onJobsChanged?.();
	} catch {
		/* ignore UI refresh errors */
	}
	// autoClose=false 或 reload 后，内存历史/哨兵可能消失；把终态也写进 tmux 标签，窗口仍在时可恢复。
	setWindowOptions(state.options, job.windowId, {
		[WINDOW_OPTIONS.exitCode]: String(exitCode),
		[WINDOW_OPTIONS.finishedAt]: String(Math.floor(job.finishedAt / 1000)),
	});

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
		// steer：若 Agent 正在跑工具，则在当前 assistant 消息的全部工具结束后、下一次 LLM 调用前投递；
		// 避免 followUp 因模型持续 sleep/bg 轮询而永远等不到 Agent 收尾。
		{ deliverAs: "steer", triggerTurn: true },
	);
	pruneFinishedJobs(state);
}

function pruneFinishedJobs(state: RuntimeState): void {
	const finished = [...state.jobs.values()]
		.filter((job) => job.status !== "running")
		.sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
	for (const job of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_FINISHED_JOBS))) {
		state.jobs.delete(job.id);
	}
}

// bg list/kill 的 fs.watch 兜底：若哨兵已经存在但 watcher 尚未处理（或漏事件），同步完成状态、
// autoClose 并发送 steer。返回本次补处理的任务数。
export function reconcileCompletedJobs(state: RuntimeState, pi: ExtensionAPI): number {
	let completed = 0;
	for (const job of [...state.jobs.values()]) {
		if (job.status !== "running" || !job.outputFile.endsWith(".out")) continue;
		const exitPath = job.outputFile.slice(0, -4);
		if (!existsSync(exitPath)) continue;
		handleCompletion(state, pi, job.id, exitPath);
		if (state.jobs.get(job.id)?.status === "completed") completed++;
	}
	return completed;
}

export function markJobKilled(state: RuntimeState, windowId: string): boolean {
	const job = [...state.jobs.values()].find((candidate) => candidate.windowId === windowId);
	if (!job || job.status !== "running") return false;
	job.status = "killed";
	job.finishedAt = Date.now();
	pruneFinishedJobs(state);
	return true;
}

export interface JobLogSnapshot {
	text: string;
	truncated: boolean;
	fullPath?: string;
}

// 用户从 /bg 面板手动 kill 一个仍在运行的任务时，给 assistant 发一条通知（含尾部输出），
// 正文里明确写「是用户杀的」。时机：turn 内 steer / idle nextTurn，**永不 triggerTurn**——
// kill 是用户的意图动作，不该主动唤醒 assistant 说话（对比自然完成 handleCompletion 用
// steer + triggerTurn，因为那是 assistant 可能在等的后台结果）。
// 去重：仅由调用方在「确实杀掉一个 running 任务」时调用；若任务其实刚自然完成，handleCompletion
// 已发过完成通知，这里不会被触及。
// 输出（logs）由调用方在【杀窗口之前】读好传入（趁窗口还活着，capture-pane 兜底可用，
// .out 即使被 reload 回收也不至于丢）。
export function notifyUserKilled(
	state: RuntimeState,
	pi: ExtensionAPI,
	info: BackgroundJobInfo,
	streaming: boolean,
	logs: JobLogSnapshot,
): void {
	if (state.shuttingDown) return;
	const { text, truncated, fullPath } = logs;
	const durSec = info.startedAt ? ((Date.now() - info.startedAt) / 1000).toFixed(1) : "?";
	const header =
		`Background job ${info.jobId ?? "?"} (${info.windowId}) was TERMINATED BY THE USER from the /bg panel ` +
		`after ${durSec}s. The user manually killed it — this is not an error, not a crash, and not something ` +
		`to retry or resume unless the user asks.`;
	const footer = truncated && fullPath ? `\n\n[output truncated; full log: ${fullPath}]` : "";
	const content = frameBgNotify(`${header}\n$ ${info.command}\n\nPartial output before it was killed:\n\n${text}${footer}`);
	pi.sendMessage(
		{
			customType: COMPLETION_CUSTOM_TYPE,
			content,
			display: true,
			details: {
				jobId: info.jobId,
				windowId: info.windowId,
				killedByUser: true,
				command: info.command,
				outputFile: info.outputFile,
				durationMs: info.startedAt ? Date.now() - info.startedAt : undefined,
			},
		},
		// turn 内 steer（当前消息工具跑完、下次 LLM 调用前注入）；idle 时 nextTurn（随下个用户
		// prompt 带上，不打断、不触发）。两种都不 triggerTurn。
		{ deliverAs: streaming ? "steer" : "nextTurn" },
	);
}

// 当前 pi 会话仍在运行的任务数（供状态栏显示）。
export function runningCount(state: RuntimeState): number {
	return [...state.jobs.values()].filter((j) => j.status === "running").length;
}

export type BackgroundJobStatus = JobStatus | "missing";

export interface BackgroundJobInfo {
	jobId?: string;
	windowId: string;
	name: string;
	command: string;
	outputFile?: string;
	startedAt?: number; // Date.now() 毫秒
	finishedAt?: number; // Date.now() 毫秒
	status: BackgroundJobStatus;
	exitCode?: number;
}

// 从残留的退出码哨兵恢复 reload 前任务的完成状态。正常 watcher 已处理的任务会删除哨兵，
// 但它们仍在 state.jobs 中；这里只服务「窗口标签还在、内存 job 表已丢」的 reload 场景。
function readWindowCompletion(outputFile: string | undefined): { exitCode: number; finishedAt?: number } | null {
	if (!outputFile?.endsWith(".out")) return null;
	const exitFile = outputFile.slice(0, -4);
	if (!existsSync(exitFile)) return null;
	const exitCode = readExitCode(exitFile);
	if (Number.isNaN(exitCode)) return null;
	try {
		return { exitCode, finishedAt: statSync(exitFile).mtimeMs };
	} catch {
		return { exitCode };
	}
}

function readTaggedWindowCompletion(window: TmuxWindow | undefined): { exitCode: number; finishedAt?: number } | null {
	if (window?.exitCode === undefined || !Number.isFinite(window.exitCode)) return null;
	return {
		exitCode: window.exitCode,
		finishedAt: window.finishedAt === undefined ? undefined : window.finishedAt * 1000,
	};
}

// 列出当前 pi 会话已知的后台任务：运行中任务来自 tmux 窗口，已完成/已 kill 的任务保留在
// state.jobs 中，因此即使 autoClose 已关闭窗口，bg list 仍能显示最终状态。
export function listJobsForSession(state: RuntimeState): BackgroundJobInfo[] {
	const windows = listTaskWindows(state.options, state.piSessionId);
	const windowById = new Map(windows.map((w) => [w.id, w]));
	const result: BackgroundJobInfo[] = [];

	for (const job of state.jobs.values()) {
		const window = windowById.get(job.windowId);
		windowById.delete(job.windowId);
		// fs.watch 的 40ms 处理窗口内（或偶发漏事件时），bg list 也可直接从哨兵识别完成；
		// 这里只影响快照，不修改 job.status，以免抢先阻止 watcher 正常发送 steer 通知。
		const recoveredCompletion =
			job.status === "running"
				? readTaggedWindowCompletion(window) ?? readWindowCompletion(job.outputFile)
				: null;
		result.push({
			jobId: job.id,
			windowId: job.windowId,
			name: window?.name ?? job.name,
			command: window?.command ?? job.command,
			outputFile: window?.outputFile ?? job.outputFile,
			startedAt: job.startedAt,
			finishedAt: job.finishedAt ?? recoveredCompletion?.finishedAt,
			status:
				recoveredCompletion !== null
					? "completed"
					: job.status === "running" && !window
						? "missing"
						: job.status,
			exitCode: job.exitCode ?? recoveredCompletion?.exitCode,
		});
	}

	// reload 后窗口仍在，但新 runtime 的 state.jobs 不含旧任务；优先借残留哨兵识别已完成状态。
	for (const window of windowById.values()) {
		const completion = readTaggedWindowCompletion(window) ?? readWindowCompletion(window.outputFile);
		result.push({
			jobId: window.jobId,
			windowId: window.id,
			name: window.name,
			command: window.command ?? "",
			outputFile: window.outputFile,
			startedAt: window.startedAt === undefined ? undefined : window.startedAt * 1000,
			finishedAt: completion?.finishedAt,
			status: completion ? "completed" : "running",
			exitCode: completion?.exitCode,
		});
	}

	return result.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

export function listWindowsForSession(state: RuntimeState) {
	return listTaskWindows(state.options, state.piSessionId);
}

// 会话结束/reload 时清理：关掉 watcher 和定时器，清空 job 表，并回收磁盘上的临时产物。
// 注意：故意不杀 tmux 窗口/会话——后台任务应当在 pi 退出后继续存活。
//
// 磁盘回收策略（前提：正常使用下后台任务生命周期含于 pi 进程生命周期内）：
//   1) 当前 runDir：
//        · reason === "quit"（pi 真正退出）→ 整个删掉（含 .out），因为进程一走任务即结束。
//        · 其它（reload/new/resume/fork，pi 进程仍在）→ 只删 scriptDir、保留 .out（可能还有
//          后台任务在写 / 用户想 attach 复看）；该旧 runDir 会在后续某次 shutdown 作为
//          「本进程遗留的旧 runDir」被回收。
//   2) 其它 runDir（历史会话产物），按目录名里的创建 pid 判定：
//        · pid 已不存在 → 那个 pi 实例早退出了，残骸，删。
//        · pid === 本进程 pid → 本进程之前会话遗留、已孤立的旧 runDir，删。
//        · pid 属于另一个存活的 pi 实例 → 保留，避免误删并存实例的产物。
//        · 目录名解析不出 pid（异常/旧格式）→ 保守跳过，不删。
export function cleanup(state: RuntimeState, reason?: string): void {
	state.shuttingDown = true;
	state.watcher?.close();
	state.watcher = null;
	for (const t of state.pendingTimers) clearTimeout(t);
	state.pendingTimers.clear();
	state.jobs.clear();

	const currentName = state.runDir ? basename(state.runDir) : null;

	// 1) 当前 runDir。
	if (state.runDir && existsSync(state.runDir)) {
		if (reason === "quit") {
			rmDirQuiet(state.runDir);
		} else if (state.scriptDir && existsSync(state.scriptDir)) {
			rmDirQuiet(state.scriptDir); // 保留 .out，仅清脚本目录
		}
	}

	// 2) 回收历史会话产物。
	let entries: string[];
	try {
		entries = readdirSync(state.options.outputDir);
	} catch {
		return; // 根目录还不存在，无可回收
	}
	for (const name of entries) {
		if (name === currentName) continue; // 当前 runDir 已在上面处理
		const full = join(state.options.outputDir, name);
		try {
			if (!statSync(full).isDirectory()) continue;
		} catch {
			continue;
		}
		const pid = parseRunDirPid(name);
		if (Number.isNaN(pid)) continue; // 解析不出 pid，保守跳过
		if (!pidAlive(pid) || pid === process.pid) rmDirQuiet(full);
	}
}

function rmDirQuiet(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
}

// runDir 目录名格式：<base64url(sessionId)>-<pid>-<hex>。base64url 可能含 '-'，故从后往前取：
// 末段是随机 hex，倒数第二段才是创建它的 pi 进程 pid。解析不出返回 NaN。
function parseRunDirPid(name: string): number {
	const parts = name.split("-");
	if (parts.length < 3) return NaN;
	const pid = Number(parts[parts.length - 2]);
	return Number.isInteger(pid) && pid > 0 ? pid : NaN;
}

// 判断某 pid 是否仍有存活进程（kill 0 探测；EPERM = 进程在但无权限，视为存活）。
function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

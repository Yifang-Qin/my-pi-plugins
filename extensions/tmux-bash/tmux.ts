// tmux 底层封装。
//
// 关键决定：全部用 execFileSync 的「数组参数」形式调用 tmux，不拼 shell 字符串，
// 从根上避开会话名/窗口名/路径里的引号与空格问题（这是相对 pi-tmux-bash 用
// shellQuote 拼串的一个改进点）。命令都很短，同步执行不会明显阻塞事件循环。

import { execFileSync } from "node:child_process";
import type { TmuxBashOptions } from "./config.js";
import { WINDOW_OPTIONS } from "./config.js";

export interface TmuxWindow {
	id: string; // #{window_id}，形如 @123
	name: string;
	piSession?: string;
	startedAt?: number; // unix 秒
	jobId?: string;
	outputFile?: string;
	command?: string;
}

// 运行 tmux 子命令，失败（非零退出）时返回 null，不抛异常。
function tmuxSafe(opts: TmuxBashOptions, args: string[]): string | null {
	try {
		return execFileSync(opts.tmuxBinary, args, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch {
		return null;
	}
}

// 运行 tmux 子命令，失败时抛出（用于「必须成功」的建窗口等操作）。
function tmuxExec(opts: TmuxBashOptions, args: string[]): string {
	return execFileSync(opts.tmuxBinary, args, {
		encoding: "utf-8",
		timeout: 10_000,
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
}

export function tmuxAvailable(opts: TmuxBashOptions): boolean {
	return tmuxSafe(opts, ["-V"]) !== null;
}

export function sessionExists(opts: TmuxBashOptions): boolean {
	return tmuxSafe(opts, ["has-session", "-t", opts.sessionName]) !== null;
}

// 确保共享后台会话存在。第一次会创建一个 detached 会话（附带一个占位 shell 窗口，
// 保证即使所有任务窗口都关闭后会话依然存活，可继续 attach）。
export function ensureSession(opts: TmuxBashOptions, cwd: string): void {
	if (sessionExists(opts)) return;
	tmuxExec(opts, ["new-session", "-d", "-s", opts.sessionName, "-c", cwd, "-n", "pi-bg"]);
}

// 在会话里新开一个窗口执行脚本，返回稳定的 #{window_id}（如 @123）。
// tmux 把末尾参数当作要执行的 shell-command；scriptPath 是可执行脚本，直接跑。
//
// 必须带 -a：`-t <session>` 只给会话名时，tmux 把 target-window 解析成会话的当前窗口
// （即 ensureSession 建的占位窗口，落在 base-index 处）；不带 -a/-b 时 new-window 会试图
// 在该目标索引建窗，与占位窗口撞索引 → "create window failed: index N in use"（默认
// base-index=0 时就是 index 0）。-a 表示追加到目标窗口之后、自动取下一个空闲索引，
// 无论用户 base-index / renumber-windows 怎么配都不会冲突。
export function newWindow(
	opts: TmuxBashOptions,
	windowName: string,
	cwd: string,
	scriptPath: string,
): string {
	return tmuxExec(opts, [
		"new-window",
		"-a",
		"-d",
		"-t",
		opts.sessionName,
		"-n",
		windowName.slice(0, opts.maxWindowNameLength),
		"-c",
		cwd,
		"-P",
		"-F",
		"#{window_id}",
		scriptPath,
	]);
}

export function setWindowOptions(
	opts: TmuxBashOptions,
	windowId: string,
	values: Record<string, string>,
): void {
	for (const [key, value] of Object.entries(values)) {
		tmuxSafe(opts, ["set-window-option", "-t", windowId, key, value]);
	}
}

export function killWindow(opts: TmuxBashOptions, windowId: string): boolean {
	return tmuxSafe(opts, ["kill-window", "-t", windowId]) !== null;
}

export function capturePane(opts: TmuxBashOptions, windowId: string, lines: number): string {
	return tmuxSafe(opts, ["capture-pane", "-t", windowId, "-p", "-S", `-${lines}`]) ?? "";
}

const WINDOW_FORMAT = [
	"#{window_id}",
	"#{window_name}",
	`#{${WINDOW_OPTIONS.piSession}}`,
	`#{${WINDOW_OPTIONS.startedAt}}`,
	`#{${WINDOW_OPTIONS.jobId}}`,
	`#{${WINDOW_OPTIONS.outputFile}}`,
	`#{${WINDOW_OPTIONS.command}}`,
].join("\t");

// 列出会话内所有窗口。只有带 jobId 标签的才是本插件创建的任务窗口；
// piSession 用于过滤出「属于当前 pi 会话」的任务。
export function listTaskWindows(opts: TmuxBashOptions, piSession?: string): TmuxWindow[] {
	const raw = tmuxSafe(opts, ["list-windows", "-t", opts.sessionName, "-F", WINDOW_FORMAT]);
	if (!raw) return [];
	return raw
		.split("\n")
		.map((line): TmuxWindow => {
			const [id = "", name = "", session = "", started = "", jobId = "", out = "", cmd = ""] =
				line.split("\t");
			return {
				id,
				name,
				piSession: session || undefined,
				startedAt: started ? Number(started) : undefined,
				jobId: jobId || undefined,
				outputFile: out || undefined,
				command: cmd || undefined,
			};
		})
		.filter((w) => w.jobId) // 只保留任务窗口，滤掉占位 shell 窗口
		.filter((w) => (piSession ? w.piSession === piSession : true));
}

// 拼一个「如何 attach」的提示。已经在 tmux 里就用 switch-client，否则 attach。
export function attachHint(opts: TmuxBashOptions, windowId: string): string {
	const inTmux = Boolean(process.env.TMUX);
	const bin = opts.tmuxBinary;
	return inTmux
		? `${bin} switch-client -t ${opts.sessionName} \\; select-window -t ${windowId}`
		: `${bin} attach -t ${opts.sessionName} \\; select-window -t ${windowId}`;
}

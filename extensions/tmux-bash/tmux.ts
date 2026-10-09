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
	exitCode?: number;
	finishedAt?: number; // unix 秒
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
// 错误信息里带上 tmux 自己的 stderr —— execFileSync 的 err.message 只有干巴巴的
// "Command failed: …"，而真正可操作的原因（protocol version mismatch / no server running /
// index in use）全在 stderr 里，丢掉它会让上层只能报「Failed to execute command」。
function tmuxExec(opts: TmuxBashOptions, args: string[]): string {
	try {
		return execFileSync(opts.tmuxBinary, args, {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	} catch (err) {
		throw new Error(describeTmuxFailure(opts, args, err));
	}
}

// 把 tmux 失败翻译成一句可操作的话。protocol version mismatch 是「server 比 client 老」的典型
// 症状：tmux 升级后旧 server 仍在跑，client 拒绝通信；此时 `tmux -V`（纯 client）照样成功，
// 所以 tmuxAvailable() 探不出来，必须在这里点名。
function describeTmuxFailure(opts: TmuxBashOptions, args: string[], err: unknown): string {
	const stderr = (() => {
		const raw = (err as { stderr?: Buffer | string } | null)?.stderr;
		if (!raw) return "";
		return (typeof raw === "string" ? raw : raw.toString("utf-8")).trim();
	})();
	const base = `tmux ${args.join(" ")} failed`;
	const detail = stderr || (err instanceof Error ? err.message : String(err));
	if (/protocol version mismatch/i.test(stderr)) {
		return `${base}: ${detail}\nThe running tmux server is older than the ${opts.tmuxBinary} binary (typically after upgrading tmux). Run \`${opts.tmuxBinary} kill-server\` to restart it; tmux-bash will recreate its session on the next command.`;
	}
	return `${base}: ${detail}`;
}

export function tmuxAvailable(opts: TmuxBashOptions): boolean {
	return tmuxSafe(opts, ["-V"]) !== null;
}

export function sessionExists(opts: TmuxBashOptions): boolean {
	return tmuxSafe(opts, ["has-session", "-t", opts.sessionName]) !== null;
}

// 占位窗口名。注意它**不再等于会话名**（会话名现在带 pid 后缀），这本身就削弱了 new-window
// 的 target 歧义；但 newWindow 里的尾冒号写法仍是必须的，别因此回退（见该函数注释）。
const PLACEHOLDER_WINDOW_NAME = "pi-bg";

// 确保本 pi 进程的后台会话存在。第一次会创建一个 detached 会话（附带一个占位 shell 窗口，
// 保证即使所有任务窗口都关闭后会话依然存活，可继续 attach）。
// 会话名按 pid 派生（见 config.ts），因此这里创建出来的 tmux server 必然是当前 pi 进程的后代；
// 会话由 cleanup() 在 pi 退出时连根拆除，不留给下一个 pi 实例复用。
export function ensureSession(opts: TmuxBashOptions, cwd: string): void {
	if (sessionExists(opts)) return;
	tmuxExec(opts, ["new-session", "-d", "-s", opts.sessionName, "-c", cwd, "-n", PLACEHOLDER_WINDOW_NAME]);
}

// 列出 tmux server 上所有会话名（server 未启动 / tmux 不可用时返回空数组）。
export function listSessions(opts: TmuxBashOptions): string[] {
	const raw = tmuxSafe(opts, ["list-sessions", "-F", "#{session_name}"]);
	if (!raw) return [];
	return raw.split("\n").filter(Boolean);
}

// 拆掉整个会话（连带其中所有任务窗口 → 所有仍在跑的命令被杀）。
// 会话不存在时返回 false（kill-session 非零退出），调用方不必区分。
export function killSession(opts: TmuxBashOptions, sessionName = opts.sessionName): boolean {
	return tmuxSafe(opts, ["kill-session", "-t", sessionName]) !== null;
}

// 杀掉归属于某个 pi 会话（@pi_bg_session 标签）的全部任务窗口，保留会话本身与占位窗口。
// 用于 pi 进程内的会话切换（new/resume/fork）：切换后这些窗口再也不会被任何列表选中
// （listTaskWindows 按当前 piSessionId 过滤），留着就是无主的僵尸任务。
export function killWindowsForPiSession(opts: TmuxBashOptions, piSession: string): number {
	if (!piSession) return 0;
	let killed = 0;
	for (const window of listTaskWindows(opts, piSession)) {
		if (killWindow(opts, window.id)) killed++;
	}
	return killed;
}

// 在会话里新开一个窗口执行脚本，返回稳定的 #{window_id}（如 @123）。
// tmux 把末尾参数当作要执行的 shell-command；scriptPath 是可执行脚本，直接跑。
//
// 必须带 -a：`-t <session>:` 解析成会话的当前窗口（即 ensureSession 建的占位窗口，落在
// base-index 处）；不带 -a/-b 时 new-window 会试图在该目标索引建窗，与占位窗口撞索引 →
// "create window failed: index N in use"（默认 base-index=0 时就是 index 0）。-a 表示追加到
// 目标窗口之后、自动取下一个空闲索引，无论用户 base-index / renumber-windows 怎么配都不会冲突。
//
// 目标必须写成 `<session>:`（带尾冒号）而不是裸 `<session>`：new-window 的 -t 是 target-window，
// 不含 ':' 时 tmux 先把它当**当前会话里的窗口名/索引**来匹配，匹配不到才退回按会话名解析。
// 而 ensureSession 建的占位窗口恰好也叫 `pi-bg`（= 会话名），于是只要存在第二个 tmux 会话、
// 且**那个会话**是 tmux 眼里的「当前会话」（= 最近使用），裸 `-t pi-bg` 就会命中它里面名为
// `pi-bg` 的窗口，把任务窗口建到**别的会话**里（实测 tmux 3.7c）。后果是 listTaskWindows /
// killWindow 都找不到它，后台任务变成游离窗口。尾冒号强制按 target-session 解析，消除歧义。
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
		`${opts.sessionName}:`,
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

// 窗口是否仍存活。wrapper 崩溃（脚本解析失败、OOM 等）或被外部 kill 时，窗口会在
// 没写退出码哨兵文件的情况下消失；前台等待循环靠它做死亡检测（tmux server 挂了
// 同样返回 false，语义一致：命令已不可能再产出结果）。
// 注意用 list-panes 而非 display-message：后者对不存在的 -t 目标也退出 0（实测
// tmux 3.7b，回退到当前客户端上下文），无法用作存活判据。
export function windowExists(opts: TmuxBashOptions, windowId: string): boolean {
	return tmuxSafe(opts, ["list-panes", "-t", windowId]) !== null;
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
	`#{${WINDOW_OPTIONS.exitCode}}`,
	`#{${WINDOW_OPTIONS.finishedAt}}`,
].join("\t");

// 列出会话内所有窗口。只有带 jobId 标签的才是本插件创建的任务窗口；
// piSession 用于过滤出「属于当前 pi 会话」的任务。
export function listTaskWindows(opts: TmuxBashOptions, piSession?: string): TmuxWindow[] {
	const raw = tmuxSafe(opts, ["list-windows", "-t", opts.sessionName, "-F", WINDOW_FORMAT]);
	if (!raw) return [];
	return raw
		.split("\n")
		.map((line): TmuxWindow => {
			const [
				id = "",
				name = "",
				session = "",
				started = "",
				jobId = "",
				out = "",
				cmd = "",
				exit = "",
				finished = "",
			] = line.split("\t");
			return {
				id,
				name,
				piSession: session || undefined,
				startedAt: started ? Number(started) : undefined,
				jobId: jobId || undefined,
				outputFile: out || undefined,
				command: cmd || undefined,
				exitCode: exit ? Number(exit) : undefined,
				finishedAt: finished ? Number(finished) : undefined,
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

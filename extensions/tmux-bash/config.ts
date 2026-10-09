// tmux-bash 配置与默认值。
//
// 本仓库不引入 @richardgill/pi-config，配置一律走「常量默认值 + 环境变量覆盖」，
// 保持 skeleton 依赖最小。需要更复杂的 JSONC 配置时再引入配置层。

import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { makeBgNotifyFramer } from "../shared/bg-notify.js";

const num = (v: string | undefined, fallback: number): number => {
	const n = Number(v);
	return Number.isFinite(n) && n > 0 ? n : fallback;
};

const bool = (v: string | undefined, fallback: boolean): boolean => {
	if (v === undefined) return fallback;
	return /^(1|true|yes|on)$/i.test(v.trim());
};

export interface TmuxBashOptions {
	/** tmux 可执行文件（可用 PI_TMUX_BASH_TMUX 覆盖）。 */
	tmuxBinary: string;
	/**
	 * 后台 tmux 会话名。默认 `${sessionPrefix}-${process.pid}` —— **每个 pi 进程一个独立会话**。
	 *
	 * 为什么不是固定名（如早期的裸 `pi-bg`）：固定名 + 「占位窗口让会话永不消亡」会让 tmux server
	 * 比创建它的 pi 进程、甚至比终端程序活得更久，后续 pi 会话都复用它，于是继承它**诞生那一刻的
	 * 进程上下文**。实测事故（2026-10，详见 README「会话生命周期」）：server 由 5 天前某次跑在
	 * 「Documents 权限被拒」终端里的 pi 创建 → 之后所有会话的 bash 都对 ~/Documents 报
	 * `Operation not permitted`，而 pi 自身的 read 工具正常（macOS TCC 按 responsible process 归属）。
	 * 同源风险还有：tmux 升级后 client/server `protocol version mismatch`、跨实例窗口泄漏、
	 * 测试与日常会话互相串台。按 pid 命名后，server 必然是当前 pi 进程的后代。
	 */
	sessionName: string;
	/** 会话名前缀（默认 `pi-bg`，PI_TMUX_BASH_SESSION_PREFIX 覆盖）。用于回收崩溃残留会话。 */
	sessionPrefix: string;
	/** 用户用 PI_TMUX_BASH_SESSION 显式钉死了会话名 → 放弃按 pid 的残留回收（无法安全推断前缀）。 */
	sessionPinned: boolean;
	/** runDir / .out / 退出码哨兵文件的根目录（PI_TMUX_BASH_DIR 覆盖）。 */
	outputDir: string;
	/** 完成后是否自动关闭 tmux 窗口。false 时命令跑完仍可 attach 查看。 */
	autoCloseOnComplete: boolean;
	/** 读日志时保留的最大行数 / 字节数（复用 pi 的截断阈值）。 */
	maxLines: number;
	maxBytes: number;
	/** 前台同步等待窗口（毫秒）。未显式 timeout 时，命令跑满此时长仍未结束则自动转后台（不杀）。 */
	foregroundTimeoutMs: number;
	/** tmux 窗口名最大长度。 */
	maxWindowNameLength: number;
	/** 导出到后台窗口时跳过的环境变量（tmux/shell 自己的簿记）。 */
	envDenylist: readonly string[];
	/** 是否对非交互命令做 env 加固（PI_TMUX_BASH_HARDEN_ENV=0 关掉）。 */
	hardenEnv: boolean;
}

const DEFAULT_ENV_DENYLIST = ["PWD", "OLDPWD", "SHLVL", "_", "TMUX", "TMUX_PANE"] as const;

/**
 * 命令的 stdin 接法。
 *
 * - `"null"`（默认）：`< /dev/null`。**对齐 pi 内置 bash** 的 `stdio: ["ignore", …]`：读 stdin 的
 *   命令（`cat` 无参、`python`/`node` 进 REPL、`npm init`、`read`）立即拿到 EOF 而不是挂死。
 * - `"tty"`：继承 tmux pane 的 PTY，给「人 `tmux attach` 进去敲键盘」的场景用；同时**跳过非交互
 *   env 加固**（语义：谁要了 tty 就是打算交互，对齐 omp 的 PTY 路径不加固的做法）。
 */
export type StdinMode = "null" | "tty";

// —— 非交互环境加固 —— //
//
// 原理：程序判断「能否跟人交互」有四条独立信道 —— ① `isatty(fd)`、② `TERM`、③ 程序自带的
// 非交互旋钮（环境变量）、④ 直接 `open("/dev/tty")`。本表只能治 ②③；① 由 stdin 重定向（StdinMode）
// 与 wrapper 的 `| tee` 管道治；④ 只能靠「无控制终端」（setsid）彻底堵，而那会废掉本扩展「可 attach
// 接管」的优势，故**有意不做** —— 代价是 `sudo` 密码、`ssh` 首连 host-key 这类直走 /dev/tty 的提示仍会
// 挂住（`SSH_ASKPASS_REQUIRE=force` 能治其中的 ssh 部分）。
//
// 层次：这批默认值在 wrapper 里导出在 `formatEnvExports`（= ambient process.env）**之后**，因此会
// 覆盖继承来的 `PAGER=less` / `TERM=xterm-256color`；而命令文本本身跑在最后，所以用户写
// `PAGER=less cmd` 或在命令里 `export` 依旧能赢。这与 omp 的 `buildNonInteractiveEnv()`
// （加固垂在 ambient 之上、显式 caller env 之下）层次一致。
//
// 作用域：只在**命令子 shell 内**导出，不污染 wrapper 末尾那个保留窗口的 `exec $SHELL -l`
// （否则 autoClose=false 时 attach 进去会得到一个 `TERM=dumb` 的残废 shell）。
const REJECT_PROMPT_COMMAND = existsSync("/usr/bin/false") ? "/usr/bin/false" : "false";

export const NON_INTERACTIVE_ENV: Readonly<Record<string, string>> = {
	// 禁分页器（分页器会从 /dev/tty 读按键 → 挂死）。
	PAGER: "cat",
	GIT_PAGER: "cat",
	MANPAGER: "cat",
	SYSTEMD_PAGER: "cat",
	BAT_PAGER: "cat",
	DELTA_PAGER: "cat",
	GH_PAGER: "cat",
	GLAB_PAGER: "cat",
	PSQL_PAGER: "cat",
	MYSQL_PAGER: "cat",
	AWS_PAGER: "",
	HOMEBREW_PAGER: "cat",
	LESS: "FRX",
	// 禁「我是富终端」信号：让 curses/全屏 UI 直接降级或拒绘，而不是画出界面等输入。
	TERM: "dumb",
	NO_COLOR: "1",
	PYTHONUNBUFFERED: "1",
	// 禁编辑器与凭证提示。
	GIT_EDITOR: "true",
	VISUAL: "true",
	EDITOR: "true",
	GIT_TERMINAL_PROMPT: "0",
	SSH_ASKPASS: REJECT_PROMPT_COMMAND,
	// OpenSSH 8.4+：强制走 askpass（= /usr/bin/false）而不是回退到 /dev/tty 讨密码 → 秒失败。
	SSH_ASKPASS_REQUIRE: "force",
	CI: "true",
	AGENT: "1",
	// 包管理器 / 工具链的无人值守默认值。
	npm_config_yes: "true",
	npm_config_update_notifier: "false",
	npm_config_fund: "false",
	npm_config_audit: "false",
	npm_config_progress: "false",
	PNPM_DISABLE_SELF_UPDATE_CHECK: "true",
	PNPM_UPDATE_NOTIFIER: "false",
	YARN_ENABLE_TELEMETRY: "0",
	YARN_ENABLE_PROGRESS_BARS: "0",
	CARGO_TERM_PROGRESS_WHEN: "never",
	DEBIAN_FRONTEND: "noninteractive",
	PIP_NO_INPUT: "1",
	PIP_DISABLE_PIP_VERSION_CHECK: "1",
	TF_INPUT: "0",
	TF_IN_AUTOMATION: "1",
	GH_PROMPT_DISABLED: "1",
	COMPOSER_NO_INTERACTION: "1",
	CLOUDSDK_CORE_DISABLE_PROMPTS: "1",
};

// 加固条目（应用 `CI=true` 的逃生口，与 omp 的 PI_BASH_NO_CI 同名同义）。
export function nonInteractiveEnvEntries(): [string, string][] {
	const skipCI = Boolean(process.env.PI_BASH_NO_CI || process.env.CLAUDE_BASH_NO_CI);
	return Object.entries(NON_INTERACTIVE_ENV).filter(([key]) => !(skipCI && key === "CI"));
}

export function loadOptions(): TmuxBashOptions {
	// PI_TMUX_BASH_SESSION：显式钉死会话名（可让多个 pi 实例共用一个会话，自担上述风险）。
	// 不设时按 pid 派生，保证「一个 pi 进程 ↔ 一个 tmux 会话」。
	const pinnedSession = process.env.PI_TMUX_BASH_SESSION?.trim();
	const sessionPrefix = process.env.PI_TMUX_BASH_SESSION_PREFIX?.trim() || "pi-bg";
	return {
		tmuxBinary: process.env.PI_TMUX_BASH_TMUX?.trim() || "tmux",
		sessionName: pinnedSession || `${sessionPrefix}-${process.pid}`,
		sessionPrefix,
		sessionPinned: Boolean(pinnedSession),
		outputDir: process.env.PI_TMUX_BASH_DIR?.trim() || join(tmpdir(), "pi-tmux-bash"),
		autoCloseOnComplete: bool(process.env.PI_TMUX_BASH_AUTOCLOSE, true),
		maxLines: num(process.env.PI_TMUX_BASH_MAX_LINES, DEFAULT_MAX_LINES),
		maxBytes: num(process.env.PI_TMUX_BASH_MAX_BYTES, DEFAULT_MAX_BYTES),
		foregroundTimeoutMs: num(process.env.PI_TMUX_BASH_FOREGROUND_TIMEOUT, 120) * 1000,
		maxWindowNameLength: 30,
		envDenylist: DEFAULT_ENV_DENYLIST,
		hardenEnv: bool(process.env.PI_TMUX_BASH_HARDEN_ENV, true),
	};
}

// tmux 自定义窗口选项（user option 必须以 @ 开头）。用于给窗口打标签，
// 便于 list/kill 时过滤出「本插件创建、且属于当前 pi 会话」的任务窗口。
export const WINDOW_OPTIONS = {
	piSession: "@pi_bg_session",
	startedAt: "@pi_bg_started",
	jobId: "@pi_bg_id",
	outputFile: "@pi_bg_out",
	command: "@pi_bg_cmd",
	exitCode: "@pi_bg_exit",
	finishedAt: "@pi_bg_finished",
} as const;

// 完成通知消息的 customType（配合 registerMessageRenderer）。
export const COMPLETION_CUSTOM_TYPE = "tmux-bash-completion";

// —— 后台完成通知的「系统通知框」 ——
// 协议（标签/版式/剥框算法）在 ../shared/bg-notify.ts 单一来源，这里只定制引言文案。
// 为什么需要框、以及 ../shared 的可达性说明，见该共享模块头注释。
const { frame: frameBgNotify, strip: stripBgNotifyFrame } = makeBgNotifyFramer(
	"System notification from the tmux-bash extension — NOT a message from the user. A background " +
		"shell command you started earlier has just finished; its result is below. Treat it as a status " +
		"update: use it if relevant to the current task, otherwise acknowledge briefly and continue.",
);
export { frameBgNotify, stripBgNotifyFrame };

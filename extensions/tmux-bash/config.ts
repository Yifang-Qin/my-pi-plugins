// tmux-bash 配置与默认值。
//
// 本仓库不引入 @richardgill/pi-config，配置一律走「常量默认值 + 环境变量覆盖」，
// 保持 skeleton 依赖最小。需要更复杂的 JSONC 配置时再引入配置层。

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
	/** 共享的后台 tmux 会话名（所有 pi 会话共用，按窗口标签区分归属）。 */
	sessionName: string;
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
}

const DEFAULT_ENV_DENYLIST = ["PWD", "OLDPWD", "SHLVL", "_", "TMUX", "TMUX_PANE"] as const;

export function loadOptions(): TmuxBashOptions {
	return {
		tmuxBinary: process.env.PI_TMUX_BASH_TMUX?.trim() || "tmux",
		sessionName: process.env.PI_TMUX_BASH_SESSION?.trim() || "pi-bg",
		outputDir: process.env.PI_TMUX_BASH_DIR?.trim() || join(tmpdir(), "pi-tmux-bash"),
		autoCloseOnComplete: bool(process.env.PI_TMUX_BASH_AUTOCLOSE, true),
		maxLines: num(process.env.PI_TMUX_BASH_MAX_LINES, DEFAULT_MAX_LINES),
		maxBytes: num(process.env.PI_TMUX_BASH_MAX_BYTES, DEFAULT_MAX_BYTES),
		foregroundTimeoutMs: num(process.env.PI_TMUX_BASH_FOREGROUND_TIMEOUT, 120) * 1000,
		maxWindowNameLength: 30,
		envDenylist: DEFAULT_ENV_DENYLIST,
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

// tmux-bash 关键行为的功能测试（bun 运行）：
//   1. bash -n 语法预检：坏命令（heredoc 撇号，bash 3.2 解析器炸）被拦截、好命令放行
//   2. 前台循环窗口死亡检测：窗口未写哨兵被外部 kill 时，快速以 isError 返回
//   3. 前台输出边界标准化：CR 进度条折叠为最终行，危险 ANSI 不穿透到 TUI
//   4. 后台完成通知走 steer，自然完成会刷新 TUI 状态，且 autoClose 后 bg list 仍保留 completed + exitCode
//   5. autoClose=false 时窗口保留，且内存 job 丢失后能从 tmux 终态标签恢复 completed/exitCode
//   6. 任务窗口必须落在 options.sessionName 这个会话里（new-window 的 target 歧义回归）
//   7. 生命周期方案 A：quit → 连根拆掉整个 tmux 会话，在跑的任务进程真的死掉，runDir 全删
//   8. 生命周期方案 A：reload → 会话/窗口/.out 一律不动（热重载对后台任务透明），仅清 scriptDir
//   9. 生命周期方案 A：new/resume/fork → 只杀离任 pi 会话的窗口，不动会话与其他 pi 会话的窗口
//  10. gcStaleSessions：按 pid 存活性回收 `<prefix>-<pid>` 残留会话；活 pid / 非数字后缀 / pin 住的不动
//  11. 非交互加固 + stdin 模式：默认 stdin=/dev/null、分页器/TERM/编辑器被缴；命令自带的 VAR=x 仍能赢；
//      stdin:"tty" 下保留真 TTY 且不加固；PI_TMUX_BASH_HARDEN_ENV=0 可全关
// 用法：仓库根目录执行 `bun extensions/tmux-bash/test-fixes.ts`。
// 依赖：bun + tmux + 仓库根目录有 node_modules/@earendil-works/* 软链接（node_modules 已 gitignore）。
// pi 1.0 起是 managed install，包在带版本号的 release 目录下，**每次 pi update 后都要重链**：
//   REL=~/.pi/agent/install/releases/$(cat ~/.pi/agent/install/current-version)/node_modules
//   mkdir -p node_modules/@earendil-works node_modules/@types
//   for p in pi-coding-agent pi-tui pi-ai pi-agent-core; do
//     ln -sfn "$REL/@earendil-works/$p" "node_modules/@earendil-works/$p"
//   done
//   ln -sfn "$REL/typebox" node_modules/typebox
//   ln -sfn "$REL/@types/node" node_modules/@types/node
// 注意：测试 4〜10 用 loadOptions() 的默认会话名，而它现在是 `pi-bg-<pid>`（pid = 本 bun 进程）——
// 与你日常使用的 pi 会话天然隔离，不再互相干扰（早期共用裸 `pi-bg` 时，「单跑用例过 / 成套
// 跑失败」就是这个原因）。跑完如有残留窗口可 `tmux list-windows -a` 复查。
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { collapseCarriageReturns } from "../shared/terminal-text.ts";
import { loadOptions } from "./config.ts";
import {
	buildWrapperScript,
	checkBashSyntax,
	cleanup,
	createState,
	formatSessionEnvExports,
	gcStaleSessions,
	listJobsForSession,
	normalizeForegroundOutput,
	reconcileCompletedJobs,
	resetRunDir,
	runForegroundBash,
	runningCount,
	startBackgroundCommand,
	startWatcher,
} from "./runtime.ts";
import { listTaskWindows, killWindow, windowExists } from "./tmux.ts";

// —— tmux / 进程层的测试小工具 —— //
const tmuxQuiet = (args: string[]): boolean => {
	try {
		execFileSync("tmux", args, { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
};
const hasSession = (name: string): boolean => tmuxQuiet(["has-session", "-t", name]);
const makeSession = (name: string, windowName?: string): boolean =>
	tmuxQuiet(["new-session", "-d", "-s", name, "-c", process.cwd(), ...(windowName ? ["-n", windowName] : [])]);
const dropSession = (name: string): boolean => tmuxQuiet(["kill-session", "-t", name]);
// 窗口里 wrapper bash 的 pid；kill-window 会把整个 pane 进程组打掉，所以它消失 = 任务真的死了。
const panePid = (windowId: string): number => {
	try {
		return Number(
			execFileSync("tmux", ["display-message", "-p", "-t", windowId, "#{pane_pid}"], { encoding: "utf-8" }).trim(),
		);
	} catch {
		return NaN;
	}
};
// 等文件出现：startBackgroundCommand 建完窗口立即返回，wrapper 还要几毫秒才创建 .out。
const waitForFile = async (path: string, ms = 5000): Promise<boolean> => {
	const deadline = Date.now() + ms;
	while (!existsSync(path) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
	return existsSync(path);
};

const pidGone = (pid: number): boolean => {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return false;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "EPERM";
	}
};

let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
	console.log(`${cond ? "✅" : "❌"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!cond) failed++;
}

// 注意：heredoc 正文必须恰好**奇数个**撚号——bash 3.2 的朴素 $() 扫描器把撚号当普通引号，
// 偶数个会被它「配平」而解析成功；且用无副作用的 echo，万一跑起来也无害。
const BAD_COMMAND = `echo "$(cat <<'EOF'
this heredoc body has a don't apostrophe that breaks old bash parsers
EOF
)"`;
const GOOD_COMMAND = `echo hello && echo world`;

// —— 测试 1：checkBashSyntax —— //
const dir = mkdtempSync(join(tmpdir(), "tmux-bash-test-"));
function makeWrapper(command: string, id: string): string {
	const p = join(dir, `${id}.sh`);
	writeFileSync(
		p,
		buildWrapperScript({
			runDir: dir,
			tmuxBinary: "tmux",
			id,
			command,
			displayCommand: command.replace(/\s+/g, " ").trim(),
			envExports: "export TEST_VAR='x'",
		}),
		{ mode: 0o755 },
	);
	return p;
}

const badErr = checkBashSyntax(makeWrapper(BAD_COMMAND, "bad"), BAD_COMMAND);
check("坏命令被 bash -n 拦截", badErr !== null);
check("报错行号相对原始命令（-c 而非脚本路径）", badErr?.includes("-c") ?? false, JSON.stringify(badErr));
check("附带 bash 版本注记", badErr?.includes("[checked with") ?? false);
const goodErr = checkBashSyntax(makeWrapper(GOOD_COMMAND, "good"), GOOD_COMMAND);
check("好命令放行", goodErr === null, goodErr ?? undefined);

// —— 测试 1b：formatSessionEnvExports（对齐 0.82.0 Bash Tool Session Environment）——
{
	const full = formatSessionEnvExports({
		PI_SESSION_ID: "s1",
		PI_SESSION_FILE: "/tmp/s1.jsonl",
		PI_PROVIDER: "anthropic",
		PI_MODEL: "claude",
		PI_REASONING_LEVEL: "high",
	});
	check(
		"session env → 5 个变量全部 export",
		full.includes("export PI_SESSION_ID='s1'") &&
			full.includes("export PI_SESSION_FILE='/tmp/s1.jsonl'") &&
			full.includes("export PI_PROVIDER='anthropic'") &&
			full.includes("export PI_MODEL='claude'") &&
			full.includes("export PI_REASONING_LEVEL='high'"),
		full,
	);
	const partial = formatSessionEnvExports({ PI_SESSION_ID: "s2", PI_SESSION_FILE: undefined });
	check(
		"session env → 缺失值显式 unset（对齐 removes inherited）",
		partial.includes("export PI_SESSION_ID='s2'") && partial.includes("unset PI_SESSION_FILE"),
		partial,
	);
	check("session env → 空入参返回空串", formatSessionEnvExports(undefined) === "");
	// session env 追加在 process.env 导出之后 → 后置 export 覆盖 stale 值（顺序验证）
	const composed = ["export PI_MODEL='stale'", formatSessionEnvExports({ PI_MODEL: "fresh" })]
		.filter(Boolean)
		.join("\n");
	check("session env → 后置覆盖 stale（fresh 在 stale 之后）", composed.lastIndexOf("fresh") > composed.indexOf("stale"));
}

// —— 测试 1c：前台输出边界标准化（CR + EL + 光标移动 ANSI）—— //
{
	const progress = normalizeForegroundOutput("\x1b[31m0%\x1b[0m\r\x1b[32m100%\x1b[0m\n");
	check("前台输出 → CR 覆盖折叠为最终行", progress === "100%\n", JSON.stringify(progress));

	// docker/npm/pip 最常见的 `\r\x1b[K`（EL 擦到行尾）收缩进度条：只应保留新内容，不能残留旧尾巴
	const shrink = normalizeForegroundOutput("Downloading 45% [######    ] 12.3MB/s\r\x1b[KDone\n");
	check("前台输出 → \\r\\x1b[K 收缩进度条只留最终态", shrink === "Done\n", JSON.stringify(shrink));

	const multiShrink = normalizeForegroundOutput("\r\x1b[K  0% |          |\r\x1b[K100% |##########|\r\x1b[KOK\n");
	check("前台输出 → 多次 EL 收缩取最后一帧", multiShrink === "OK\n", JSON.stringify(multiShrink));

	const rewritten = normalizeForegroundOutput("line-a\nline-b\n\x1b[1A\x1b[2Krewritten\n");
	check(
		"前台输出 → 删除会移动光标的 ANSI（\\x1b[1A）",
		rewritten === "line-a\nline-b\nrewritten\n",
		JSON.stringify(rewritten),
	);

	// collapseCarriageReturns 单测：给 /bg 面板用的路径必须保留 SGR 颜色
	const colored = collapseCarriageReturns("\x1b[31mERR bar\x1b[0m\r\x1b[K\x1b[32mOK\x1b[0m");
	check(
		"collapse → EL 收缩后仍保留 SGR 颜色（面板路径）",
		colored.includes("OK") && !colored.includes("ERR") && colored.includes("\x1b[32m"),
		JSON.stringify(colored),
	);
	const keepTail = collapseCarriageReturns("aaaaaaaa\rbb");
	check("collapse → 纯覆盖(无 EL)保留旧尾巴", keepTail === "bbaaaaaa", JSON.stringify(keepTail));
}

// —— 测试 2/3：runForegroundBash 集成 —— //
// 用隔离 tmux session：测试 3 要按窗口名杀窗口，绝不能误伤共享 pi-bg 里真实用户的任务窗口。
const state = createState(loadOptions());
state.options.sessionName = `pi-bg-test-${Date.now()}`;
const piSession = `test-${Date.now()}`;
resetRunDir(state, piSession);

// 2a. 语法错误命令：立即 isError 返回，不建窗口
const t0 = Date.now();
const badResult = await runForegroundBash(state, { command: BAD_COMMAND, cwd: process.cwd() });
check("语法错误 → isError", badResult.isError === true);
check(
	"语法错误 → 文案对齐（exit 2 + never started）",
	badResult.content[0].text.includes("Command exited with code 2") &&
		badResult.content[0].text.includes("never started"),
	badResult.content[0].text.split("\n")[0],
);
check("语法错误 → 快速返回（<3s，未空等）", Date.now() - t0 < 3000, `${Date.now() - t0}ms`);
check("语法错误 → 未建任何窗口", listTaskWindows(state.options, piSession).length === 0);

// 2b. 正常命令仍然工作
const okResult = await runForegroundBash(state, { command: GOOD_COMMAND, cwd: process.cwd() });
check(
	"正常命令 → 输出正确且非错误",
	!okResult.isError && okResult.content[0].text.includes("hello") && okResult.content[0].text.includes("world"),
	okResult.content[0].text.replace(/\n/g, "\\n"),
);

// 3. 窗口死亡检测：sleep 长命令启动后，从外部 kill 窗口，应在 ~2s 内报错返回。
// 注意：前台窗口刻意【不打 jobId 标签】（避免被 /bg 列出/误杀正在跑的前台命令），
// listTaskWindows 找不到它——须在隔离 session 里按窗口名定位（windowNameFor("sleep 60") === "sleep"）。
const killer = setTimeout(() => {
	let target: string | undefined;
	try {
		const raw = execFileSync("tmux", ["list-windows", "-t", state.options.sessionName, "-F", "#{window_id}\t#{window_name}"], {
			encoding: "utf-8",
		});
		target = raw
			.split("\n")
			.map((line) => line.split("\t"))
			.find(([, name]) => name === "sleep")?.[0];
	} catch {
		/* session 不存在等：留 target 为空 */
	}
	console.log(`   （外部 kill 窗口：${target ?? "未找到！"}）`);
	if (target) killWindow(state.options, target);
}, 1500);
const t1 = Date.now();
const deadResult = await runForegroundBash(state, { command: "sleep 60", cwd: process.cwd() });
clearTimeout(killer);
const deadMs = Date.now() - t1;
check("窗口被外部 kill → isError", deadResult.isError === true);
check(
	"窗口被外部 kill → 状态行说明窗口消失",
	deadResult.content[0].text.includes("disappeared without recording an exit code"),
	deadResult.content[0].text.trim().split("\n").pop(),
);
check("窗口被外部 kill → 快速返回（<5s，而非空等 120s）", deadMs < 5000, `${deadMs}ms`);
check("窗口被外部 kill → details.exitCode = -1", (deadResult.details as { exitCode?: number })?.exitCode === -1);

// 4. 后台完成：通知必须进入 steer 队列；autoClose 杀掉窗口后，listJobsForSession 仍保留完成记录。
const bgState = createState(loadOptions());
bgState.options.autoCloseOnComplete = true;
const bgSession = `test-bg-${Date.now()}`;
resetRunDir(bgState, bgSession);
const sent: Array<{ message: unknown; options?: { deliverAs?: string; triggerTurn?: boolean } }> = [];
const fakePi = {
	sendMessage(message: unknown, options?: { deliverAs?: string; triggerTurn?: boolean }) {
		sent.push({ message, options });
	},
} as unknown as ExtensionAPI;
let statusRefreshes = 0;
const refreshedRunningCounts: number[] = [];
startWatcher(bgState, fakePi, () => {
	statusRefreshes++;
	refreshedRunningCounts.push(runningCount(bgState));
	throw new Error("intentional TUI refresh failure");
});
const bgStarted = startBackgroundCommand(
	bgState,
	"sleep 0.2; echo '[TMUX-BASH-STEER-TEST] done'",
	undefined,
	process.cwd(),
);
const exitPath = bgStarted.outputFile.slice(0, -4);
const waitDeadline = Date.now() + 5000;
while (!existsSync(exitPath) && sent.length === 0 && Date.now() < waitDeadline) {
	await new Promise((resolve) => setTimeout(resolve, 50));
}
// macOS 上 Bun 的 fs.watch 对外部 tmux 的原子 mv 偶尔只报告源 `.tmp`；若尚未投递，便由当前
// 进程删后重建最终哨兵，制造确定的最终文件 rename 事件，仍完整经过 startWatcher 的 40ms 路径。
if (sent.length === 0 && existsSync(exitPath)) {
	const exitCode = readFileSync(exitPath, "utf-8");
	unlinkSync(exitPath);
	writeFileSync(exitPath, exitCode);
}
const deliveryDeadline = Date.now() + 2000;
while (sent.length === 0 && Date.now() < deliveryDeadline) {
	await new Promise((resolve) => setTimeout(resolve, 25));
}
check("后台完成 → 发出通知", sent.length === 1);
check("后台完成 → deliverAs=steer", sent[0]?.options?.deliverAs === "steer", JSON.stringify(sent[0]?.options));
check("后台完成 → triggerTurn=true", sent[0]?.options?.triggerTurn === true);
check("后台完成 → 触发一次 TUI 状态刷新", statusRefreshes === 1, String(statusRefreshes));
check(
	"TUI 状态刷新 → runningCount 已降为 0",
	refreshedRunningCounts.length === 1 && refreshedRunningCounts[0] === 0,
	JSON.stringify(refreshedRunningCounts),
);
check("TUI 刷新异常 → 不阻断完成消息", sent.length === 1);
const completed = listJobsForSession(bgState).find((job) => job.windowId === bgStarted.windowId);
check("bg list → autoClose 后仍保留任务", completed !== undefined);
check("bg list → 状态为 completed", completed?.status === "completed", completed?.status);
check("bg list → 显示退出码 0", completed?.exitCode === 0, String(completed?.exitCode));
check(
	"bg list → tmux 任务窗口已自动关闭",
	!listTaskWindows(bgState.options, bgSession).some((window) => window.id === bgStarted.windowId),
);
killWindow(bgState.options, bgStarted.windowId); // 失败路径兜底，正常 autoClose 后是 no-op
cleanup(bgState, "quit");

// 5. autoClose=false：完成哨兵被删除、内存 job 历史丢失后，仍应从 tmux 终态标签恢复 completed。
const retainedState = createState(loadOptions());
retainedState.options.autoCloseOnComplete = false;
const retainedSession = `test-retained-${Date.now()}`;
resetRunDir(retainedState, retainedSession);
const retained = startBackgroundCommand(retainedState, "sleep 0.2; exit 7", undefined, process.cwd());
const retainedExitPath = retained.outputFile.slice(0, -4);
const retainedDeadline = Date.now() + 5000;
while (!existsSync(retainedExitPath) && Date.now() < retainedDeadline) {
	await new Promise((resolve) => setTimeout(resolve, 50));
}
reconcileCompletedJobs(retainedState, fakePi);
check(
	"autoClose=false → 完成后窗口保留",
	listTaskWindows(retainedState.options, retainedSession).some((window) => window.id === retained.windowId),
);
retainedState.jobs.clear(); // 模拟终态历史 prune / reload 后内存记录丢失
const recovered = listJobsForSession(retainedState).find((job) => job.windowId === retained.windowId);
check("tmux 终态标签 → 恢复 completed", recovered?.status === "completed", recovered?.status);
check("tmux 终态标签 → 恢复 exit 7", recovered?.exitCode === 7, String(recovered?.exitCode));
killWindow(retainedState.options, retained.windowId);
cleanup(retainedState, "quit");

// 6. 任务窗口必须落在 options.sessionName 这个会话里（new-window 的 target 歧义回归测试）。
//    坑：new-window 的 -t 是 target-window，不含 ':' 时 tmux 先按「当前会话里的窗口名」匹配，
//    只要存在第二个 tmux 会话、里面有个窗口名恰好等于我们的**会话名**，且它是 tmux 眼里的
//    「当前会话」，裸 `-t <name>` 就会把窗口建到那个会话里 → listTaskWindows/killWindow 全找不到，
//    后台任务变成游离窗口。修复是把 target 写成 `<session>:`。
//    这里刻意造出歧义现场：额外会话 + 其窗口名 == 本会话名 + 让它成为最近使用的会话。
//    （会话名改成 pi-bg-<pid> 后，占位窗口名 pi-bg 不再与会话名重名，故诱饵窗口名要显式用会话名。）
const targetState = createState(loadOptions());
targetState.options.autoCloseOnComplete = false;
const decoySession = `pi-bg-decoy-${Date.now()}`;
makeSession(decoySession, targetState.options.sessionName); // 建不出来就退化成普通用例
const targetSession = `test-target-${Date.now()}`;
resetRunDir(targetState, targetSession);
const targeted = startBackgroundCommand(targetState, "sleep 0.1", undefined, process.cwd());
let landedIn = "";
try {
	landedIn =
		execFileSync("tmux", ["list-windows", "-a", "-F", "#{session_name}\t#{window_id}"], {
			encoding: "utf-8",
		})
			.split("\n")
			.find((line) => line.endsWith(`\t${targeted.windowId}`))
			?.split("\t")[0] ?? "";
} catch {
	/* ignore */
}
check(
	"存在同名窗口的其他会话时 → 任务窗口仍建在目标会话",
	landedIn === targetState.options.sessionName,
	`landed in "${landedIn}", want "${targetState.options.sessionName}"`,
);
check(
	"存在同名窗口的其他会话时 → listTaskWindows 能找到该窗口",
	listTaskWindows(targetState.options, targetSession).some((window) => window.id === targeted.windowId),
);
killWindow(targetState.options, targeted.windowId);
cleanup(targetState, "quit");
dropSession(decoySession); // 诱饵会话可能从未创建

// —— 生命周期（方案 A：任务生命周期不得超过 pi 进程）—— //

// 7. quit：连根拆掉整个 tmux 会话 —— 在跑的任务**进程**也必须死，不得成为无人回收的游离窗口。
const quitState = createState(loadOptions());
quitState.options.autoCloseOnComplete = false;
resetRunDir(quitState, `test-quit-${Date.now()}`);
const quitJob = startBackgroundCommand(quitState, "sleep 300", undefined, process.cwd());
const quitPanePid = panePid(quitJob.windowId);
const quitRunDir = quitState.runDir!;
check("quit 前：会话与任务窗口均存在", hasSession(quitState.options.sessionName) && windowExists(quitState.options, quitJob.windowId));
check("quit 前：任务进程在跑", Number.isInteger(quitPanePid) && !pidGone(quitPanePid), String(quitPanePid));
cleanup(quitState, "quit");
check("quit → 整个 tmux 会话被拆除", !hasSession(quitState.options.sessionName));
check("quit → 在跑的任务窗口随之消失", !windowExists(quitState.options, quitJob.windowId));
check("quit → 任务进程真的被杀死（不是只关窗口）", pidGone(quitPanePid), String(quitPanePid));
check("quit → runDir 整个删除", !existsSync(quitRunDir));

// 8. reload：同进程同 pi 会话的热重载，对后台任务必须完全透明（只清 scriptDir）。
const reloadState = createState(loadOptions());
reloadState.options.autoCloseOnComplete = false;
resetRunDir(reloadState, `test-reload-${Date.now()}`);
const reloadJob = startBackgroundCommand(reloadState, "sleep 300", undefined, process.cwd());
const reloadPanePid = panePid(reloadJob.windowId);
const reloadScriptDir = reloadState.scriptDir!;
check("reload 前：.out 已创建", await waitForFile(reloadJob.outputFile));
cleanup(reloadState, "reload");
check("reload → tmux 会话保留", hasSession(reloadState.options.sessionName));
check("reload → 任务窗口保留", windowExists(reloadState.options, reloadJob.windowId));
check("reload → 任务进程继续跑", !pidGone(reloadPanePid), String(reloadPanePid));
check("reload → .out 保留（重载后还要继续读）", existsSync(reloadJob.outputFile));
check("reload → 仅 scriptDir 被清理", !existsSync(reloadScriptDir));
killWindow(reloadState.options, reloadJob.windowId);

// 9. new/resume/fork：只杀离任 pi 会话的窗口（按 @pi_bg_session 标签定向），
//    tmux 会话保留给下一个 pi 会话，其他 pi 会话的窗口不能被误杀。
const switchState = createState(loadOptions());
switchState.options.autoCloseOnComplete = false;
resetRunDir(switchState, `test-switch-A-${Date.now()}`);
const leavingJob = startBackgroundCommand(switchState, "sleep 300", undefined, process.cwd());
const otherState = createState(loadOptions());
otherState.options.autoCloseOnComplete = false;
resetRunDir(otherState, `test-switch-B-${Date.now()}`);
const bystanderJob = startBackgroundCommand(otherState, "sleep 300", undefined, process.cwd());
const leavingPanePid = panePid(leavingJob.windowId);
cleanup(switchState, "new");
check("new → 离任 pi 会话的任务窗口被杀", !windowExists(switchState.options, leavingJob.windowId));
check("new → 该任务进程随之死掉", pidGone(leavingPanePid), String(leavingPanePid));
check("new → tmux 会话保留（给下一个 pi 会话用）", hasSession(switchState.options.sessionName));
check("new → 其他 pi 会话的窗口不受影响", windowExists(otherState.options, bystanderJob.windowId));
cleanup(otherState, "quit");

// 10. gcStaleSessions：`kill -9`/崩溃不走 session_shutdown，残留会话靠启动时按 pid 存活性回收。
const gcPrefix = `pi-bg-gctest-${Date.now()}`;
const gcState = createState(loadOptions());
gcState.options.sessionPrefix = gcPrefix;
gcState.options.sessionName = `${gcPrefix}-${process.pid}`;
gcState.options.sessionPinned = false;
// 死 pid：让一个 bash 打印自己的 pid 并立即退出，返回时该 pid 已不存在。
const deadPid = Number(execFileSync("bash", ["-c", "echo $$"], { encoding: "utf-8" }).trim());
const deadSession = `${gcPrefix}-${deadPid}`;
const livePidSession = `${gcPrefix}-1`; // pid 1 = launchd，存活但没权限 → 走 pidAlive 的 EPERM 分支
const namedSession = `${gcPrefix}-notes`; // 非纯数字后缀 → 不属于我们的命名空间
const gcSessions = [deadSession, livePidSession, namedSession, gcState.options.sessionName];
const gcReady = gcSessions.every((name) => makeSession(name));
if (!gcReady) check("gcStaleSessions 测试环境就绪", false, "建不出测试会话");
else {
	gcState.options.sessionPinned = true;
	check("PI_TMUX_BASH_SESSION 钉死会话名 → GC 整体关闭", gcStaleSessions(gcState) === 0 && hasSession(deadSession));
	gcState.options.sessionPinned = false;
	const gcKilled = gcStaleSessions(gcState);
	check("gc → 死 pid 的残留会话被回收", !hasSession(deadSession));
	check("gc → 只杀了这一个", gcKilled === 1, String(gcKilled));
	check("gc → 活 pid（另一个 pi 实例）的会话不动", hasSession(livePidSession));
	check("gc → 非「前缀-数字」命名的会话不动", hasSession(namedSession));
	check("gc → 本进程自己的会话不动", hasSession(gcState.options.sessionName));
}
for (const name of gcSessions) dropSession(name);

// 11. 非交互 env 加固 + stdin 模式。
//     背景：wrapper 的 `| tee` 只把 stdout/stderr 变成管道，stdin 以前直接继承 tmux pane 的 PTY
//     （`[ -t 0 ]` 为真）→ `cat` 无参、REPL、`read` 这类命令会挂死等按键，而 pi 内置 bash 用
//     `stdio: ["ignore", …]` 是立即 EOF —— 属于与内置 bash 的行为偏离，此处锁住修复。
const hardenState = createState(loadOptions());
resetRunDir(hardenState, `test-harden-${Date.now()}`);
const runText = async (command: string, stdinMode?: "null" | "tty"): Promise<string> => {
	const r = await runForegroundBash(hardenState, { command, cwd: process.cwd(), timeoutSec: 15, stdinMode });
	return (r.content[0]?.text ?? "").trim();
};

const probe = 'echo "tty0=$([ -t 0 ] && echo yes || echo no) TERM=$TERM PAGER=$PAGER GIT_TERMINAL_PROMPT=$GIT_TERMINAL_PROMPT EDITOR=$EDITOR CI=$CI"';
const hardened = await runText(probe);
check("默认 → stdin 不再是 TTY（对齐内置 bash）", /tty0=no/.test(hardened), hardened);
check("默认 → TERM=dumb", /TERM=dumb/.test(hardened), hardened);
check("默认 → PAGER=cat（覆盖继承的 less）", /PAGER=cat/.test(hardened), hardened);
check("默认 → git 凭证提示关闭、EDITOR 被缴", /GIT_TERMINAL_PROMPT=0/.test(hardened) && /EDITOR=true/.test(hardened), hardened);
check("默认 → CI=true", /CI=true/.test(hardened), hardened);

// 最关键的一条：读 stdin 的命令必须立即 EOF 返回，而不是挂到超时。
const catStart = Date.now();
const catResult = await runForegroundBash(hardenState, { command: "cat", cwd: process.cwd(), timeoutSec: 10 });
const catMs = Date.now() - catStart;
check("默认 → `cat`（无参）立即 EOF 返回而非挂死", catMs < 8000 && !catResult.isError, `${catMs}ms isError=${catResult.isError}`);

// 用户意图通道：命令文本跑在加固导出之后，所以 `VAR=x cmd` 仍然赢。
const overridden = await runText('PAGER=less TERM=xterm-256color bash -c \'echo "PAGER=$PAGER TERM=$TERM"\'');
check(
	"命令自带的 VAR=x 仍能覆盖加固值",
	/PAGER=less/.test(overridden) && /TERM=xterm-256color/.test(overridden),
	overridden,
);

// stdin:"tty" → 真 TTY（保留 attach 接管能力）且不加固。
const ttyMode = await runText(probe, "tty");
check('stdin:"tty" → stdin 是真 TTY', /tty0=yes/.test(ttyMode), ttyMode);
check('stdin:"tty" → 跳过加固（TERM 不被改成 dumb）', !/TERM=dumb/.test(ttyMode), ttyMode);

// 全局开关：PI_TMUX_BASH_HARDEN_ENV=0。
const noHardenState = createState(loadOptions());
noHardenState.options.hardenEnv = false;
resetRunDir(noHardenState, `test-noharden-${Date.now()}`);
const unhardened = (
	await runForegroundBash(noHardenState, { command: probe, cwd: process.cwd(), timeoutSec: 15 })
).content[0]?.text.trim() ?? "";
check("hardenEnv=false → 不注入加固值", !/TERM=dumb/.test(unhardened) && !/PAGER=cat/.test(unhardened), unhardened);
check("hardenEnv=false → stdin 仍然是 /dev/null（两个开关相互独立）", /tty0=no/.test(unhardened), unhardened);
cleanup(noHardenState, "quit");
cleanup(hardenState, "quit");

cleanup(state, "quit");
dropSession(state.options.sessionName); // 隔离 session 可能从未创建；cleanup("quit") 已拆除时这里是 no-op

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

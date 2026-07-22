// tmux-bash 关键行为的功能测试（bun 运行）：
//   1. bash -n 语法预检：坏命令（heredoc 撇号，bash 3.2 解析器炸）被拦截、好命令放行
//   2. 前台循环窗口死亡检测：窗口未写哨兵被外部 kill 时，快速以 isError 返回
//   3. 后台完成通知走 steer，自然完成会刷新 TUI 状态，且 autoClose 后 bg list 仍保留 completed + exitCode
// 用法：仓库根目录执行 `bun extensions/tmux-bash/test-fixes.ts`。
// 依赖：bun + tmux + 仓库根目录有 node_modules/@earendil-works/{pi-coding-agent,pi-tui}
// 软链接到全局安装（node_modules 已 gitignore）：
//   mkdir -p node_modules/@earendil-works
//   ln -sfn /opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent node_modules/@earendil-works/pi-coding-agent
//   ln -sfn /opt/homebrew/lib/node_modules/@earendil-works/pi-tui         node_modules/@earendil-works/pi-tui
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadOptions } from "./config.ts";
import {
	buildWrapperScript,
	checkBashSyntax,
	cleanup,
	createState,
	listJobsForSession,
	reconcileCompletedJobs,
	resetRunDir,
	runForegroundBash,
	runningCount,
	startBackgroundCommand,
	startWatcher,
} from "./runtime.ts";
import { listTaskWindows, killWindow } from "./tmux.ts";

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

// —— 测试 2/3：runForegroundBash 集成 —— //
const state = createState(loadOptions());
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

// 3. 窗口死亡检测：sleep 长命令启动后，从外部 kill 窗口，应在 ~2s 内报错返回
const killer = setTimeout(() => {
	const wins = listTaskWindows(state.options, piSession);
	console.log(`   （外部 kill 窗口：${wins.map((w) => w.id).join(", ") || "未找到！"}）`);
	for (const w of wins) killWindow(state.options, w.id);
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
cleanup(state, "quit");

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

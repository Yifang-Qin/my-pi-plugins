// 后台任务展示用的纯格式化辅助——被模型用的 `bg` 工具（index.ts）与用户用的 `/bg`
// 交互面板（bg-panel.ts）共用，抽出到此处避免重复 / 循环 import。

// 人类可读的耗时：<60s 用 s，<1h 用 m，否则用 h。startedAt/finishedAt 均为 Date.now() 毫秒。
export function fmtDuration(startedAt: number | undefined, finishedAt?: number): string {
	if (!startedAt) return "?";
	const s = Math.max(0, Math.floor(((finishedAt ?? Date.now()) - startedAt) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	return `${Math.floor(s / 3600)}h`;
}

// 任务状态短文案（与 bg 工具 list 输出一致）。
export function fmtJobStatus(job: { status: string; exitCode?: number }): string {
	if (job.status === "completed") return `completed exit ${job.exitCode ?? "?"}`;
	if (job.status === "killed") return "killed";
	if (job.status === "missing") return "window missing";
	return "running";
}

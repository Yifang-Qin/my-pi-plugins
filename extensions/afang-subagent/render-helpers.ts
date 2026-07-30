// afang-subagent 的「无状态」纯 helper + 类型 —— index.ts 与 subagent-panel.ts 共享的单一来源。
//
// 为什么单独一个文件（关键，别合回 index.ts）：pi 的 /reload 用 cache-busting query 重新
// import 扩展入口（`index.ts?v=<时间戳>`），于是入口 index.ts 会存在「带 query 的实例 A」；
// 若面板再 `import ... from "./index.ts"`（无 query），运行时会解析出「无 query 的实例 B」，
// 两个实例各有独立的模块级状态（liveTasks/bgTasks 两份！）——工具往 A 登记、面板读 B 的空表，
// 表现为「面板永远显示没有运行中的 subagent」。
//
// 解法：面板绝不 import index.ts。
//   - 无状态的纯函数/类型放这里（本模块只被相对 import，且无可变状态，即便偶发双实例也无害）；
//   - 有状态的东西（registry 快照 / kill）由 index.ts 通过「依赖注入」把闭包传给面板
//     （见 openSubagentPanel 的 deps 参数），保证面板读到的永远是「pi 入口那个实例」的状态。

import * as os from "node:os";
import type { Message } from "@earendil-works/pi-ai";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { stripNonSgrAnsi, toSafeLines, toSingleLine } from "../shared/terminal-text.js";
import type { AgentSource } from "./agents.ts";

// 并行模式下每个子任务返回给父模型的输出上限（超出截断，完整结果仍在 tool details 里）。
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export type CompactionReason = "manual" | "threshold" | "overflow";
export type SummarizationSource = "compaction" | "branchSummary";

// 子 pi 的 AgentSession harness 生命周期事件。只保存诊断需要的小字段，不把 summary 等大内容
// 重复塞进 tool details。顺序与 child JSON 流一致，供 /subagent 轨迹和失败结果展示。
export type HarnessActivity =
	| { type: "compaction_start"; atMs: number; reason: CompactionReason }
	| {
			type: "compaction_end";
			atMs: number;
			reason: CompactionReason;
			aborted: boolean;
			willRetry: boolean;
			tokensBefore?: number;
			estimatedTokensAfter?: number;
			errorMessage?: string;
			hadResult: boolean;
		}
	| {
			type: "auto_retry_start";
			atMs: number;
			attempt?: number;
			maxAttempts?: number;
			delayMs?: number;
			errorMessage?: string;
		}
	| { type: "auto_retry_end"; atMs: number; attempt?: number; success: boolean; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			atMs: number;
			source?: SummarizationSource;
			reason?: CompactionReason;
			attempt?: number;
			maxAttempts?: number;
			delayMs?: number;
			errorMessage?: string;
		}
	| {
			type: "summarization_retry_attempt_start" | "summarization_retry_finished";
			atMs: number;
			source?: SummarizationSource;
			reason?: CompactionReason;
		};

export interface SingleResult {
	agent: string;
	agentSource: AgentSource | "unknown";
	task: string;
	exitCode: number;
	messages: Message[];
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	step?: number;
	harnessActivity?: HarnessActivity[];
}

export type BgStatus = "running" | "completed" | "failed" | "cancelled";

// 面板 / subagent_tasks 工具共用的统一任务视图（合并前台 live + 后台 bg 任务）。
export interface SubagentPanelTask {
	id: string;
	kind: "single" | "parallel" | "chain" | "background";
	agentName: string;
	agentSource: string;
	topic?: string;
	task: string;
	status: BgStatus;
	startedAtMs: number;
	result: SingleResult; // 用于轨迹渲染
	resultFile?: string; // 仅 background 完成后有
	killable: boolean;
}

export type DisplayItem =
	| { type: "text"; text: string }
	| { type: "toolCall"; name: string; args: Record<string, any> };

// —— 单行化：实现见 ../shared/terminal-text.ts —— //

// 单行化 helper 已上提到 ../shared/terminal-text.ts（与 tmux-bash 的 /bg 面板共用同一份实现），
// 这里 re-export 保持本模块对外接口不变。为什么必须单行化——见那个文件的头注释。
export { stripNonSgrAnsi, toSafeLines, toSingleLine };

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

function attemptLabel(attempt?: number, maxAttempts?: number): string {
	if (attempt === undefined) return "";
	return maxAttempts === undefined ? ` ${attempt}` : ` ${attempt}/${maxAttempts}`;
}

function retrySourceLabel(source?: SummarizationSource, reason?: CompactionReason): string {
	const scope = source === "branchSummary" ? "branch summary" : source === "compaction" ? "compaction" : "summary";
	return reason ? `${scope}/${reason}` : scope;
}

export function formatHarnessActivity(activity: HarnessActivity): string {
	switch (activity.type) {
		case "compaction_start":
			return `compact ${activity.reason} started`;
		case "compaction_end": {
			if (activity.aborted) return `compact ${activity.reason} aborted`;
			if (activity.errorMessage) return `compact ${activity.reason} failed: ${activity.errorMessage}`;
			if (!activity.hadResult) return `compact ${activity.reason} ended without result`;
			const tokenDelta =
				activity.tokensBefore !== undefined
					? ` ${formatTokens(activity.tokensBefore)}${activity.estimatedTokensAfter !== undefined ? ` → ~${formatTokens(activity.estimatedTokensAfter)}` : ""}`
					: "";
			return `compact ${activity.reason} completed${tokenDelta}${activity.willRetry ? " · retrying request" : ""}`;
		}
		case "auto_retry_start": {
			const delay = activity.delayMs !== undefined ? ` in ${(activity.delayMs / 1000).toFixed(1)}s` : "";
			const error = activity.errorMessage ? `: ${activity.errorMessage}` : "";
			return `agent retry${attemptLabel(activity.attempt, activity.maxAttempts)} scheduled${delay}${error}`;
		}
		case "auto_retry_end":
			return activity.success
				? `agent retry${attemptLabel(activity.attempt)} succeeded`
				: `agent retry${attemptLabel(activity.attempt)} failed${activity.finalError ? `: ${activity.finalError}` : ""}`;
		case "summarization_retry_scheduled": {
			const delay = activity.delayMs !== undefined ? ` in ${(activity.delayMs / 1000).toFixed(1)}s` : "";
			const error = activity.errorMessage ? `: ${activity.errorMessage}` : "";
			return `${retrySourceLabel(activity.source, activity.reason)} retry${attemptLabel(activity.attempt, activity.maxAttempts)} scheduled${delay}${error}`;
		}
		case "summarization_retry_attempt_start":
			return `${retrySourceLabel(activity.source, activity.reason)} retry started`;
		case "summarization_retry_finished":
			return `${retrySourceLabel(activity.source, activity.reason)} retry finished`;
	}
}

export function formatHarnessStats(result: SingleResult): string {
	const events = result.harnessActivity ?? [];
	const compactionEnds = events.filter((event) => event.type === "compaction_end");
	const compactions = compactionEnds.filter((event) => event.hadResult && !event.aborted && !event.errorMessage).length;
	const compactionFailures = compactionEnds.filter(
		(event) => !event.aborted && (Boolean(event.errorMessage) || !event.hadResult),
	).length;
	const compactionAborts = compactionEnds.filter((event) => event.aborted).length;
	const agentRetries = events.filter((event) => event.type === "auto_retry_start").length;
	const summaryRetries = events.filter((event) => event.type === "summarization_retry_scheduled").length;
	return [
		compactions > 0 ? `cmp:${compactions}` : "",
		compactionFailures > 0 ? `cmp-fail:${compactionFailures}` : "",
		compactionAborts > 0 ? `cmp-abort:${compactionAborts}` : "",
		agentRetries > 0 ? `retry:${agentRetries}` : "",
		summaryRetries > 0 ? `sum-retry:${summaryRetries}` : "",
	]
		.filter(Boolean)
		.join(" ");
}

export function getHarnessFailureLines(result: SingleResult): string[] {
	const lines: string[] = [];
	for (const event of result.harnessActivity ?? []) {
		if (
			(event.type === "compaction_end" && (event.aborted || event.errorMessage || !event.hadResult)) ||
			(event.type === "auto_retry_end" && !event.success)
		) {
			lines.push(formatHarnessActivity(event));
		}
	}
	return lines;
}

export function formatUsageStats(
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
		contextTokens?: number;
		turns?: number;
	},
	model?: string,
): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

// 工具调用预览里「参数部分」的默认可见宽度上限（聊天里的历史行为；面板会按 overlay 实宽覆盖）。
export const DEFAULT_TOOL_ARG_WIDTH = 60;

// 对外入口：结果一律单行化（bash 的 heredoc / grep 的多行 pattern 等都可能带真换行）。
// maxWidth = 参数预览允许的可见列宽（不是字符数），调用方按自己的容器宽度传，实现自适应截断。
export function formatToolCall(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	maxWidth: number = DEFAULT_TOOL_ARG_WIDTH,
): string {
	return toSingleLine(formatToolCallInner(toolName, args, themeFg, Math.max(12, Math.floor(maxWidth))));
}

function formatToolCallInner(
	toolName: string,
	args: Record<string, unknown>,
	themeFg: (color: any, text: string) => string,
	maxWidth: number,
): string {
	const shortenPath = (p: string) => {
		const home = os.homedir();
		return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
	};

	switch (toolName) {
		case "bash": {
			// 先单行化再按可见列宽截断：否则窗口里可能落进多个换行（宽度算 0），预览行会撑破面板。
			const command = toSingleLine((args.command as string) || "...");
			const preview = truncateToWidth(command, maxWidth, "…");
			return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = themeFg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += themeFg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return themeFg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = themeFg("muted", "write ") + themeFg("accent", filePath);
			if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return themeFg("muted", "find ") + themeFg("accent", pattern) + themeFg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return (
				themeFg("muted", "grep ") +
				themeFg("accent", `/${pattern}/`) +
				themeFg("dim", ` in ${shortenPath(rawPath)}`)
			);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = truncateToWidth(argsStr, Math.max(12, maxWidth - 10), "…");
			return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
		}
	}
}

export function getFinalOutput(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") return part.text;
			}
		}
	}
	return "";
}

export function isFailedResult(result: SingleResult): boolean {
	return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

export function getResultOutput(result: SingleResult): string {
	const base = isFailedResult(result)
		? result.errorMessage || result.stderr || getFinalOutput(result.messages) || "(no output)"
		: getFinalOutput(result.messages) || "(no output)";
	if (!isFailedResult(result)) return base;
	const harnessFailures = getHarnessFailureLines(result).filter((line) => !base.includes(line));
	return harnessFailures.length > 0 ? `${base}\n\nHarness: ${harnessFailures.join("; ")}` : base;
}

export function truncateParallelOutput(output: string): string {
	const byteLength = Buffer.byteLength(output, "utf8");
	if (byteLength <= PER_TASK_OUTPUT_CAP) return output;

	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${byteLength - Buffer.byteLength(truncated, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

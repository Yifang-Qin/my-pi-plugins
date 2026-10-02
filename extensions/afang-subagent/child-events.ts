import type { Message } from "@earendil-works/pi-ai";
import type {
	CompactionReason,
	HarnessActivity,
	SingleResult,
	SummarizationSource,
} from "./render-helpers.ts";

function record(result: SingleResult, activity: HarnessActivity): void {
	(result.harnessActivity ??= []).push(activity);
}

function numeric(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function compactionReason(value: unknown): CompactionReason | undefined {
	return value === "manual" || value === "threshold" || value === "overflow" ? value : undefined;
}

function summarizationSource(value: unknown): SummarizationSource | undefined {
	return value === "compaction" || value === "branchSummary" ? value : undefined;
}

/**
 * Apply one NDJSON event emitted by the child pi harness to the live result.
 * Returns true when the event changed model-visible/UI-visible task state.
 */
export function processChildEvent(result: SingleResult, event: any): boolean {
	if (!event || typeof event !== "object") return false;

	if (event.type === "message_end" && event.message) {
		// pi 0.86+ 的 transcript 以一条 role:"system" 消息开头（完整 system prompt sections，数 KB），
		// 之后 prompt/工具变更还会追加 system 补丁，它们都会经 JSON 流以 message_end 发出。
		// 这些对父侧渲染/汇报无用，若进 result.messages 会随 tool 结果 details 每次落盘，直接丢弃。
		if ((event.message as { role?: unknown }).role === "system") return false;
		const msg = event.message as Message;
		result.messages.push(msg);

		if (msg.role === "assistant") {
			result.usage.turns++;
			const usage = msg.usage;
			if (usage) {
				result.usage.input += usage.input || 0;
				result.usage.output += usage.output || 0;
				result.usage.cacheRead += usage.cacheRead || 0;
				result.usage.cacheWrite += usage.cacheWrite || 0;
				result.usage.cost += usage.cost?.total || 0;
				result.usage.contextTokens = usage.totalTokens || 0;
			}
			if (!result.model && msg.model) result.model = msg.model;
			if (msg.stopReason) result.stopReason = msg.stopReason;
			// A recovered retry/compaction emits a later successful assistant message. Mirror the latest
			// message exactly so an earlier transient error does not leak into a completed result/report.
			result.errorMessage = msg.errorMessage || undefined;
		}
		return true;
	}

	if (event.type === "tool_result_end" && event.message) {
		// Compatibility with older child event streams. pi 0.83 normally emits tool results through
		// message_end with role=toolResult, which is already handled above.
		result.messages.push(event.message as Message);
		return true;
	}

	const atMs = Date.now();
	switch (event.type) {
		case "compaction_start": {
			const reason = compactionReason(event.reason);
			if (!reason) return false;
			record(result, {
				type: "compaction_start",
				atMs,
				reason,
			});
			return true;
		}
		case "compaction_end": {
			const reason = compactionReason(event.reason);
			if (!reason) return false;
			record(result, {
				type: "compaction_end",
				atMs,
				reason,
				aborted: event.aborted === true,
				willRetry: event.willRetry === true,
				tokensBefore: numeric(event.result?.tokensBefore),
				estimatedTokensAfter: numeric(event.result?.estimatedTokensAfter),
				errorMessage: text(event.errorMessage),
				hadResult: event.result != null,
			});
			return true;
		}
		case "auto_retry_start":
			record(result, {
				type: "auto_retry_start",
				atMs,
				attempt: numeric(event.attempt),
				maxAttempts: numeric(event.maxAttempts),
				delayMs: numeric(event.delayMs),
				errorMessage: text(event.errorMessage),
			});
			return true;
		case "auto_retry_end":
			record(result, {
				type: "auto_retry_end",
				atMs,
				attempt: numeric(event.attempt),
				success: event.success === true,
				finalError: text(event.finalError),
			});
			return true;
		case "summarization_retry_scheduled":
			record(result, {
				type: "summarization_retry_scheduled",
				atMs,
				source: summarizationSource(event.source),
				reason: compactionReason(event.reason),
				attempt: numeric(event.attempt),
				maxAttempts: numeric(event.maxAttempts),
				delayMs: numeric(event.delayMs),
				errorMessage: text(event.errorMessage),
			});
			return true;
		case "summarization_retry_attempt_start":
			record(result, {
				type: "summarization_retry_attempt_start",
				atMs,
				source: summarizationSource(event.source),
				reason: compactionReason(event.reason),
			});
			return true;
		case "summarization_retry_finished":
			record(result, {
				type: "summarization_retry_finished",
				atMs,
				source: summarizationSource(event.source),
				reason: compactionReason(event.reason),
			});
			return true;
		default:
			return false;
	}
}

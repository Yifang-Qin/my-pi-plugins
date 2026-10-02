// Focused regression checks for child pi JSON event ingestion.
// Run: bun extensions/afang-subagent/test-child-events.ts

import { processChildEvent } from "./child-events.ts";
import {
	formatHarnessActivity,
	formatHarnessStats,
	getResultOutput,
	stripNonSgrAnsi,
	type SingleResult,
} from "./render-helpers.ts";

function makeResult(): SingleResult {
	return {
		agent: "worker",
		agentSource: "builtin",
		task: "test",
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	};
}

function check(name: string, condition: boolean): void {
	if (!condition) throw new Error(`FAIL: ${name}`);
	console.log(`PASS: ${name}`);
}

const result = makeResult();
check(
	"assistant message is ingested",
	processChildEvent(result, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [],
			provider: "test",
			model: "model",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 20,
				cacheWrite: 0,
				totalTokens: 32,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: "context overflow",
			timestamp: Date.now(),
		},
	}),
);
check("assistant error fields propagate", result.stopReason === "error" && result.errorMessage === "context overflow");
check("assistant usage accumulates", result.usage.turns === 1 && result.usage.contextTokens === 32);

const toolResultCarrier = makeResult();
processChildEvent(toolResultCarrier, {
	type: "message_end",
	message: {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "ok" }],
		isError: false,
		timestamp: Date.now(),
	},
});
check(
	"pi 0.83 tool results are ingested through message_end",
	toolResultCarrier.messages.length === 1 && toolResultCarrier.messages[0]?.role === "toolResult",
);

processChildEvent(result, { type: "compaction_start", reason: "overflow" });
processChildEvent(result, {
	type: "compaction_end",
	reason: "overflow",
	aborted: false,
	willRetry: true,
	result: { tokensBefore: 371_295, estimatedTokensAfter: 31_000 },
});
processChildEvent(result, {
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 2000,
	errorMessage: "temporarily unavailable",
});
processChildEvent(result, { type: "auto_retry_end", success: true, attempt: 1 });
processChildEvent(result, {
	type: "summarization_retry_scheduled",
	attempt: 1,
	maxAttempts: 3,
	delayMs: 2000,
	errorMessage: "stream reset",
});
processChildEvent(result, {
	type: "summarization_retry_attempt_start",
	source: "compaction",
	reason: "overflow",
});
processChildEvent(result, { type: "summarization_retry_finished" });

check("all harness events are retained", result.harnessActivity?.length === 7);
check("harness stats count completed actions", formatHarnessStats(result) === "cmp:1 retry:1 sum-retry:1");
const compactEnd = result.harnessActivity?.[1];
check(
	"compaction details are formatted",
	compactEnd !== undefined &&
		formatHarnessActivity(compactEnd).includes("371k → ~31k") &&
		formatHarnessActivity(compactEnd).includes("retrying request"),
);

processChildEvent(result, {
	type: "message_end",
	message: {
		role: "assistant",
		content: [{ type: "text", text: "recovered" }],
		provider: "test",
		model: "model",
		usage: {
			input: 12,
			output: 1,
			cacheRead: 4,
			cacheWrite: 0,
			totalTokens: 17,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	},
});
check("successful retry clears stale assistant error", result.stopReason === "stop" && result.errorMessage === undefined);

const failed = makeResult();
failed.stopReason = "error";
failed.errorMessage = "context overflow";
processChildEvent(failed, { type: "compaction_start", reason: "overflow" });
processChildEvent(failed, {
	type: "compaction_end",
	reason: "overflow",
	aborted: false,
	willRetry: false,
	result: null,
	errorMessage: "summary request failed",
});
processChildEvent(failed, {
	type: "auto_retry_end",
	attempt: 3,
	success: false,
	finalError: "retry budget exhausted",
});
const failureOutput = getResultOutput(failed);
check("failed compaction is counted in compact stats", formatHarnessStats(failed) === "cmp-fail:1");
check(
	"compaction and retry failures reach model-visible failure output",
	failureOutput.includes("Harness: compact overflow failed") && failureOutput.includes("agent retry 3 failed"),
);
const unsafeActivity = failed.harnessActivity?.at(-1);
check(
	"renderer boundary strips cursor-moving ANSI from harness errors",
	unsafeActivity !== undefined && !stripNonSgrAnsi(`${formatHarnessActivity(unsafeActivity)}\x1b[1A`).includes("\x1b[1A"),
);

const successfulDespiteThresholdFailure = makeResult();
successfulDespiteThresholdFailure.stopReason = "stop";
processChildEvent(successfulDespiteThresholdFailure, {
	type: "compaction_end",
	reason: "threshold",
	aborted: false,
	willRetry: false,
	result: null,
	errorMessage: "summary request failed",
});
check(
	"failed threshold compaction stays observable without flipping task success",
	formatHarnessStats(successfulDespiteThresholdFailure) === "cmp-fail:1" &&
		getResultOutput(successfulDespiteThresholdFailure) === "(no output)",
);

check("unknown JSON events are ignored", processChildEvent(result, { type: "unknown" }) === false);

const systemCarrier = makeResult();
check(
	"child system prompt messages (pi 0.86+) are not ingested",
	processChildEvent(systemCarrier, {
		type: "message_end",
		message: { role: "system", content: "", sections: { preamble: "You are..." }, timestamp: Date.now() },
	}) === false && systemCarrier.messages.length === 0,
);

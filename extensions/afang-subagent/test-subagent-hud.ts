// Rendering checks for the always-visible subagent HUD (pure functions only; no TUI needed).
// Run: bun extensions/afang-subagent/test-subagent-hud.ts

import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { SingleResult, SubagentPanelTask } from "./render-helpers.ts";
import {
	formatHudElapsed,
	HUD_COLLAPSED_LIMIT,
	hudStatusText,
	parseHudMode,
	renderHudLines,
} from "./subagent-hud.ts";

function check(name: string, condition: boolean): void {
	if (!condition) throw new Error(`FAIL: ${name}`);
	console.log(`PASS: ${name}`);
}

// Plain theme: no colors, so assertions can match text directly.
const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t } as unknown as Theme;

const NOW = 1_000_000;

function result(messages: SingleResult["messages"] = []): SingleResult {
	return {
		agent: "scout",
		agentSource: "builtin",
		task: "t",
		exitCode: 0,
		messages,
		stderr: "",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		running: true,
	};
}

function task(id: string, over: Partial<SubagentPanelTask> = {}): SubagentPanelTask {
	return {
		id,
		kind: "parallel",
		step: 1,
		agentName: "scout",
		agentSource: "builtin",
		task: "t",
		status: "running",
		startedAtMs: NOW - 72_000,
		result: result(),
		killable: true,
		...over,
	};
}

const toolCallMsg = {
	role: "assistant",
	content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm test\nnpm run lint" } }],
	timestamp: NOW,
} as unknown as SingleResult["messages"][number];

check("parseHudMode defaults to collapsed", parseHudMode(undefined) === "collapsed" && parseHudMode("bogus") === "collapsed");
check("parseHudMode accepts full/off", parseHudMode(" FULL ") === "full" && parseHudMode("off") === "off");
check("elapsed formatting", formatHudElapsed(5_400) === "5s" && formatHudElapsed(72_000) === "1m12s" && formatHudElapsed(3_720_000) === "1h02m");

check("no running tasks -> no status and no HUD lines", hudStatusText([task("a", { status: "completed" })]) === undefined
	&& renderHudLines([task("a", { status: "completed" })], theme, 80, "collapsed", NOW).length === 0);
check(
	"status counts background tasks separately",
	hudStatusText([task("a"), task("b", { kind: "background", step: undefined })]) === "sa: 2 running (1 bg)",
);

const one = renderHudLines([task("task-1", { result: result([toolCallMsg]) })], theme, 120, "collapsed", NOW);
check("HUD header + one row + spacer", one.length === 3 && one[0].includes("Subagents") && one[0].includes("1 running"));
check("row shows agent, id, kind, elapsed", one[1].includes("scout") && one[1].includes("task-1") && one[1].includes("parallel #1") && one[1].includes("1m12s"));
check("row shows latest tool call on a single line", one[1].includes("→") && one[1].includes("npm test") && !one[1].includes("\n"));
check("fresh task shows starting placeholder", renderHudLines([task("x")], theme, 120, "collapsed", NOW)[1].includes("starting…"));

const many = Array.from({ length: 5 }, (_, i) => task(`task-${i + 1}`, { step: i + 1, startedAtMs: NOW - 1000 * (10 - i) }));
const collapsed = renderHudLines(many, theme, 100, "collapsed", NOW);
check(
	"collapsed HUD caps rows and shows +N more",
	collapsed.length === 1 + HUD_COLLAPSED_LIMIT + 1 + 1 && collapsed.some((l) => l.includes(`+${5 - HUD_COLLAPSED_LIMIT} more`)),
);
check("full HUD lists every task", renderHudLines(many, theme, 100, "full", NOW).length === 1 + 5 + 1);
check("off HUD renders nothing", renderHudLines(many, theme, 100, "off", NOW).length === 0);

const narrow = renderHudLines([task("task-1", { result: result([toolCallMsg]), topic: "a very long topic label" })], theme, 30, "collapsed", NOW);
check("every line fits the width", narrow.every((l) => visibleWidth(l) <= 30 && !/[\r\n]/.test(l)));

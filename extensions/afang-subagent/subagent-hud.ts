// Always-visible "what is running" surfaces for afang-subagent:
//
//   1. a footer status entry (`sa: 3 running (1 bg)`), and
//   2. a pinned "Subagents" block above the editor listing every running task — foreground
//      single/parallel/chain children and detached background tasks alike — with elapsed time
//      and the child's latest activity.
//
// Both are cleared automatically once nothing is running. The interactive `/sa` panel stays the
// place to inspect traces and kill tasks; this module is display-only.
//
// State access goes through injected deps (never import index.ts from here: `/reload` re-imports
// the entry with a cache-busting query, so a static import would see a second, empty registry).
//
// Layout follows the todo widget: installed once with `setWidget` and rendered as zero lines when
// idle, because re-calling `setWidget` with the same key moves the widget to the end of the
// above-editor stack (its position relative to other widgets would jump around).

import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	formatToolCall,
	getDisplayItems,
	type SubagentPanelTask,
	stripNonSgrAnsi,
	toSingleLine,
} from "./render-helpers.ts";

export type HudMode = "collapsed" | "full" | "off";

export interface SubagentHudDeps {
	snapshot: () => SubagentPanelTask[];
}

/** Task rows a collapsed HUD shows before the "+N more" row. */
export const HUD_COLLAPSED_LIMIT = 3;
/** Repaint cadence while something runs (elapsed time and latest activity advance). */
const HUD_TICK_MS = 1000;
const HUD_KEY = "afang-subagent";

/** `PI_SUBAGENT_HUD=collapsed|full|off`; anything else falls back to `collapsed`. */
export function parseHudMode(raw: string | undefined): HudMode {
	const v = raw?.trim().toLowerCase();
	return v === "full" || v === "off" ? v : "collapsed";
}

export function formatHudElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function runningTasks(tasks: SubagentPanelTask[]): SubagentPanelTask[] {
	return tasks.filter((t) => t.status === "running").sort((a, b) => a.startedAtMs - b.startedAtMs);
}

/** Footer status text; undefined (= cleared) when nothing runs. */
export function hudStatusText(tasks: SubagentPanelTask[]): string | undefined {
	const running = runningTasks(tasks);
	if (running.length === 0) return undefined;
	const bg = running.filter((t) => t.kind === "background").length;
	return `sa: ${running.length} running${bg > 0 ? ` (${bg} bg)` : ""}`;
}

function kindLabel(t: SubagentPanelTask): string {
	switch (t.kind) {
		case "background":
			return "bg";
		case "parallel":
			return t.step ? `parallel #${t.step}` : "parallel";
		case "chain":
			return t.step ? `chain step ${t.step}` : "chain";
		default:
			return "single";
	}
}

/** The child's latest activity: its most recent tool call, else its latest text, else "starting…". */
function latestActivity(t: SubagentPanelTask, theme: Theme, width: number): string {
	const items = getDisplayItems(t.result.messages);
	const last = items[items.length - 1];
	if (!last) return theme.fg("dim", "starting…");
	if (last.type === "toolCall") {
		return theme.fg("muted", "→ ") + formatToolCall(last.name, last.args, theme.fg.bind(theme), Math.max(12, width - 2));
	}
	return theme.fg("dim", toSingleLine(stripNonSgrAnsi(last.text)).trim());
}

/**
 * Lines for the pinned HUD. Every returned string is exactly one physical row (single-lined and
 * truncated to `width`), and the array is empty when nothing runs so the block disappears.
 */
export function renderHudLines(
	tasks: SubagentPanelTask[],
	theme: Theme,
	width: number,
	mode: HudMode,
	now: number = Date.now(),
): string[] {
	if (mode === "off") return [];
	const running = runningTasks(tasks);
	if (running.length === 0) return [];

	const shown = mode === "full" || running.length <= HUD_COLLAPSED_LIMIT ? running : running.slice(0, HUD_COLLAPSED_LIMIT);
	const hidden = running.length - shown.length;
	const bg = running.filter((t) => t.kind === "background").length;

	const lines: string[] = [];
	lines.push(
		` ${theme.fg("accent", theme.bold("Subagents"))} ` +
			theme.fg("muted", `${running.length} running${bg > 0 ? ` (${bg} bg)` : ""}`) +
			theme.fg("dim", " · /sa to inspect or kill"),
	);
	shown.forEach((t, i) => {
		const isLast = i === shown.length - 1 && hidden === 0;
		const connector = theme.fg("dim", isLast ? "└─" : "├─");
		const topic = t.topic ? theme.fg("muted", ` “${toSingleLine(t.topic)}”`) : "";
		const head =
			`  ${connector} ${theme.fg("warning", "⏳")} ${theme.fg("accent", t.agentName)}${topic} ` +
			theme.fg("dim", `${t.id} · ${kindLabel(t)} · `) +
			theme.fg("muted", formatHudElapsed(now - t.startedAtMs)) +
			theme.fg("dim", " · ");
		const budget = width - visibleWidth(head);
		const activity = budget >= 8 ? latestActivity(t, theme, budget) : "";
		lines.push(head + activity);
	});
	if (hidden > 0) {
		lines.push(`  ${theme.fg("dim", "└─")} ${theme.fg("muted", `… +${hidden} more`)}`);
	}
	lines.push("");
	return lines.map((l) => truncateToWidth(toSingleLine(l), width, ""));
}

/**
 * Owns the footer status and the pinned widget. `changed()` is cheap and idempotent: call it on
 * every registry lifecycle event (start / finish / kill). While anything runs it also re-arms a 1s
 * ticker so elapsed time and the latest activity keep moving between lifecycle events.
 */
export class SubagentHud {
	private ui: ExtensionContext["ui"] | undefined;
	private tui: { requestRender(): void } | undefined;
	private widgetInstalled = false;
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastStatus: string | undefined;

	constructor(
		private readonly deps: SubagentHudDeps,
		private readonly mode: HudMode,
	) {}

	attach(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		this.ui = ctx.ui;
		this.lastStatus = undefined;
		if (ctx.mode === "tui" && this.mode !== "off" && !this.widgetInstalled) {
			this.widgetInstalled = true;
			ctx.ui.setWidget(
				HUD_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => renderHudLines(this.deps.snapshot(), theme, width, this.mode),
						invalidate: () => {},
						dispose: () => {
							this.tui = undefined;
							this.widgetInstalled = false;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
		}
		this.changed();
	}

	changed(): void {
		// Detached (session shutting down / no UI): no status, no ticker.
		if (!this.ui) return;
		const tasks = this.deps.snapshot();
		const status = hudStatusText(tasks);
		if (status !== this.lastStatus) {
			this.ui.setStatus(HUD_KEY, status);
			this.lastStatus = status;
		}
		const anyRunning = status !== undefined;
		if (anyRunning && !this.timer) {
			this.timer = setInterval(() => this.changed(), HUD_TICK_MS);
			this.timer.unref?.();
		} else if (!anyRunning && this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		this.tui?.requestRender();
	}

	detach(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		if (this.ui) {
			this.ui.setStatus(HUD_KEY, undefined);
			if (this.widgetInstalled) this.ui.setWidget(HUD_KEY, undefined);
		}
		this.ui = undefined;
		this.tui = undefined;
		this.widgetInstalled = false;
		this.lastStatus = undefined;
	}
}

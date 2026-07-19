// tree-nav — a lazygit-style, user-node-first session tree navigator for pi.
//
// Multi-file extension: pi loads this index.ts as one extension (jiti resolves
// the relative ./*.js imports at runtime), so no bundling is needed.
//
// Trigger: the `/nav` command (we intentionally do NOT try to override the
// built-in `/tree` — pi filters extension commands that collide with built-in
// names, so a new name is required anyway).
//
// Flow:
//   1. Read the session tree + current leaf.
//   2. Build a user-centric model (session-tree.ts) and show a large overlay
//      (nav-overlay.ts) with the current turn preselected.
//   3. On select, optionally ask whether to summarize the abandoned branch, then
//      call ctx.navigateTree(id, { summarize, customInstructions }). pi's wrapper
//      refreshes the transcript and, for a user-turn target, restores its prompt
//      into an empty editor for us.

import { collectEntriesForBranchSummary, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NavOverlay } from "./nav-overlay.js";
import { buildNavModel } from "./session-tree.js";

interface SummarizeDecision {
	cancelled?: boolean;
	summarize: boolean;
	customInstructions?: string;
}

// Ask whether to summarize the branch we're leaving behind. Skips the prompt
// entirely when there is nothing to summarize (smarter than the built-in, which
// always asks). Returns { cancelled } if the user backs out of the flow.
async function promptSummarize(ctx: ExtensionContext, leafId: string | null, targetId: string): Promise<SummarizeDecision> {
	const { entries } = collectEntriesForBranchSummary(ctx.sessionManager, leafId, targetId);
	if (entries.length === 0) return { summarize: false };

	const NO = "No summary";
	const YES = "Summarize";
	const CUSTOM = "Summarize with custom prompt";
	const choice = await ctx.ui.select(`Summarize abandoned branch? (${entries.length} entries)`, [NO, YES, CUSTOM]);
	if (choice === undefined) return { cancelled: true }; // esc backs out of navigation
	if (choice === NO) return { summarize: false };

	if (!ctx.model) {
		ctx.ui.notify("tree-nav: no model available for summarization", "warning");
		return { summarize: false };
	}
	if (choice === CUSTOM) {
		const custom = await ctx.ui.editor("Custom summarization instructions");
		if (custom === undefined) return { cancelled: true };
		return { summarize: true, customInstructions: custom.trim() || undefined };
	}
	return { summarize: true };
}

async function openNav(ctx: ExtensionContext): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/nav needs the interactive TUI", "warning");
		return;
	}

	const roots = ctx.sessionManager.getTree();
	if (roots.length === 0) {
		ctx.ui.notify("tree-nav: no entries in this session", "warning");
		return;
	}

	const leafId = ctx.sessionManager.getLeafId();
	// Default view hides "empty draft" turns (abandoned prompts whose subtree has no
	// assistant/tool/summary); the full view (tab in the overlay) shows everything.
	const model = buildNavModel(roots, leafId, true);
	const fullModel = buildNavModel(roots, leafId, false);
	if (fullModel.users.length === 0) {
		ctx.ui.notify("tree-nav: no user turns to navigate", "warning");
		return;
	}
	// If hiding drafts leaves nothing (e.g. leaf reset to root with only abandoned
	// drafts), open in show-all so there is still something to navigate.
	const startShowAll = model.users.length === 0;

	const targetId = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) =>
			new NavOverlay({
				tui,
				theme,
				model,
				fullModel,
				startShowAll,
				onSelect: (id) => done(id),
				onCancel: () => done(null),
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", minWidth: 60, margin: 1 },
		},
	);

	if (!targetId || targetId === leafId) return;

	// Ask about summarizing the abandoned branch (esc = back out of navigation).
	const decision = await promptSummarize(ctx, leafId, targetId);
	if (decision.cancelled) {
		ctx.ui.notify("tree-nav: navigation cancelled", "info");
		return;
	}

	// The extension wrapper for navigateTree runs the summarizer inline with no
	// loader of its own, so surface a status while it works. Note: the summary
	// LLM call cannot be aborted from an extension (abortBranchSummary is not
	// exposed), so this status is intentionally non-cancellable.
	if (decision.summarize) ctx.ui.setStatus("tree-nav", "summarizing abandoned branch…");
	try {
		const result = await ctx.navigateTree(targetId, {
			summarize: decision.summarize,
			customInstructions: decision.customInstructions,
		});
		if (result.cancelled) {
			ctx.ui.notify("tree-nav: navigation cancelled", "info");
			return;
		}
		// pi's navigateTree wrapper already refreshes the transcript and, for a
		// user-turn target, restores its prompt into an empty editor — nothing to do.
		ctx.ui.notify(decision.summarize ? "tree-nav: navigated (branch summarized)" : "tree-nav: navigated", "info");
	} catch (err) {
		ctx.ui.notify(`tree-nav: ${err instanceof Error ? err.message : String(err)}`, "error");
	} finally {
		ctx.ui.setStatus("tree-nav", undefined);
	}
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("nav", {
		description: "Navigate the session tree by user turns (lazygit-style overlay)",
		handler: async (_args, ctx) => {
			await openNav(ctx);
		},
	});
}

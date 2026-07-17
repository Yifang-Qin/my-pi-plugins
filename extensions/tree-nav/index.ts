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
//   3. On select, call ctx.navigateTree(id, { summarize: false }). If the target
//      is a user turn, navigateTree returns its text as editorText (a rewind);
//      we restore it into the editor when the editor is empty.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { NavOverlay } from "./nav-overlay.js";
import { buildNavModel } from "./session-tree.js";

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
	const model = buildNavModel(roots, leafId);
	if (model.users.length === 0) {
		ctx.ui.notify("tree-nav: no user turns to navigate", "warning");
		return;
	}

	const targetId = await ctx.ui.custom<string | null>(
		(tui, theme, _kb, done) =>
			new NavOverlay({
				tui,
				theme,
				model,
				onSelect: (id) => done(id),
				onCancel: () => done(null),
			}),
		{
			overlay: true,
			overlayOptions: { anchor: "center", width: "90%", maxHeight: "90%", minWidth: 60, margin: 1 },
		},
	);

	if (!targetId || targetId === leafId) return;

	// TODO(stage-2): mirror the built-in "Summarize branch?" prompt flow here.
	const result = await ctx.navigateTree(targetId, { summarize: false });
	if (result.cancelled) {
		ctx.ui.notify("tree-nav: navigation cancelled", "info");
		return;
	}
	// A user-turn target rewinds and returns its prompt; restore it for editing.
	if (result.editorText) ctx.ui.setEditorText(result.editorText);
	ctx.ui.notify("tree-nav: navigated", "info");
}

export default function (pi: ExtensionAPI): void {
	pi.registerCommand("nav", {
		description: "Navigate the session tree by user turns (lazygit-style overlay)",
		handler: async (_args, ctx) => {
			await openNav(ctx);
		},
	});
}

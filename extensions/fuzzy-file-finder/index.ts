// fuzzy-file-finder — a codex/telescope-style file picker for pi.
//
// Multi-file extension: pi loads this index.ts as one extension (jiti resolves
// the relative ./*.js imports at runtime), so no bundling or submodule is needed.
//
// Triggered by the `/find-file` command:
//   - empty query shows a collapsible directory tree (tree.ts); →/← expand or
//     collapse, enter toggles dirs / selects files, tab picks the current node
//     (directories insert as `@dir/`, files as `@path `).
//   - typing switches to a flat subsequence-fuzzy list across all files.
// The chosen path is inserted into the editor as an `@`-mention.
//
// Note: intercepting a literal "@" keystroke to auto-open this overlay was
// prototyped (via a CustomEditor + setEditorComponent) but dropped — it relies
// on session_start re-installing the editor on /reload, which proved unreliable.
// The command trigger is the supported path.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadFiles } from "./files.js";
import { FinderOverlay } from "./finder-overlay.js";

const CACHE_TTL_MS = 5_000;

export default function (pi: ExtensionAPI): void {
	// Per-cwd file-list cache so repeat opens are instant.
	const cache = new Map<string, { files: string[]; at: number }>();
	let inflight: Promise<string[]> | null = null;

	const getFiles = async (cwd: string): Promise<string[]> => {
		const hit = cache.get(cwd);
		if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;
		if (inflight) return inflight;
		inflight = loadFiles(pi, cwd, new AbortController().signal)
			.then((files) => {
				cache.set(cwd, { files, at: Date.now() });
				inflight = null;
				return files;
			})
			.catch(() => {
				inflight = null;
				return hit?.files ?? [];
			});
		return inflight;
	};

	// Show the overlay for a known file list; resolves to the mention string to
	// insert (`@path ` for files, `@dir/` for directories) or null if cancelled.
	const showFinder = (ctx: ExtensionContext, files: string[]): Promise<string | null> =>
		ctx.ui.custom<string | null>(
			(tui, theme, _kb, done) =>
				new FinderOverlay({
					tui,
					theme,
					files,
					maxVisible: 20,
					onSelect: (path, isDir) => done(`@${path}${isDir ? "/" : " "}`),
					onCancel: () => done(null),
				}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%", minWidth: 60, margin: 2 },
			},
		);

	pi.registerCommand("find-file", {
		description: "Fuzzy file finder overlay; inserts @path into the editor (tree browse + filter)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("find-file needs the interactive TUI", "warning");
				return;
			}
			const files = await getFiles(ctx.cwd);
			if (files.length === 0) {
				ctx.ui.notify("fuzzy-file-finder: no files found (need fd or a git repo)", "warning");
				return;
			}
			const mention = await showFinder(ctx, files);
			if (mention) ctx.ui.pasteToEditor(mention);
		},
	});
}

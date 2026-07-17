// fuzzy-file-finder — a codex/telescope-style file picker for pi.
//
// Multi-file extension: pi loads this index.ts as one extension (jiti resolves
// the relative ./files.js / ./finder-overlay.js / ./tree.js imports at runtime),
// so no bundling or submodule is needed.
//
// Stages:
//   1 (current) — `/find-file` opens an overlay with a fuzzy flat list; the
//                 chosen path is inserted into the editor as `@path`.
//   2 (todo)    — swap the flat list for the tree model (tree.ts): directory
//                 expand/collapse with left/right.
//   3 (todo)    — intercept `@` at a word boundary via a CustomEditor wrapper
//                 (ctx.ui.setEditorComponent) to launch this overlay instead of
//                 the built-in autocomplete dropdown.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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

	pi.registerCommand("find-file", {
		description: "Fuzzy file finder overlay; inserts @path into the editor (Stage 1: flat list)",
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

			const picked = await ctx.ui.custom<string | null>(
				(tui, theme, _kb, done) =>
					new FinderOverlay({
						tui,
						theme,
						files,
						maxVisible: 20,
						onSelect: (path) => done(path),
						onCancel: () => done(null),
					}),
				{
					overlay: true,
					overlayOptions: { anchor: "center", width: "85%", maxHeight: "85%", minWidth: 60, margin: 2 },
				},
			);

			if (picked) {
				ctx.ui.pasteToEditor(`@${picked} `);
			}
		},
	});
}

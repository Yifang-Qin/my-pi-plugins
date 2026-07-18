// fuzzy-file-finder — a codex/telescope-style file picker for pi.
//
// Multi-file extension: pi loads this index.ts as one extension (jiti resolves
// the relative ./*.js imports at runtime), so no bundling or submodule is needed.
//
// Two ways to open the finder:
//   - the `/find-file` command, or
//   - typing a literal "@" at a word boundary in the editor, which opens this
//     finder instead of pi's built-in inline "@" dropdown.
//
// The finder renders in the editor slot (pi's classic `ctx.ui.custom` mode),
// NOT as an `{ overlay: true }` floating modal. A pi-tui overlay flips
// pi-powerline-footer's fixed-editor compositor into its "overlay visible"
// branch: `terminal.rows` jumps back to full height and `tui.render` returns
// the entire chat buffer, so pi-tui answers with a full-screen clear + reprint
// of the whole session — the visible "jump" (history snaps, the input box
// vanishes, content shifts) before the finder appears. Rendering in the editor
// slot leaves the chat viewport untouched: the compositor paints this
// component inside the pinned bottom cluster, and vanilla pi treats it like
// its built-in selectors.
//
// How the "@" hijack works (and why it's an autocomplete provider, NOT a
// CustomEditor): pi-tui's Editor hard-codes "@" as an autocomplete trigger, so
// the only interception points are (a) the editor's handleInput, or (b) the
// autocomplete provider chain. Approach (a) via setEditorComponent is silently
// overridden by editor-owning extensions such as pi-powerline-footer, which
// installs its own editor and never routes keystrokes through a wrapped editor's
// handleInput. It *does*, however, preserve the autocomplete provider chain
// (ModeAwareAutocompleteProvider delegates to it when not in bash mode). So we
// hook (b): on a bare word-start "@" we open the finder and return empty
// suggestions to dismiss the inline dropdown. This coexists with powerline and
// works in vanilla pi too.
//
// Inside the finder:
//   - empty query shows a collapsible directory tree (tree.ts); →/← expand or
//     collapse, enter toggles dirs / selects files, tab picks the current node
//     (directories insert as `@dir/`, files as `@path `).
//   - typing switches to a flat subsequence-fuzzy list across all files.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteProvider, AutocompleteSuggestions } from "@earendil-works/pi-tui";
import { loadFiles } from "./files.js";
import { FinderOverlay } from "./finder-overlay.js";

const CACHE_TTL_MS = 5_000;
// A literal "@" at a token boundary with nothing typed after it yet.
const BARE_AT = /(?:^|[ \t])@$/;

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

	// Show the finder for a known file list; resolves to the mention string to
	// insert (`@path ` for files, `@dir/` for directories) or null if cancelled.
	const showFinder = (ctx: ExtensionContext, files: string[]): Promise<string | null> =>
		ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			// Keep the list short enough to leave some chat rows visible. The
			// component renders a fixed-height list, so the layout never
			// oscillates while typing.
			const maxVisible = Math.max(5, Math.min(20, tui.terminal.rows - 12));
			return new FinderOverlay({
				tui,
				theme,
				files,
				maxVisible,
				onSelect: (path, isDir) => done(`@${path}${isDir ? "/" : " "}`),
				onCancel: () => done(null),
			});
		});

	// Load files then open the finder; resolves to the full mention (`@path `) or
	// null. Shared by the /find-file command and the "@"-keystroke hijack.
	const pickFile = async (ctx: ExtensionContext): Promise<string | null> => {
		const files = await getFiles(ctx.cwd);
		if (files.length === 0) {
			ctx.ui.notify("fuzzy-file-finder: no files found (need fd or a git repo)", "warning");
			return null;
		}
		return showFinder(ctx, files);
	};

	pi.registerCommand("find-file", {
		description: "Fuzzy file finder; inserts @path into the editor (tree browse + filter)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("find-file needs the interactive TUI", "warning");
				return;
			}
			const mention = await pickFile(ctx);
			if (mention) ctx.ui.pasteToEditor(mention);
		},
	});

	// Install the "@"-hijacking autocomplete wrapper. session_start fires again on
	// /reload (reason:"reload") after the provider wrappers are reset, so this is
	// the correct place to (re)register it.
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Warm the file-list cache so the first "@" opens the finder instantly
		// (a cold cache would shell out to fd while the user is already typing).
		void getFiles(ctx.cwd);

		let finderBusy = false;
		const openFinder = (): void => {
			if (finderBusy) return;
			finderBusy = true;
			void (async () => {
				try {
					const mention = await pickFile(ctx);
					// The "@" is already in the buffer (the keystroke that triggered us),
					// so append only the tail: "path " for files, "dir/" for directories.
					// Cancelled -> leave the bare "@" (also the escape hatch for typing an
					// email/decorator, or falling back to the inline fuzzy dropdown).
					if (mention) ctx.ui.pasteToEditor(mention.slice(1));
				} finally {
					finderBusy = false;
				}
			})();
		};

		ctx.ui.addAutocompleteProvider(
			(current): AutocompleteProvider => ({
				triggerCharacters: ["@"],
				async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
					const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
					if (BARE_AT.test(before)) {
						if (!finderBusy) openFinder();
						// Empty items -> the editor dismisses the inline dropdown.
						return { items: [], prefix: "@" };
					}
					// Anything else (including "@foo") -> the normal provider chain.
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				},
				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				},
				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
					return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
				},
			}),
		);
	});
}

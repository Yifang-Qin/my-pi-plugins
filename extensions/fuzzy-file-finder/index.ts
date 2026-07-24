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
// The same autocomplete provider also owns the "@query" (already typing)
// case: instead of the built-in consecutive-substring match it serves a
// codex-style subsequence-fuzzy inline dropdown ("@patf" matches
// "path/to/file"). This absorbed the former standalone fuzzy-at-files.ts
// extension, so both "@" behaviors share one file list, one cache and one
// token-boundary definition — and the old cross-extension "delegate on bare
// @" handshake is gone.
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
//   - typing switches to a flat subsequence-fuzzy list across all files AND
//     directories (dirs render with a trailing "/" and insert as `@dir/`).

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { loadFiles } from "./files.js";
import { FinderOverlay } from "./finder-overlay.js";

const CACHE_TTL_MS = 5_000;
const MAX_SUGGESTIONS = 20;
// Mirror the built-in token boundaries (pi's autocomplete.ts PATH_DELIMITERS)
// so the finder trigger and the inline fuzzy dropdown agree on what an "@"
// token is.
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);

/** Return the "@..." token immediately before the cursor, or null. */
function extractAtToken(textBeforeCursor: string): string | null {
	let start = textBeforeCursor.length;
	while (start > 0 && !PATH_DELIMITERS.has(textBeforeCursor[start - 1] ?? "")) {
		start -= 1;
	}
	const token = textBeforeCursor.slice(start);
	return token.startsWith("@") ? token.slice(1) : null;
}

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

		// Editor position captured the moment the finder opens on a bare "@".
		// See insertMention() for why we can't just paste when it closes.
		type InsertAt = { lines: string[]; cursorLine: number; cursorCol: number };

		// Splice the finder's pick into the editor *at the "@"* — not wherever the
		// cursor happens to be after the finder closes.
		//
		// Why not just ctx.ui.pasteToEditor(mention.slice(1))? pi's ctx.ui.custom()
		// (editor-slot mode) restores the editor on close via editor.setText(saved),
		// and setText() forces the caret to the END of the buffer. pasteToEditor()
		// inserts at the caret, so a mid-sentence "@" would glue the path onto the
		// tail of the line ("hello @worldsrc/foo.ts") instead of splicing it after
		// the "@" ("hello @src/foo.ts world"). It only *looked* right at end-of-input
		// because there the restored end-caret coincides with the "@".
		//
		// So we ignore the post-restore caret entirely and rebuild the line from the
		// position we captured when the finder opened (the editor was frozen behind
		// the finder in between, so that snapshot is still authoritative), then
		// setEditorText() the whole buffer. The "@" that triggered us already sits at
		// cursorCol-1, so we splice only the tail (mention without its leading "@")
		// right after it and keep whatever text followed the caret.
		//
		// Caveat: the extension UI API exposes no caret control (only
		// setEditorText/pasteToEditor/getEditorText), and setEditorText also lands
		// the caret at the end. Text is now always correct; the caret sits at end of
		// input (exactly right for the common end-of-line case, tolerable mid-line).
		const insertMention = (mention: string, at: InsertAt | null): void => {
			const tail = mention.slice(1);
			if (!at) {
				ctx.ui.pasteToEditor(tail);
				return;
			}
			const line = at.lines[at.cursorLine] ?? "";
			const newLine = line.slice(0, at.cursorCol) + tail + line.slice(at.cursorCol);
			const newLines = [...at.lines];
			newLines[at.cursorLine] = newLine;
			ctx.ui.setEditorText(newLines.join("\n"));
		};

		let finderBusy = false;
		const openFinder = (at: InsertAt | null): void => {
			if (finderBusy) return;
			finderBusy = true;
			void (async () => {
				try {
					const mention = await pickFile(ctx);
					// Splice the tail ("path "/"dir/") after the triggering "@". Cancelled
					// -> leave the bare "@" (escape hatch for an email/decorator, or the
					// inline fuzzy dropdown).
					if (mention) insertMention(mention, at);
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
					const query = extractAtToken(before);

					// Not an "@" token (plain path, "a@b", slash command…) -> built-in chain.
					if (query === null) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					// Bare "@": open the finder; empty items dismiss the inline dropdown.
					// Snapshot the editor now (lines + caret) so we can splice the pick in
					// at the "@" — by the time the finder closes the caret has been reset
					// to end-of-buffer (see insertMention).
					if (query.trim() === "") {
						if (!finderBusy) openFinder({ lines: [...lines], cursorLine, cursorCol });
						return { items: [], prefix: "@" };
					}

					// "@query": inline subsequence-fuzzy dropdown (absorbed from the
					// former fuzzy-at-files.ts). This is the escape hatch after
					// cancelling the finder, and covers fast typists who blow past the
					// bare-"@" hook. fuzzyFilter splits the query on whitespace and "/",
					// requires every token to match, and ranks best-first.
					const files = await getFiles(ctx.cwd);
					if (!options.signal.aborted && files.length > 0) {
						const ranked = fuzzyFilter(files, query, (p) => p);
						const items: AutocompleteItem[] = ranked.slice(0, MAX_SUGGESTIONS).map((p) => ({
							value: `@${p}`,
							label: p.split("/").pop() ?? p,
							description: p,
						}));
						if (items.length > 0) return { items, prefix: `@${query}` };
					}
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

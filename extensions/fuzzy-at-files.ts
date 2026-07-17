// Codex-style fuzzy "@" file completion for pi.
//
// The built-in "@" search shells out to `fd` and matches each path segment as a
// *consecutive substring* (regex), so "@patf" will NOT match "path/to/file" and
// intermediate directories must be typed. This extension replaces the "@" branch
// with a true subsequence fuzzy match (pi-tui's fuzzyFilter), so "@patf" matches
// "path/to/file" and "@src idx" matches "src/.../index.ts".
//
// 作为本 package 的一部分随 `pi install` 自动加载（package.json 的 pi.extensions
// 指向 extensions/ 目录，目录内 *.ts 全部启用）。除 "@..." token 外的所有补全
// 都委托回内置 provider，斜杠命令和普通路径补全照常工作。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

// Mirror the built-in token boundaries (autocomplete.ts PATH_DELIMITERS).
const PATH_DELIMITERS = new Set([" ", "\t", '"', "'", "="]);
const MAX_SUGGESTIONS = 20;

/** Return the "@..." token immediately before the cursor, or null. */
function extractAtToken(textBeforeCursor: string): string | null {
	let start = textBeforeCursor.length;
	while (start > 0 && !PATH_DELIMITERS.has(textBeforeCursor[start - 1] ?? "")) {
		start -= 1;
	}
	const token = textBeforeCursor.slice(start);
	return token.startsWith("@") ? token.slice(1) : null;
}

async function loadFiles(pi: ExtensionAPI, cwd: string, signal: AbortSignal): Promise<string[]> {
	// Prefer fd (respects .gitignore, fast). pi bundles fd on PATH.
	const fd = await pi.exec(
		"fd",
		["--type", "f", "--hidden", "--follow", "--exclude", ".git", "--strip-cwd-prefix"],
		{ cwd, timeout: 5_000, signal },
	).catch(() => null);
	if (fd && fd.code === 0 && fd.stdout.trim()) {
		return fd.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	}

	// Fallback: tracked + untracked files via git.
	const git = await pi.exec(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard"],
		{ cwd, timeout: 5_000, signal },
	).catch(() => null);
	if (git && git.code === 0 && git.stdout.trim()) {
		return git.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	}
	return [];
}

function createFuzzyAtProvider(
	current: AutocompleteProvider,
	getFiles: () => Promise<string[]>,
): AutocompleteProvider {
	return {
		triggerCharacters: ["@"],

		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const line = lines[cursorLine] ?? "";
			const before = line.slice(0, cursorCol);
			const query = extractAtToken(before);

			// Not an "@" token -> let the built-in provider handle it.
			if (query === null) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const files = await getFiles();
			if (options.signal.aborted || files.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			// fuzzyFilter: subsequence match, splits query on whitespace and "/",
			// requires every token to match, and ranks best-first.
			const ranked = query.trim()
				? fuzzyFilter(files, query, (p) => p)
				: files;

			const items: AutocompleteItem[] = ranked.slice(0, MAX_SUGGESTIONS).map((p) => ({
				value: `@${p}`,
				label: p.split("/").pop() ?? p,
				description: p,
			}));

			if (items.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}
			return { items, prefix: `@${query}` };
		},

		// Insertion + tab-trigger behavior are fine as-is; the built-in
		// applyCompletion already handles "@"-prefixed values.
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		// Cache the file list for the session; refresh at most every few seconds.
		let cache: string[] | null = null;
		let loadedAt = 0;
		let inflight: Promise<string[]> | null = null;
		const TTL_MS = 5_000;

		const getFiles = async (): Promise<string[]> => {
			const now = Date.now();
			if (cache && now - loadedAt < TTL_MS) return cache;
			if (inflight) return inflight;
			inflight = loadFiles(pi, ctx.cwd, new AbortController().signal)
				.then((files) => {
					cache = files;
					loadedAt = Date.now();
					inflight = null;
					return files;
				})
				.catch(() => {
					inflight = null;
					return cache ?? [];
				});
			return inflight;
		};

		void getFiles(); // warm the cache
		ctx.ui.addAutocompleteProvider((current) => createFuzzyAtProvider(current, getFiles));
	});
}

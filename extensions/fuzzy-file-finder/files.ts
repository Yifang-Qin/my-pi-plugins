// Data layer for the fuzzy file finder: list files (fd -> git fallback) and
// rank them with pi-tui's subsequence fuzzy filter. Shared by every stage.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter } from "@earendil-works/pi-tui";

/**
 * Return repo-relative file paths for `cwd`.
 * Prefers `fd` (respects .gitignore, fast); falls back to `git ls-files`.
 */
export async function loadFiles(pi: ExtensionAPI, cwd: string, signal: AbortSignal): Promise<string[]> {
	const fd = await pi
		.exec("fd", ["--type", "f", "--hidden", "--follow", "--exclude", ".git", "--strip-cwd-prefix"], {
			cwd,
			timeout: 5_000,
			signal,
		})
		.catch(() => null);
	if (fd && fd.code === 0 && fd.stdout.trim()) {
		return fd.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	}

	const git = await pi
		.exec("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd, timeout: 5_000, signal })
		.catch(() => null);
	if (git && git.code === 0 && git.stdout.trim()) {
		return git.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	}
	return [];
}

/** One filter-mode candidate: a file or a directory. */
export interface FinderEntry {
	path: string;
	isDir: boolean;
}

/**
 * All directory prefixes implied by the file list, sorted. Synthesized from
 * file paths (like tree.ts), so empty directories don't appear — consistent
 * with browse mode, and zero extra IO.
 */
export function extractDirs(files: string[]): string[] {
	const dirs = new Set<string>();
	for (const file of files) {
		let slash = file.indexOf("/");
		while (slash > 0) {
			dirs.add(file.slice(0, slash));
			slash = file.indexOf("/", slash + 1);
		}
	}
	return [...dirs].sort();
}

/** Combined filter-mode candidate list: directories first, then files. */
export function buildEntries(files: string[]): FinderEntry[] {
	return [
		...extractDirs(files).map((path) => ({ path, isDir: true })),
		...files.map((path) => ({ path, isDir: false })),
	];
}

/**
 * Subsequence fuzzy filter over entries. Empty query returns everything.
 * Directories match against "path/" so a trailing slash in the query still
 * hits them; ranking interleaves dirs and files best-first.
 * (fuzzyFilter splits on whitespace and "/", requires every token to match —
 * "src idx" and "src/idx" both hit "src/.../index.ts".)
 */
export function filterEntries(entries: FinderEntry[], query: string): FinderEntry[] {
	return query.trim()
		? fuzzyFilter(entries, query, (e) => (e.isDir ? `${e.path}/` : e.path))
		: entries;
}

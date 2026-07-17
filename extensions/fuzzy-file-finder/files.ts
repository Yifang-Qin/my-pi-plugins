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

/**
 * Subsequence fuzzy filter over full paths. Empty query returns all files.
 * (fuzzyFilter splits on whitespace and "/", requires every token to match,
 * and ranks best-first — "src idx" and "src/idx" both hit "src/.../index.ts".)
 */
export function filterFiles(files: string[], query: string): string[] {
	return query.trim() ? fuzzyFilter(files, query, (p) => p) : files;
}

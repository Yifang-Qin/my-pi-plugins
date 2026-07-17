// Finder overlay component (Stage 2: tree browse + fuzzy filter).
//
// Two modes, switched automatically by the search box:
//   - empty query  -> browse mode: directory tree with expand/collapse
//   - typing        -> filter mode: flat subsequence-fuzzy list across all files
//
// A self-contained TUI component for ctx.ui.custom({ overlay: true }).
// enter selects a file -> onSelect(path); escape -> onCancel().

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	type TUI,
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { filterFiles } from "./files.js";
import { type FlatRow, type TreeNode, buildTree, flattenVisible } from "./tree.js";

export interface FinderOverlayOptions {
	tui: TUI;
	theme: Theme;
	files: string[];
	maxVisible: number;
	onSelect: (path: string, isDir: boolean) => void;
	onCancel: () => void;
}

export class FinderOverlay implements Component, Focusable {
	private readonly opts: FinderOverlayOptions;
	private readonly input = new Input();

	// Filter mode (non-empty query): flat fuzzy list.
	private filtered: string[];
	private filterSel = 0;
	private filterScroll = 0;

	// Browse mode (empty query): directory tree.
	private readonly root: TreeNode;
	private readonly expanded = new Set<string>();
	private treeRows: FlatRow[];
	private treeSel = 0;
	private treeScroll = 0;

	private _focused = false;

	constructor(opts: FinderOverlayOptions) {
		this.opts = opts;
		this.filtered = filterFiles(opts.files, "");
		this.root = buildTree(opts.files);
		this.treeRows = flattenVisible(this.root, this.expanded);
	}

	// --- Focusable: propagate focus to the search input for IME/cursor ---
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Browse mode while the query is empty; filter mode once the user types. */
	private get isFilter(): boolean {
		return this.input.getValue().trim().length > 0;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.opts.onCancel();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			this.confirm();
			return;
		}
		if (matchesKey(data, "up")) return this.moveAndRender(-1);
		if (matchesKey(data, "down")) return this.moveAndRender(1);
		if (matchesKey(data, "pageUp")) return this.moveAndRender(-this.opts.maxVisible);
		if (matchesKey(data, "pageDown")) return this.moveAndRender(this.opts.maxVisible);
		if (matchesKey(data, "tab")) {
			this.acceptCurrent();
			return;
		}

		if (!this.isFilter) {
			// Tree navigation (browse mode only). In filter mode left/right/space
			// fall through to the Input (cursor movement / multi-token queries).
			if (matchesKey(data, "right")) {
				this.expandOrDescend();
				return this.rerender();
			}
			if (matchesKey(data, "left")) {
				this.collapseOrAscend();
				return this.rerender();
			}
			if (matchesKey(data, "space")) {
				this.toggleSelectedDir();
				return this.rerender();
			}
		}

		// Otherwise edit the query, then refilter and reset the filter cursor.
		this.input.handleInput(data);
		this.filtered = filterFiles(this.opts.files, this.input.getValue());
		this.filterSel = 0;
		this.filterScroll = 0;
		this.rerender();
	}

	private rerender(): void {
		this.opts.tui.requestRender();
	}

	private confirm(): void {
		if (this.isFilter) {
			const pick = this.filtered[this.filterSel];
			if (pick) this.opts.onSelect(pick, false);
			return;
		}
		const row = this.treeRows[this.treeSel];
		if (!row) return;
		if (row.node.isDir) {
			this.toggleSelectedDir();
			this.rerender();
		} else {
			this.opts.onSelect(row.node.path, false);
		}
	}

	/** Tab: accept the current node as-is — files select, directories insert @dir/. */
	private acceptCurrent(): void {
		if (this.isFilter) {
			const pick = this.filtered[this.filterSel];
			if (pick) this.opts.onSelect(pick, false);
			return;
		}
		const row = this.treeRows[this.treeSel];
		if (row) this.opts.onSelect(row.node.path, row.node.isDir);
	}

	private moveAndRender(delta: number): void {
		if (this.isFilter) {
			if (this.filtered.length === 0) return;
			this.filterSel = clamp(this.filterSel + delta, 0, this.filtered.length - 1);
			this.filterScroll = this.clampScroll(this.filterSel, this.filterScroll, this.filtered.length);
		} else {
			if (this.treeRows.length === 0) return;
			this.treeSel = clamp(this.treeSel + delta, 0, this.treeRows.length - 1);
			this.treeScroll = this.clampScroll(this.treeSel, this.treeScroll, this.treeRows.length);
		}
		this.rerender();
	}

	private clampScroll(sel: number, scroll: number, len: number): number {
		const mv = this.opts.maxVisible;
		let next = scroll;
		if (sel < next) next = sel;
		else if (sel >= next + mv) next = sel - mv + 1;
		return Math.max(0, Math.min(next, Math.max(0, len - mv)));
	}

	// --- Tree navigation ---

	private expandOrDescend(): void {
		const row = this.treeRows[this.treeSel];
		if (!row || !row.node.isDir) return;
		if (row.hasChildren && !this.expanded.has(row.node.path)) {
			this.expanded.add(row.node.path);
			this.recomputeTree();
		} else {
			this.moveAndRender(1); // already open (or empty dir) -> step to first child
		}
	}

	private collapseOrAscend(): void {
		const row = this.treeRows[this.treeSel];
		if (!row) return;
		if (row.node.isDir && this.expanded.has(row.node.path)) {
			this.expanded.delete(row.node.path);
			this.recomputeTree();
			return;
		}
		// Otherwise jump to the parent directory row.
		const slash = row.node.path.lastIndexOf("/");
		if (slash < 0) return; // already top level
		const parentPath = row.node.path.slice(0, slash);
		const idx = this.treeRows.findIndex((r) => r.node.path === parentPath);
		if (idx >= 0) {
			this.treeSel = idx;
			this.treeScroll = this.clampScroll(this.treeSel, this.treeScroll, this.treeRows.length);
		}
	}

	private toggleSelectedDir(): void {
		const row = this.treeRows[this.treeSel];
		if (!row || !row.node.isDir || !row.hasChildren) return;
		if (this.expanded.has(row.node.path)) this.expanded.delete(row.node.path);
		else this.expanded.add(row.node.path);
		this.recomputeTree();
	}

	private recomputeTree(): void {
		this.treeRows = flattenVisible(this.root, this.expanded);
		this.treeSel = clamp(this.treeSel, 0, Math.max(0, this.treeRows.length - 1));
		this.treeScroll = this.clampScroll(this.treeSel, this.treeScroll, this.treeRows.length);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const { theme } = this.opts;
		// Frame + title use the normal text color (theme "text") so the border
		// looks like ordinary characters rather than an accent highlight.
		const border = (s: string): string => theme.fg("text", s);
		// Frame = 2 border cells + 2 padding cells; inner is the usable content width.
		const inner = Math.max(1, width - 4);

		const top = ((): string => {
			const title = " files ";
			const fill = Math.max(0, width - 3 - visibleWidth(title)); // ╔═ (2) + ╗ (1)
			return border("╔═") + theme.bold(border(title)) + border(`${"═".repeat(fill)}╗`);
		})();
		const divider = border(`╠${"═".repeat(Math.max(0, width - 2))}╣`);
		const bottom = border(`╚${"═".repeat(Math.max(0, width - 2))}╝`);

		// Wrap already-colored content (with known visible width) in side borders,
		// right-padding so the closing ║ always aligns.
		const frame = (colored: string, visibleLen: number): string =>
			border("║ ") + colored + " ".repeat(Math.max(0, inner - visibleLen)) + border(" ║");
		const frameText = (text: string, color: (t: string) => string): string => {
			const t = truncateToWidth(text, inner);
			return frame(color(t), visibleWidth(t));
		};

		const lines: string[] = [top];

		// Search box: Input renders its own "> " prompt + value + cursor marker.
		const inputLine = this.input.render(Math.max(1, inner))[0] ?? "";
		lines.push(frame(inputLine, visibleWidth(inputLine)));
		lines.push(divider);

		let footer: string;
		if (this.isFilter) {
			if (this.filtered.length === 0) {
				lines.push(frameText("no matches", (t) => theme.fg("warning", t)));
			} else {
				const end = Math.min(this.filterScroll + this.opts.maxVisible, this.filtered.length);
				for (let i = this.filterScroll; i < end; i++) {
					const path = this.filtered[i]!;
					const isSel = i === this.filterSel;
					const text = (isSel ? "› " : "  ") + path;
					lines.push(frameText(text, (t) => (isSel ? theme.fg("accent", t) : theme.fg("text", t))));
				}
			}
			footer = `${this.filtered.length}/${this.opts.files.length} · ↑↓ move · enter/tab select · esc cancel`;
		} else {
			const end = Math.min(this.treeScroll + this.opts.maxVisible, this.treeRows.length);
			for (let i = this.treeScroll; i < end; i++) {
				const row = this.treeRows[i]!;
				const isSel = i === this.treeSel;
				const indent = "  ".repeat(row.depth);
				const marker = row.node.isDir ? (row.expanded ? "▾ " : "▸ ") : "  ";
				const name = row.node.name + (row.node.isDir ? "/" : "");
				const text = (isSel ? "› " : "  ") + indent + marker + name;
				lines.push(frameText(text, (t) => (isSel ? theme.fg("accent", t) : theme.fg("text", t))));
			}
			footer = `${this.opts.files.length} files · ↑↓ · →/← expand · enter open · tab pick dir · esc`;
		}

		lines.push(divider);
		lines.push(frameText(footer, (t) => theme.fg("dim", t)));
		lines.push(bottom);
		return lines;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

// Finder overlay component (Stage 1: flat fuzzy list).
//
// A self-contained TUI component for ctx.ui.custom({ overlay: true }):
//   - an Input search box (typing refilters)
//   - a windowed, scrollable results list with a selection cursor
//   - enter -> onSelect(path), escape -> onCancel()
//
// Stage 2 will swap the flat list for the tree model in tree.ts (expand/collapse
// with left/right); the search-box + windowing scaffolding here stays.

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

export interface FinderOverlayOptions {
	tui: TUI;
	theme: Theme;
	files: string[];
	maxVisible: number;
	onSelect: (path: string) => void;
	onCancel: () => void;
}

export class FinderOverlay implements Component, Focusable {
	private readonly opts: FinderOverlayOptions;
	private readonly input = new Input();
	private filtered: string[];
	private selected = 0;
	private scrollTop = 0;
	private _focused = false;

	constructor(opts: FinderOverlayOptions) {
		this.opts = opts;
		this.filtered = filterFiles(opts.files, "");
	}

	// --- Focusable: propagate focus to the search input for IME/cursor ---
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			this.opts.onCancel();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const pick = this.filtered[this.selected];
			if (pick) this.opts.onSelect(pick);
			return;
		}
		if (matchesKey(data, "up")) {
			this.moveSelection(-1);
		} else if (matchesKey(data, "down")) {
			this.moveSelection(1);
		} else if (matchesKey(data, "pageUp")) {
			this.moveSelection(-this.opts.maxVisible);
		} else if (matchesKey(data, "pageDown")) {
			this.moveSelection(this.opts.maxVisible);
		} else {
			// Everything else (printable chars, backspace, left/right, paste) edits
			// the query; then refilter and reset the cursor to the top.
			this.input.handleInput(data);
			this.filtered = filterFiles(this.opts.files, this.input.getValue());
			this.selected = 0;
			this.scrollTop = 0;
		}
		this.opts.tui.requestRender();
	}

	private moveSelection(delta: number): void {
		if (this.filtered.length === 0) return;
		this.selected = Math.max(0, Math.min(this.filtered.length - 1, this.selected + delta));
		if (this.selected < this.scrollTop) {
			this.scrollTop = this.selected;
		} else if (this.selected >= this.scrollTop + this.opts.maxVisible) {
			this.scrollTop = this.selected - this.opts.maxVisible + 1;
		}
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const { theme } = this.opts;
		// Frame + title share the selected-row color (theme "accent") so they always match.
		const border = (s: string): string => theme.fg("accent", s);
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

		// Results window.
		if (this.filtered.length === 0) {
			lines.push(frameText("no matches", (t) => theme.fg("warning", t)));
		} else {
			const end = Math.min(this.scrollTop + this.opts.maxVisible, this.filtered.length);
			for (let i = this.scrollTop; i < end; i++) {
				const path = this.filtered[i]!;
				const isSel = i === this.selected;
				const text = (isSel ? "› " : "  ") + path;
				lines.push(frameText(text, (t) => (isSel ? theme.fg("accent", t) : theme.fg("text", t))));
			}
		}

		// Footer: count + key hints.
		const count = `${this.filtered.length}/${this.opts.files.length}`;
		lines.push(divider);
		lines.push(frameText(`${count} · ↑↓ move · enter select · esc cancel`, (t) => theme.fg("dim", t)));
		lines.push(bottom);
		return lines;
	}
}

// tree-nav overlay component.
//
// A self-contained ctx.ui.custom({ overlay: true }) component that renders the
// user-centric NavModel as a large centered panel:
//
//   ◉ current turn (accent)      ● on active path      ○ off-path turn
//   depth = compact branch indentation (only grows at real branch points)
//   →/space expands a turn to reveal its collapsed assistant/tool segment
//
// enter -> onSelect(entryId); the caller feeds that id to ctx.navigateTree().
// escape -> onCancel().
//
// STATUS: Stage 1 skeleton. See README.md "Roadmap" for what is intentionally
// left as TODO (true lane/pipe gutter graphics, adaptive balancing, search,
// labels, summary-on-navigate parity).

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, type TUI, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { NavModel, SegmentEntry, UserNode } from "./session-tree.js";

export interface NavOverlayOptions {
	tui: TUI;
	theme: Theme;
	model: NavModel;
	onSelect: (entryId: string) => void;
	onCancel: () => void;
}

type Row =
	| { kind: "user"; entryId: string; depth: number; user: UserNode }
	| { kind: "seg"; entryId: string; depth: number; seg: SegmentEntry };

export class NavOverlay implements Component, Focusable {
	private readonly opts: NavOverlayOptions;
	private readonly maxVisible: number;
	private readonly expanded = new Set<string>();
	private rows: Row[] = [];
	private sel = 0;
	private scroll = 0;
	private _focused = false;

	constructor(opts: NavOverlayOptions) {
		this.opts = opts;
		const termRows = opts.tui.terminal?.rows ?? 24;
		this.maxVisible = Math.max(6, Math.min(40, termRows - 8));
		this.rebuild();
		// Preselect the current turn (nearest user ancestor of the leaf).
		const cur = opts.model.currentIndex;
		if (cur >= 0) {
			const idx = this.rows.findIndex((r) => r.kind === "user" && r.user.id === opts.model.users[cur]!.id);
			if (idx >= 0) this.sel = idx;
		}
		this.scroll = this.clampScroll(this.sel, 0, this.rows.length);
	}

	// Focusable — no embedded Input yet, but keep the contract for future search.
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
	}

	private rebuild(): void {
		const rows: Row[] = [];
		for (const u of this.opts.model.users) {
			rows.push({ kind: "user", entryId: u.id, depth: u.depth, user: u });
			if (this.expanded.has(u.id)) {
				for (const s of u.segment) rows.push({ kind: "seg", entryId: s.id, depth: u.depth + 1, seg: s });
			}
		}
		this.rows = rows;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) return this.opts.onCancel();
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const row = this.rows[this.sel];
			if (row) this.opts.onSelect(row.entryId);
			return;
		}
		if (matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "pageUp")) return this.move(-this.maxVisible);
		if (matchesKey(data, "pageDown")) return this.move(this.maxVisible);
		if (matchesKey(data, "right") || matchesKey(data, "space") || data === "o") return this.expandCurrent();
		if (matchesKey(data, "left")) return this.collapseCurrent();
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		this.sel = clamp(this.sel + delta, 0, this.rows.length - 1);
		this.scroll = this.clampScroll(this.sel, this.scroll, this.rows.length);
		this.opts.tui.requestRender();
	}

	private expandCurrent(): void {
		const row = this.rows[this.sel];
		if (!row || row.kind !== "user" || row.user.segment.length === 0) return;
		if (this.expanded.has(row.user.id)) return this.move(1); // already open -> step in
		this.expanded.add(row.user.id);
		this.rebuild();
		this.opts.tui.requestRender();
	}

	private collapseCurrent(): void {
		const row = this.rows[this.sel];
		if (!row) return;
		// On a segment row, collapse and return to its owning user row.
		if (row.kind === "seg") {
			const owner = this.findOwnerUserIndex(this.sel);
			if (owner >= 0) {
				const u = this.rows[owner] as Extract<Row, { kind: "user" }>;
				this.expanded.delete(u.user.id);
				this.rebuild();
				this.sel = this.rows.findIndex((r) => r.entryId === u.user.id);
			}
		} else if (this.expanded.has(row.user.id)) {
			this.expanded.delete(row.user.id);
			this.rebuild();
		}
		this.sel = clamp(this.sel, 0, Math.max(0, this.rows.length - 1));
		this.scroll = this.clampScroll(this.sel, this.scroll, this.rows.length);
		this.opts.tui.requestRender();
	}

	private findOwnerUserIndex(segIndex: number): number {
		for (let i = segIndex; i >= 0; i--) if (this.rows[i]!.kind === "user") return i;
		return -1;
	}

	private clampScroll(sel: number, scroll: number, len: number): number {
		const mv = this.maxVisible;
		let next = scroll;
		if (sel < next) next = sel;
		else if (sel >= next + mv) next = sel - mv + 1;
		return Math.max(0, Math.min(next, Math.max(0, len - mv)));
	}

	invalidate(): void {}

	render(width: number): string[] {
		const { theme, model } = this.opts;
		const border = (s: string): string => theme.fg("text", s);
		const inner = Math.max(1, width - 4);

		const title = ` session tree · ${model.totalUsers} turns `;
		const topFill = Math.max(0, width - 3 - visibleWidth(title));
		const top = border("╔═") + theme.bold(border(title)) + border(`${"═".repeat(topFill)}╗`);
		const divider = border(`╠${"═".repeat(Math.max(0, width - 2))}╣`);
		const bottom = border(`╚${"═".repeat(Math.max(0, width - 2))}╝`);
		const frame = (colored: string, len: number): string =>
			border("║ ") + colored + " ".repeat(Math.max(0, inner - len)) + border(" ║");
		const frameText = (text: string, color: (t: string) => string): string => {
			const t = truncateToWidth(text, inner);
			return frame(color(t), visibleWidth(t));
		};

		const lines: string[] = [top];

		if (this.rows.length === 0) {
			lines.push(frameText("no user turns in this session", (t) => theme.fg("warning", t)));
		} else {
			const end = Math.min(this.scroll + this.maxVisible, this.rows.length);
			for (let i = this.scroll; i < end; i++) {
				const row = this.rows[i]!;
				const isSel = i === this.sel;
				lines.push(frame(this.renderRow(row, isSel, inner, theme), inner >= 0 ? this.rowVisibleWidth(row, isSel, inner, theme) : 0));
			}
		}

		lines.push(divider);
		const footer = "↑↓ move · enter jump · →/space expand · ← collapse · esc cancel";
		lines.push(frameText(footer, (t) => theme.fg("dim", t)));
		lines.push(bottom);
		return lines;
	}

	// Build the colored body of a single row (already truncated to `inner`).
	private renderRow(row: Row, isSel: boolean, inner: number, theme: Theme): string {
		const raw = this.rowPlain(row);
		const truncated = truncateToWidth(raw, inner, "");
		let colored: string;
		if (row.kind === "seg") {
			colored = theme.fg("muted", truncated);
		} else {
			const u = row.user;
			const paint = u.isCurrent ? (t: string) => theme.bold(theme.fg("accent", t)) : u.onActivePath ? (t: string) => theme.fg("text", t) : (t: string) => theme.fg("muted", t);
			colored = paint(truncated);
		}
		if (isSel) colored = theme.bg("selectedBg", colored);
		// Right-pad so the selection highlight spans the full inner width.
		const pad = Math.max(0, inner - visibleWidth(truncated));
		return colored + (isSel ? theme.bg("selectedBg", " ".repeat(pad)) : " ".repeat(pad));
	}

	private rowVisibleWidth(_row: Row, _isSel: boolean, inner: number, _theme: Theme): number {
		return inner; // renderRow always pads to inner
	}

	// Plain (uncolored) row text: cursor + indent + glyph + label + preview.
	private rowPlain(row: Row): string {
		const cursor = this.rows[this.sel]?.entryId === row.entryId ? "› " : "  ";
		const indent = "  ".repeat(row.depth);
		if (row.kind === "seg") {
			const g = row.seg.kind === "tool" ? "└╴" : "└─";
			return `${cursor}${indent}${g} ${row.seg.preview}`;
		}
		const u = row.user;
		const glyph = u.isCurrent ? "◉" : u.onActivePath ? "●" : "○";
		const fold = u.segment.length > 0 ? (this.expanded.has(u.id) ? "▾" : "▸") : " ";
		const label = u.label ? `[${u.label}] ` : "";
		const seg = u.segment.length > 0 ? ` ·${u.segment.length}` : "";
		return `${cursor}${indent}${fold}${glyph} ${label}${u.preview}${seg}`;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

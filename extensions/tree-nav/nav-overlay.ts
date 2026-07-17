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
	| { kind: "user"; entryId: string; user: UserNode }
	| { kind: "seg"; entryId: string; seg: SegmentEntry; userCol: number; descGutter: number[]; laneContinues: boolean };

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
			rows.push({ kind: "user", entryId: u.id, user: u });
			if (this.expanded.has(u.id)) {
				for (const s of u.segment) {
					rows.push({ kind: "seg", entryId: s.id, seg: s, userCol: u.depth, descGutter: u.descGutterCols, laneContinues: u.laneContinues });
				}
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
				lines.push(frame(this.renderRow(row, isSel, inner, theme), inner));
			}
		}

		lines.push(divider);
		const footer = "↑↓ move · enter jump · →/space expand · ← collapse · esc cancel";
		lines.push(frameText(footer, (t) => theme.fg("dim", t)));
		lines.push(bottom);
		return lines;
	}

	// Render one row (already padded to exactly `inner` visible columns) with a
	// lazygit-style lane gutter, then the node glyph / segment marker and text.
	private renderRow(row: Row, isSel: boolean, inner: number, theme: Theme): string {
		const cursor = isSel ? theme.fg("accent", "› ") : "  ";
		const pipe = (s: string) => theme.fg("dim", s);

		let prefix: string;
		let prefixWidth: number;
		let content: string;
		let paint: (t: string) => string;

		if (row.kind === "seg") {
			// Ancestor pipes (descGutter) keep sibling branches connected; the turn's
			// own column shows a pipe only while its lane continues to a child below.
			const laneSet = new Set(row.descGutter);
			let lanes = "";
			for (let lvl = 0; lvl < row.userCol; lvl++) lanes += laneSet.has(lvl) ? pipe("│ ") : "  ";
			lanes += row.laneContinues ? pipe("│ ") : "  ";
			prefix = cursor + lanes + theme.fg("muted", "╴");
			prefixWidth = 2 + row.userCol * 2 + 2 + 1;
			content = row.seg.preview;
			paint = (t) => theme.fg("muted", t);
		} else {
			const u = row.user;
			const onPath = u.onActivePath;
			const laneSet = new Set(u.gutterCols);
			let lanes = "";
			for (let lvl = 0; lvl < u.depth; lvl++) {
				if (lvl === u.connectorCol) {
					const g = u.isLastSibling ? "╰─" : "├─";
					lanes += onPath ? theme.fg("accent", g) : pipe(g);
				} else {
					lanes += laneSet.has(lvl) ? pipe("│ ") : "  ";
				}
			}
			const glyph = u.isCurrent ? "◉" : onPath ? "●" : "○";
			paint = u.isCurrent ? (t) => theme.bold(theme.fg("accent", t)) : onPath ? (t) => theme.fg("text", t) : (t) => theme.fg("muted", t);
			prefix = cursor + lanes + paint(glyph) + " ";
			prefixWidth = 2 + u.depth * 2 + 2;
			const fold = u.segment.length > 0 ? (this.expanded.has(u.id) ? "▾ " : "▸ ") : "";
			const label = u.label ? `[${u.label}] ` : "";
			const count = u.segment.length > 0 ? ` ·${u.segment.length}` : "";
			content = `${fold}${label}${u.preview}${count}`;
		}

		const avail = Math.max(0, inner - prefixWidth);
		const textPlain = truncateToWidth(content, avail, "");
		const pad = Math.max(0, inner - prefixWidth - visibleWidth(textPlain));
		const line = prefix + paint(textPlain) + " ".repeat(pad);
		return isSel ? theme.bg("selectedBg", line) : line;
	}
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

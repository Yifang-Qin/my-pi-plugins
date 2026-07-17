// tree-nav overlay component.
//
// A self-contained ctx.ui.custom({ overlay: true }) component that renders the
// user-centric NavModel as a large centered panel with two modes:
//
//   - BROWSE (empty query): lazygit-style lane gutter over user turns.
//       ◉ current turn (accent)   ● on active path   ○ off-path turn
//       →/space expands a turn to reveal its collapsed assistant/tool segment;
//       ← collapses. depth grows only at real branch points.
//   - FILTER (typing): a flat list of user turns whose text matches the query
//       (whitespace-split, all tokens must appear; case-insensitive), matches
//       highlighted. Lanes are dropped while filtering — search is for jumping,
//       not structural navigation.
//
// enter -> onSelect(entryId); the caller feeds that id to ctx.navigateTree().
// escape -> clear the query first, then onCancel().

import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, type TUI, Input, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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
	private readonly input = new Input();

	// Browse mode (lane tree) selection/scroll.
	private rows: Row[] = [];
	private sel = 0;
	private scroll = 0;

	// Filter mode (flat matches) selection/scroll.
	private tokens: string[] = [];
	private filtered: UserNode[] = [];
	private filterSel = 0;
	private filterScroll = 0;

	private _focused = false;

	constructor(opts: NavOverlayOptions) {
		this.opts = opts;
		const termRows = opts.tui.terminal?.rows ?? 24;
		this.maxVisible = Math.max(6, Math.min(40, termRows - 10));
		this.rebuild();
		// Preselect the current turn (nearest user ancestor of the leaf).
		const cur = opts.model.currentIndex;
		if (cur >= 0) {
			const idx = this.rows.findIndex((r) => r.kind === "user" && r.user.id === opts.model.users[cur]!.id);
			if (idx >= 0) this.sel = idx;
		}
		this.scroll = this.clampScroll(this.sel, 0, this.rows.length);
	}

	// Focusable — propagate focus to the search input for IME/cursor positioning.
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	/** Browse while the query is empty; filter once the user types. */
	private get isFilter(): boolean {
		return this.input.getValue().trim().length > 0;
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

	// Recompute the flat match list from the current query (user turns only).
	private refilter(): void {
		const q = this.input.getValue().trim().toLowerCase();
		this.tokens = q ? q.split(/\s+/).filter(Boolean) : [];
		this.filtered = this.tokens.length === 0
			? []
			: this.opts.model.users.filter((u) => {
					const hay = `${u.label ?? ""} ${u.preview}`.toLowerCase();
					return this.tokens.every((t) => hay.includes(t));
				});
		this.filterSel = 0;
		this.filterScroll = 0;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			// Clear the query first (back to browse); only cancel when already empty.
			if (this.isFilter) {
				this.input.setValue("");
				this.refilter();
				return this.opts.tui.requestRender();
			}
			return this.opts.onCancel();
		}
		if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			const id = this.isFilter ? this.filtered[this.filterSel]?.id : this.rows[this.sel]?.entryId;
			if (id) this.opts.onSelect(id);
			return;
		}
		if (matchesKey(data, "up")) return this.move(-1);
		if (matchesKey(data, "down")) return this.move(1);
		if (matchesKey(data, "pageUp")) return this.move(-this.maxVisible);
		if (matchesKey(data, "pageDown")) return this.move(this.maxVisible);

		if (!this.isFilter) {
			// Browse-only structural keys. (No 'o' shortcut — letters start a search.)
			if (matchesKey(data, "right") || matchesKey(data, "space")) return this.expandCurrent();
			if (matchesKey(data, "left")) return this.collapseCurrent();
		}

		// Anything else edits the query, then refilters.
		this.input.handleInput(data);
		this.refilter();
		this.opts.tui.requestRender();
	}

	private move(delta: number): void {
		if (this.isFilter) {
			if (this.filtered.length === 0) return;
			this.filterSel = clamp(this.filterSel + delta, 0, this.filtered.length - 1);
			this.filterScroll = this.clampScroll(this.filterSel, this.filterScroll, this.filtered.length);
		} else {
			if (this.rows.length === 0) return;
			this.sel = clamp(this.sel + delta, 0, this.rows.length - 1);
			this.scroll = this.clampScroll(this.sel, this.scroll, this.rows.length);
		}
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

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		const { theme, model } = this.opts;
		const border = (s: string): string => theme.fg("text", s);
		const inner = Math.max(1, width - 4);

		const filtering = this.isFilter;
		const title = filtering ? ` search · ${this.filtered.length}/${model.totalUsers} turns ` : ` session tree · ${model.totalUsers} turns `;
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

		// Search box (Input renders its own "> " prompt + value + cursor marker).
		const inputLine = this.input.render(Math.max(1, inner))[0] ?? "";
		lines.push(frame(inputLine, visibleWidth(inputLine)));
		lines.push(divider);

		if (filtering) {
			if (this.filtered.length === 0) {
				lines.push(frameText("no matching turns", (t) => theme.fg("warning", t)));
			} else {
				const end = Math.min(this.filterScroll + this.maxVisible, this.filtered.length);
				for (let i = this.filterScroll; i < end; i++) {
					lines.push(frame(this.renderMatch(this.filtered[i]!, i === this.filterSel, inner, theme), inner));
				}
			}
		} else if (this.rows.length === 0) {
			lines.push(frameText("no user turns in this session", (t) => theme.fg("warning", t)));
		} else {
			const end = Math.min(this.scroll + this.maxVisible, this.rows.length);
			for (let i = this.scroll; i < end; i++) {
				lines.push(frame(this.renderRow(this.rows[i]!, i === this.sel, inner, theme), inner));
			}
		}

		lines.push(divider);
		const footer = filtering
			? "↑↓ move · enter jump · esc clear"
			: "↑↓ move · enter jump · →/← expand · type to search · esc";
		lines.push(frameText(footer, (t) => theme.fg("dim", t)));
		lines.push(bottom);
		return lines;
	}

	// Flat filter-mode row: glyph (by active-path state) + highlighted preview.
	// Text uses a neutral base so the accent match highlight always stands out
	// — even on the current turn (whose glyph is still accent).
	private renderMatch(u: UserNode, isSel: boolean, inner: number, theme: Theme): string {
		const cursor = isSel ? theme.fg("accent", "› ") : "  ";
		const onPath = u.onActivePath || u.isCurrent;
		const glyphPaint = u.isCurrent ? (t: string) => theme.bold(theme.fg("accent", t)) : u.onActivePath ? (t: string) => theme.fg("text", t) : (t: string) => theme.fg("muted", t);
		const textBase = (t: string) => theme.fg(onPath ? "text" : "muted", t);
		const glyph = u.isCurrent ? "◉" : u.onActivePath ? "●" : "○";
		const prefix = cursor + glyphPaint(glyph) + " ";
		const prefixWidth = 2 + 2;
		const avail = Math.max(0, inner - prefixWidth);
		const label = u.label ? `[${u.label}] ` : "";
		const plain = truncateToWidth(`${label}${u.preview}`, avail, "");
		const hl = (t: string) => theme.bold(theme.fg("accent", t));
		const body = highlightMatches(plain, this.tokens, textBase, hl);
		const pad = Math.max(0, inner - prefixWidth - visibleWidth(plain));
		const line = prefix + body + " ".repeat(pad);
		return isSel ? theme.bg("selectedBg", line) : line;
	}

	// Render one browse row (padded to `inner`) with a lazygit-style lane gutter.
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

// Color `plain` with `base`, wrapping every (merged) token occurrence in `hl`.
// ANSI-only changes keep the visible width equal to plain's width.
function highlightMatches(plain: string, tokens: string[], base: (t: string) => string, hl: (t: string) => string): string {
	if (tokens.length === 0) return base(plain);
	const lower = plain.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const t of tokens) {
		if (!t) continue;
		for (let from = 0; ; ) {
			const idx = lower.indexOf(t, from);
			if (idx < 0) break;
			ranges.push([idx, idx + t.length]);
			from = idx + t.length;
		}
	}
	if (ranges.length === 0) return base(plain);
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: Array<[number, number]> = [];
	for (const r of ranges) {
		const last = merged[merged.length - 1];
		if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
		else merged.push([r[0], r[1]]);
	}
	let out = "";
	let i = 0;
	for (const [s, e] of merged) {
		if (s > i) out += base(plain.slice(i, s));
		out += hl(plain.slice(s, e));
		i = e;
	}
	if (i < plain.length) out += base(plain.slice(i));
	return out;
}

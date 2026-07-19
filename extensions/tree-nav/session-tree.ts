// tree-nav data layer.
//
// Turns pi's raw session tree (SessionTreeNode[]) into a *user-node-centric*
// model that the overlay renders lazygit-style:
//
//   - Only user turns are first-class rows.
//   - Between two user turns, the assistant/tool entries are collapsed into a
//     "segment" that can be expanded on demand (points 2 & 3 of the plan).
//   - Branch depth is COMPACT: a linear conversation stays at depth 0; depth
//     only increases at a real branch point (a user node whose parent user node
//     has more than one user child). This is the key difference from the
//     built-in tree, which lets deep linear chains drift right.
//   - The path from the current leaf to the root ("active path") is flagged so
//     the overlay can keep it visually prominent, and children on the active
//     branch are ordered first.
//
// navigateTree() semantics we rely on (see agent-session.navigateTree):
//   - target = USER message   -> leaf becomes target.parentId, the user text is
//     returned as editorText (rewind the turn, prompt restored for editing).
//   - target = non-user entry  -> leaf becomes that entry (continue from there).

import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";

/** A collapsed assistant/tool entry that belongs to one user turn's response. */
export interface SegmentEntry {
	id: string;
	kind: "assistant" | "tool" | "other";
	preview: string;
}

/** A user turn — the first-class navigation unit. */
export interface UserNode {
	id: string;
	/**
	 * Compact branch depth (also the glyph column): 0 = mainline, +1 per real
	 * branch point. Linear chains keep the same depth.
	 */
	depth: number;
	/** True when this turn lies on the current leaf → root path. */
	onActivePath: boolean;
	/** True for the turn nearest to (and at/above) the current leaf. */
	isCurrent: boolean;
	/** Last among its user siblings at a branch point (elbow └ vs tee ├). */
	isLastSibling: boolean;
	/**
	 * True when this turn's parent user turn sits in the SAME lane directly above
	 * (i.e. a linear continuation). Drives the upward half of the lane's time-rail
	 * `│` so consecutive turns read as connected even while collapsed. False for a
	 * root's first turn and for branch children (which attach via an elbow ├/╰).
	 */
	parentSameLane: boolean;
	label?: string;
	preview: string;
	/** Assistant/tool entries produced in response to this turn (collapsed). */
	segment: SegmentEntry[];
	/**
	 * Lane rendering (lazygit-style gutter):
	 * - `gutterCols`: columns (< depth) that draw a vertical pipe │ on this row,
	 *   because an ancestor branch has a later sibling still rendered below.
	 * - `connectorCol`: column for this node's ├/└ elbow (= depth - 1), or -1 when
	 *   this node is a linear continuation (no branch connector).
	 * - `descGutterCols`: pipes that this turn's *descendants* (its expanded
	 *   segment / child rows) carry — includes the branch column when this turn
	 *   is a non-last sibling, so the line reaches the sibling below.
	 * - `laneContinues`: whether this turn has a following user child, i.e. its
	 *   own column keeps a │ through its expanded segment.
	 */
	gutterCols: number[];
	connectorCol: number;
	descGutterCols: number[];
	laneContinues: boolean;
}

export interface NavModel {
	users: UserNode[];
	/** Index into `users` of the current turn, or -1. */
	currentIndex: number;
	/** Total user turns across all branches (for the footer). */
	totalUsers: number;
	multiRoot: boolean;
}

const ROOT = "\u0000ROOT";

function isUserNode(node: SessionTreeNode): boolean {
	const e = node.entry;
	return e.type === "message" && e.message.role === "user";
}

/** First N chars of the plain-text content of an entry, whitespace-normalized. */
export function previewOf(entry: SessionEntry, max = 160): string {
	const norm = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, max);
	if (entry.type === "message") {
		const msg = entry.message;
		if (msg.role === "user") return norm(extractText(msg.content));
		if (msg.role === "assistant") {
			const text = extractText(msg.content);
			if (text.trim()) return `assistant: ${norm(text)}`;
			if (msg.stopReason === "aborted") return "assistant: (aborted)";
			if (msg.errorMessage) return `assistant: ${norm(msg.errorMessage)}`;
			// Assistant turn that only issued tool calls.
			const calls = extractToolCalls(msg.content);
			return calls.length ? calls.map(formatToolCall).join("  ") : "assistant: (tool call)";
		}
		if (msg.role === "toolResult") return `↳ ${msg.toolName ?? "tool"} result`;
		return `[${msg.role}]`;
	}
	if (entry.type === "branch_summary") return `⟪summary⟫ ${norm(entry.summary)}`;
	if (entry.type === "compaction") return `⟪compaction ${Math.round(entry.tokensBefore / 1000)}k⟫`;
	if (entry.type === "custom_message") return `[${entry.customType}]`;
	return `[${entry.type}]`;
}

function segmentKind(entry: SessionEntry): SegmentEntry["kind"] {
	if (entry.type === "message") {
		if (entry.message.role === "assistant") return "assistant";
		if (entry.message.role === "toolResult") return "tool";
	}
	return "other";
}

// --- content helpers (mirrors tree-selector's extraction, kept local) ---------

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let out = "";
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "text") {
			out += (block as { text?: string }).text ?? "";
		}
	}
	return out;
}

interface ToolCall {
	name: string;
	arguments: Record<string, unknown>;
}

function extractToolCalls(content: unknown): ToolCall[] {
	if (!Array.isArray(content)) return [];
	const calls: ToolCall[] = [];
	for (const block of content) {
		if (block && typeof block === "object" && "type" in block && block.type === "toolCall") {
			const tc = block as { name?: string; arguments?: Record<string, unknown> };
			calls.push({ name: tc.name ?? "tool", arguments: tc.arguments ?? {} });
		}
	}
	return calls;
}

function formatToolCall(tc: ToolCall): string {
	const a = tc.arguments;
	const p = (v: unknown) => String(v ?? "");
	switch (tc.name) {
		case "read":
			return `[read: ${p(a.path ?? a.file_path)}]`;
		case "write":
			return `[write: ${p(a.path ?? a.file_path)}]`;
		case "edit":
			return `[edit: ${p(a.path ?? a.file_path)}]`;
		case "bash":
			return `[bash: ${p(a.command).replace(/\s+/g, " ").slice(0, 40)}]`;
		case "grep":
			return `[grep: /${p(a.pattern)}/]`;
		default:
			return `[${tc.name}]`;
	}
}

// --- model construction -------------------------------------------------------

/**
 * Build the user-centric navigation model.
 *
 * @param roots  ctx.sessionManager.getTree()
 * @param leafId ctx.sessionManager.getLeafId()
 */
export function buildNavModel(roots: SessionTreeNode[], leafId: string | null): NavModel {
	// 1. Index every node by id, and record entry.parentId for upward walks.
	const byId = new Map<string, SessionTreeNode>();
	(function index(nodes: SessionTreeNode[]) {
		for (const n of nodes) {
			byId.set(n.entry.id, n);
			index(n.children);
		}
	})(roots);

	// 2. Active path = ids on the leaf → root chain.
	const activePath = new Set<string>();
	for (let id = leafId; id; ) {
		activePath.add(id);
		id = byId.get(id)?.entry.parentId ?? null;
	}

	// Order children so the active branch is visited first (stays on top/left).
	const orderChildren = (node: SessionTreeNode): SessionTreeNode[] => {
		if (node.children.length < 2) return node.children;
		const active: SessionTreeNode[] = [];
		const rest: SessionTreeNode[] = [];
		for (const c of node.children) (subtreeHasActive(c) ? active : rest).push(c);
		return [...active, ...rest];
	};
	const activeSubtreeCache = new Map<string, boolean>();
	function subtreeHasActive(node: SessionTreeNode): boolean {
		const cached = activeSubtreeCache.get(node.entry.id);
		if (cached !== undefined) return cached;
		let has = activePath.has(node.entry.id);
		if (!has) for (const c of node.children) if (subtreeHasActive(c)) has = true;
		activeSubtreeCache.set(node.entry.id, has);
		return has;
	}

	// 3. Map each user node to its nearest user ancestor, in DFS (active-first)
	//    order, so userChildren preserves the desired render order.
	const userParent = new Map<string, string>(); // userId -> parentUserId | ROOT
	const userChildren = new Map<string, string[]>([[ROOT, []]]);
	(function walk(node: SessionTreeNode, nearestUser: string) {
		let nextUser = nearestUser;
		if (isUserNode(node)) {
			userParent.set(node.entry.id, nearestUser);
			(userChildren.get(nearestUser) ?? setGet(userChildren, nearestUser)).push(node.entry.id);
			nextUser = node.entry.id;
		}
		for (const c of orderChildren(node)) walk(c, nextUser);
	})(virtualRoot(roots), ROOT);

	// 4. Nearest user ancestor of the leaf = the "current" turn.
	let currentUserId: string | null = null;
	for (let id = leafId; id; ) {
		const node = byId.get(id);
		if (node && isUserNode(node)) {
			currentUserId = id;
			break;
		}
		id = node?.entry.parentId ?? null;
	}

	// 5. Emit rows via preorder over the user-tree with compact depth AND lane
	//    gutter info (mirrors tree-selector's connector/gutter propagation):
	//    - `rowGutter`: pipes drawn on this node's own row (ancestor branches).
	//    - `connectorCol`: this node's elbow column (branch children only).
	//    - `childGutter`: pipes passed down to descendants; a non-last sibling
	//      adds a pipe at the branch column so the line reaches the last sibling.
	const users: UserNode[] = [];
	const emit = (userId: string, glyphCol: number, rowGutter: number[], connectorCol: number, childGutter: number[], parentSameLane: boolean) => {
		const node = byId.get(userId)!;
		const siblings = userChildren.get(userParent.get(userId) ?? ROOT) ?? [];
		const kids = userChildren.get(userId) ?? [];
		users.push({
			id: userId,
			depth: glyphCol,
			onActivePath: activePath.has(userId),
			isCurrent: userId === currentUserId,
			isLastSibling: siblings[siblings.length - 1] === userId,
			parentSameLane,
			label: node.label,
			preview: previewOf(node.entry),
			segment: collectSegment(node, byId, activePath),
			gutterCols: rowGutter,
			connectorCol,
			descGutterCols: childGutter,
			laneContinues: kids.length >= 1,
		});
		if (kids.length === 1) {
			// Linear continuation: same column, no connector, inherit childGutter.
			emit(kids[0]!, glyphCol, childGutter, -1, childGutter, true);
		} else if (kids.length > 1) {
			const branchCol = glyphCol;
			kids.forEach((kid, i) => {
				const isLast = i === kids.length - 1;
				const kidDesc = isLast ? childGutter : [...childGutter, branchCol];
				emit(kid, glyphCol + 1, childGutter, branchCol, kidDesc, false);
			});
		}
	};
	for (const rootUser of userChildren.get(ROOT) ?? []) emit(rootUser, 0, [], -1, [], false);

	const currentIndex = users.findIndex((u) => u.id === currentUserId);
	return {
		users,
		currentIndex,
		totalUsers: users.length,
		multiRoot: roots.length > 1,
	};
}

/**
 * Collect the assistant/tool entries that make up a user turn's response:
 * walk down the (active-first) child chain until the next user node or a leaf.
 */
function collectSegment(
	userNode: SessionTreeNode,
	byId: Map<string, SessionTreeNode>,
	activePath: Set<string>,
): SegmentEntry[] {
	const pickChild = (node: SessionTreeNode): SessionTreeNode | null => {
		if (node.children.length === 0) return null;
		return node.children.find((c) => activePath.has(c.entry.id)) ?? node.children[0];
	};
	const seg: SegmentEntry[] = [];
	for (let cur = pickChild(userNode); cur && !isUserNode(cur); cur = pickChild(cur)) {
		seg.push({ id: cur.entry.id, kind: segmentKind(cur.entry), preview: previewOf(cur.entry) });
	}
	return seg;
}

// A synthetic parent so multi-root sessions traverse uniformly.
function virtualRoot(roots: SessionTreeNode[]): SessionTreeNode {
	return {
		entry: { type: "custom", id: ROOT, parentId: null, timestamp: "", customType: "tree-nav-root" } as SessionEntry,
		children: roots,
	};
}

function setGet(map: Map<string, string[]>, key: string): string[] {
	const arr: string[] = [];
	map.set(key, arr);
	return arr;
}

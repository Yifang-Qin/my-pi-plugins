// Tree model for the finder (Stage 2 groundwork).
//
// Turns a flat list of repo-relative paths into a directory tree, and flattens
// the tree into visible rows given a set of expanded directories. The overlay
// still runs in flat-list mode (Stage 1); switch it to `buildTree` +
// `flattenVisible` when implementing expand/collapse navigation.
//
// NOTE: expects a files-only path list (as produced by files.ts). Intermediate
// segments are always treated as directories, leaves as files.

export interface TreeNode {
	/** Basename of this node (""; only for the synthetic root). */
	name: string;
	/** Full repo-relative path ("" for the synthetic root). */
	path: string;
	isDir: boolean;
	children: TreeNode[];
}

export interface FlatRow {
	node: TreeNode;
	/** Indentation depth (root children = 0). */
	depth: number;
	hasChildren: boolean;
	expanded: boolean;
}

/** Build a directory tree from repo-relative file paths. */
export function buildTree(paths: string[]): TreeNode {
	const root: TreeNode = { name: "", path: "", isDir: true, children: [] };
	const dirIndex = new Map<string, TreeNode>([["", root]]);

	for (const rel of paths) {
		const parts = rel.split("/").filter(Boolean);
		let parentPath = "";
		for (let i = 0; i < parts.length; i++) {
			const name = parts[i]!;
			const isLeaf = i === parts.length - 1;
			const nodePath = parentPath ? `${parentPath}/${name}` : name;
			let node = dirIndex.get(nodePath);
			if (!node) {
				node = { name, path: nodePath, isDir: !isLeaf, children: [] };
				dirIndex.get(parentPath)!.children.push(node);
				if (node.isDir) dirIndex.set(nodePath, node);
			}
			parentPath = nodePath;
		}
	}

	sortTree(root);
	return root;
}

function sortTree(node: TreeNode): void {
	node.children.sort((a, b) =>
		a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name),
	);
	for (const child of node.children) {
		if (child.isDir) sortTree(child);
	}
}

/** Depth-first flatten of the tree, descending only into expanded directories. */
export function flattenVisible(root: TreeNode, expanded: Set<string>): FlatRow[] {
	const rows: FlatRow[] = [];
	const walk = (node: TreeNode, depth: number): void => {
		for (const child of node.children) {
			const isOpen = expanded.has(child.path);
			rows.push({
				node: child,
				depth,
				hasChildren: child.isDir && child.children.length > 0,
				expanded: isOpen,
			});
			if (child.isDir && isOpen) walk(child, depth + 1);
		}
	};
	walk(root, 0);
	return rows;
}

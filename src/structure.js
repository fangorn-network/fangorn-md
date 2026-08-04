// The sidebar hierarchy is now an EXPLICIT stored tree (server `.tree.json`,
// reordered by drag-and-drop) — not inferred from links. This module holds the
// pure tree transforms the UI needs, plus backlinks (still derived from the
// markdown [[wikilinks]], which are navigation-only now).

/** Reverse the link graph: path → the paths whose markdown links to it. */
export function buildBacklinks(notes) {
    const backlinks = new Map(notes.map((n) => [n.path, []]));
    for (const n of notes) {
        for (const target of n.links ?? []) backlinks.get(target)?.push(n.path);
    }
    return backlinks;
}

/**
 * Depth-first walk of the tree into the row order the Files view renders.
 * Returns [{ path, depth }] — indentation without giving up a flat list, which
 * is what range-selection and "select all" need.
 */
export function flattenTree(tree, depth = 0) {
    return tree.flatMap((n) => [{ path: n.path, depth }, ...flattenTree(n.children, depth + 1)]);
}

/** How many notes hang below `node`. A collapsed row says what it's hiding. */
export const subtreeCount = (node) =>
    node.children.reduce((n, c) => n + 1 + subtreeCount(c), 0);

/**
 * The chain of paths from a root down to `path`, excluding `path` itself, or
 * null if it isn't in the tree. Two jobs: the breadcrumb, and knowing which
 * rows to auto-expand and mark as lineage when a note opens.
 */
export function ancestorsOf(nodes, path, trail = []) {
    for (const n of nodes) {
        if (n.path === path) return trail;
        const hit = ancestorsOf(n.children, path, [...trail, n.path]);
        if (hit) return hit;
    }
    return null;
}

/**
 * Depth-first walk that stops at any node not in `open` — the Home view's row
 * order once folding exists. Same shape as flattenTree, plus what a row needs
 * to draw itself: whether it has children, and how many.
 */
export function foldTree(tree, open, depth = 0) {
    return tree.flatMap((n) => {
        const row = { path: n.path, depth, count: subtreeCount(n), open: open.has(n.path) };
        return row.count > 0 && row.open ? [row, ...foldTree(n.children, open, depth + 1)] : [row];
    });
}

/**
 * The paths between two rows, inclusive, in whatever order they're displayed —
 * shift-click. Either endpoint missing (a filtered-away anchor) yields just the
 * ones that are present.
 */
export function pathsBetween(rows, a, b) {
    const i = rows.findIndex((r) => r.path === a);
    const j = rows.findIndex((r) => r.path === b);
    if (i < 0 || j < 0) return [b, a].filter((p) => rows.some((r) => r.path === p));
    return rows.slice(Math.min(i, j), Math.max(i, j) + 1).map((r) => r.path);
}

// ── Drag-and-drop tree edits (pure) ───────────────────────────────────────────
// Nodes are { path, children: [...] }. Drops are "before" | "after" | "inside".

const clone = (nodes) => nodes.map((n) => ({ path: n.path, children: clone(n.children) }));

// Pull `path`'s node (with its subtree) out of the tree. Returns [tree, node].
function extract(nodes, path) {
    let found = null;
    const walk = (list) =>
        list.filter((n) => {
            if (n.path === path) { found = n; return false; }
            n.children = walk(n.children);
            return true;
        });
    return [walk(nodes), found];
}

const isDescendant = (node, path) =>
    node.children.some((c) => c.path === path || isDescendant(c, path));

/** Move `dragPath` relative to `targetPath`. No-ops on invalid drops. */
export function moveInTree(tree, dragPath, targetPath, pos) {
    if (dragPath === targetPath) return tree;
    const next = clone(tree);
    const dragNode = findNode(next, dragPath);
    // Can't drop a node before/after/inside any of its own descendants.
    if (!dragNode || isDescendant(dragNode, targetPath)) return tree;

    const [pruned, node] = extract(next, dragPath);
    if (!node) return tree;

    if (pos === "inside") {
        const target = findNode(pruned, targetPath);
        if (!target) return tree;
        target.children.push(node);
        return pruned;
    }
    // before / after: splice into the target's sibling list
    const parentList = findParentList(pruned, targetPath);
    if (!parentList) return tree;
    const i = parentList.findIndex((n) => n.path === targetPath);
    parentList.splice(pos === "after" ? i + 1 : i, 0, node);
    return pruned;
}

function findNode(nodes, path) {
    for (const n of nodes) {
        if (n.path === path) return n;
        const hit = findNode(n.children, path);
        if (hit) return hit;
    }
    return null;
}

// The array that directly contains `path` (its siblings), or null.
function findParentList(nodes, path) {
    if (nodes.some((n) => n.path === path)) return nodes;
    for (const n of nodes) {
        const hit = findParentList(n.children, path);
        if (hit) return hit;
    }
    return null;
}

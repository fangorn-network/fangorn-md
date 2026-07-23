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

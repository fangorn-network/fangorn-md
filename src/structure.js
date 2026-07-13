// Infer a filesystem-like structure from the wiki's link graph.
//
// The graph is arbitrary (cycles, multiple in-links), but a sidebar wants a
// tree — so we take the BFS spanning tree rooted at index.md: every note hangs
// under the *shallowest* note that links to it, and children keep the order
// they appear in the parent's text. Notes unreachable from the root are
// grouped separately as orphans. This is pure inference: change the links in
// your markdown and the "filesystem" reorganizes itself.

export function buildTree(notes) {
    const byPath = new Map(notes.map((n) => [n.path, n]));
    const rootPath = byPath.has("index.md") ? "index.md" : notes[0]?.path;
    if (!rootPath) return { root: null, children: new Map(), orphans: [] };

    const children = new Map();
    const visited = new Set([rootPath]);
    const queue = [rootPath];
    while (queue.length > 0) {
        const path = queue.shift();
        const kids = [];
        for (const target of byPath.get(path).links ?? []) {
            if (byPath.has(target) && !visited.has(target)) {
                visited.add(target);
                kids.push(target);
                queue.push(target);
            }
        }
        children.set(path, kids);
    }

    const orphans = notes.map((n) => n.path).filter((p) => !visited.has(p));
    return { root: rootPath, children, orphans };
}

/** Reverse the link graph: path → the paths that link to it. */
export function buildBacklinks(notes) {
    const backlinks = new Map(notes.map((n) => [n.path, []]));
    for (const n of notes) {
        for (const target of n.links ?? []) {
            backlinks.get(target)?.push(n.path);
        }
    }
    return backlinks;
}

import { buildAssetGraph } from "@fangorn-network/sdk";

// ─── Files → graph ────────────────────────────────────────────────────────────
//
// Every publish stages the FULL graph, not a delta. Two properties of Fangorn
// make that the right call:
//
//   1. Vertices are content-addressed: an unchanged payload produces the exact
//      same CID and pail key, so re-staging it is a free no-op. Only notes
//      whose content actually changed cost anything.
//   2. Edges can only reference vertices staged in the same commit() call, so
//      a link from an edited note to an untouched one requires the untouched
//      note to be staged too.
//
// The store is append-only — editing a note ADDS a new version rather than
// replacing the old one. That means the payload itself must carry:
//   - identity  (`path`):      which note is this a version of?
//   - ordering  (`updatedAt`): which version is newest?
//
// `updatedAt` is only re-stamped when content differs from the latest remote
// version, so an untouched note keeps a byte-identical payload (and CID)
// across publishes. Pass the result of `latestByPath` as `remoteLatest`.
//
// EDGES come from the explicit page tree (`.tree.json`), not from markdown
// links: `childrenByPath` maps a note's path → its child paths, and those are
// the only edges published. The tree file itself rides along as a `meta` vertex
// so followers reconstruct the exact hierarchy (order included) on pull.

const stampPayload = (remote, path, content) =>
    remote && remote.payload.content === content
        ? remote.payload
        : { path, content, updatedAt: Date.now() };

export function buildWikiGraph(dir, remoteLatest = new Map(), childrenByPath = new Map()) {
    return buildAssetGraph(dir, {
        processors: {
            ".md": (file) => {
                const content = file.readText();
                const links = (childrenByPath.get(file.name) ?? []).map((p) => p.replace(/\.md$/, ""));
                return { tag: "doc", payload: stampPayload(remoteLatest.get(file.name), file.name, content), links };
            },
            // The tree manifest (.tree.json): a structure-only vertex, no edges.
            ".json": (file) => ({
                tag: "meta",
                payload: stampPayload(remoteLatest.get(file.name), file.name, file.readText()),
                links: [],
            }),
        },
    });
}

// ─── Graph → current state ────────────────────────────────────────────────────

/**
 * Reduce a namespace's full (append-only) vertex list to the latest version of
 * each note: group by `payload.path`, keep the highest `updatedAt` (CID string
 * as a deterministic tie-break). Vertices without a `path` — e.g. published by
 * an older schema — are skipped.
 *
 * @param {{vertices: {cid: string, payload: any}[]}} contents
 * @returns {Map<string, {cid: string, payload: any}>} path → latest vertex
 */
export function latestByPath(contents) {
    const latest = new Map();
    for (const v of contents.vertices) {
        const path = v.payload?.path;
        if (!path) continue;
        const cur = latest.get(path);
        if (!cur || newer(v, cur)) latest.set(path, v);
    }
    return latest;
}

function newer(a, b) {
    const ta = a.payload.updatedAt ?? 0;
    const tb = b.payload.updatedAt ?? 0;
    return ta !== tb ? ta > tb : a.cid > b.cid;
}

/**
 * Project the namespace's edges onto the latest versions: keep only edges
 * whose endpoints are both current, and translate CIDs back to note paths.
 * (Edges to superseded versions are history, not part of the current wiki.)
 */
export function latestEdges(contents, latest) {
    const pathByCid = new Map();
    for (const [path, v] of latest) pathByCid.set(v.cid, path);
    const edges = [];
    for (const e of contents.edges) {
        const from = pathByCid.get(e.sourceCid);
        const to = pathByCid.get(e.targetCid);
        if (from && to) edges.push({ rel: e.relation, from, to });
    }
    return edges;
}

// CLI: node server/graph.js <dir> — print the graph a publish would stage.
if (import.meta.url === `file://${process.argv[1]}`) {
    const dir = process.argv[2] ?? "docs";
    process.stdout.write(JSON.stringify(buildWikiGraph(dir), null, 2) + "\n");
}

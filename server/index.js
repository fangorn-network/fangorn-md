import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, existsSync, watch } from "node:fs";
import { join } from "node:path";
import { Fangorn, FangornConfig, extractMarkdownLinks } from "@fangorn-network/sdk";
import { buildWikiGraph, latestByPath, latestEdges } from "./graph.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = process.cwd();
const DOCS = join(ROOT, "docs");
const REPO_PATH = join(ROOT, ".fangorn", "repo.json");

for (const key of ["ETH_PRIVATE_KEY", "PINATA_JWT", "PINATA_GATEWAY"]) {
    if (!process.env[key]) {
        console.error(`Missing ${key} — copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
}
if (!existsSync(REPO_PATH)) {
    console.error(
        "No .fangorn/repo.json here. Run `pnpm exec fangorn repo init <namespace>` " +
        "to publish your own wiki, or `pnpm exec fangorn clone <owner> <namespace>` " +
        "to follow someone else's.",
    );
    process.exit(1);
}

const fangorn = Fangorn.create({
    privateKey: process.env.ETH_PRIVATE_KEY,
    storage: {
        pinata: {
            jwt: process.env.PINATA_JWT,
            gateway: process.env.PINATA_GATEWAY,
        },
    },
    domain: "localhost",
    config: FangornConfig,
});

// The repo pointer (the analogue of `.git/HEAD` + config): which namespace this
// directory tracks, whose on-chain root it belongs to, and the local tip commit.
const repo = {
    read: () => JSON.parse(readFileSync(REPO_PATH, "utf-8")),
    setHead(cid) {
        const state = this.read();
        state.head = cid;
        writeFileSync(REPO_PATH, JSON.stringify(state, null, 2), "utf-8");
    },
};

// This wallet can only push to its OWN on-chain root. If the repo pointer names
// another owner, we are a reader (clone) — publish is disabled, sync still works.
const isWritable = () =>
    repo.read().owner.toLowerCase() === fangorn.getAddress().toLowerCase();

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Note paths are flat filenames inside docs/ — reject anything else.
const NOTE_PATH = /^[\w][\w .-]*\.md$/;
function assertNotePath(path) {
    if (!NOTE_PATH.test(path)) throw new HttpError(400, `invalid note path: ${path}`);
}

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

const bigintReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, bigintReplacer));
}

function readJson(req) {
    return new Promise((resolve, reject) => {
        let data = "";
        req.on("data", (c) => (data += c));
        req.on("end", () => {
            try {
                resolve(data ? JSON.parse(data) : {});
            } catch {
                reject(new HttpError(400, "invalid JSON body"));
            }
        });
        req.on("error", reject);
    });
}

const firstHeading = (content, fallback) =>
    content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;

// Reading the namespace means walking the pail tree from the owner's on-chain
// root — dozens of *sequential* IPFS-gateway fetches, and by far the slowest
// thing this server does. The walk is fully determined by the on-chain tip,
// so cache it keyed by that tip: one cheap RPC read per call decides whether
// the cached walk is still current. After our own publish the re-walk is
// nearly free too — every block a commit stages is already in the SDK's
// in-process block cache.
let remoteCache = null; // { tip, contents }

async function remoteState() {
    const { namespace, owner } = repo.read();
    const tip = await fangorn.onChainTip(owner);
    if (!remoteCache || remoteCache.tip !== tip) {
        const started = Date.now();
        // `inspectNamespace` is the self-owned shorthand; `engine.listNamespace`
        // takes an explicit publisher, so it also works for cloned repos.
        const contents = await fangorn.engine.listNamespace(namespace, owner);
        remoteCache = { tip, contents };
        console.log(`[remote] walked ${contents.vertices.length} vertices / ${contents.edges.length} edges in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    return { tip, contents: remoteCache.contents, latest: latestByPath(remoteCache.contents) };
}

// ─── Live events (SSE) ────────────────────────────────────────────────────────
//
// The browser holds one EventSource on /api/events. Two things flow through it:
//   - "local-change":  a file in docs/ changed on disk (any editor, any process)
//   - "remote-change": the namespace owner pushed a new commit on-chain,
//                      bridged straight from `fangorn.subscribe`
//
// The on-chain watch is a light client — it polls the registry contract for
// StateCommitted events and diffs pail roots itself, no indexer. We only keep
// it running while someone is actually listening.

const sseClients = new Set();
let subscribeAbort = null;

function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data, bigintReplacer)}\n\n`;
    for (const res of sseClients) res.write(frame);
}

function ensureSubscribed() {
    if (subscribeAbort) return;
    const { namespace, owner } = repo.read();
    subscribeAbort = new AbortController();
    const { signal } = subscribeAbort;
    (async () => {
        try {
            for await (const change of fangorn.subscribe({ namespace, owner, signal })) {
                broadcast("remote-change", change);
            }
        } catch (err) {
            if (!signal.aborted) console.error("subscribe failed:", err.message);
        } finally {
            subscribeAbort = null;
        }
    })();
}

function handleEvents(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    ensureSubscribed();

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        if (sseClients.size === 0) subscribeAbort?.abort();
    });
}

// Surface out-of-band edits to docs/ (vim, git checkout, a pull below...).
let watchDebounce = null;
watch(DOCS, () => {
    clearTimeout(watchDebounce);
    watchDebounce = setTimeout(() => broadcast("local-change", {}), 200);
});

// ─── Routes ───────────────────────────────────────────────────────────────────

const routes = {
    "GET /api/repo": async () => {
        const state = repo.read();
        return { ...state, address: fangorn.getAddress(), writable: isWritable() };
    },

    // Notes plus their outgoing links — the same edge data a publish stages,
    // in document order, so the client can infer the wiki's structure from it.
    "GET /api/notes": async () => {
        const paths = readdirSync(DOCS).filter((f) => f.endsWith(".md"));
        const known = new Set(paths);
        const notes = paths.map((path) => {
            const content = readFileSync(join(DOCS, path), "utf-8");
            const links = [...new Set(extractMarkdownLinks(content).map((id) => `${id}.md`))]
                .filter((target) => target !== path && known.has(target));
            return { path, title: firstHeading(content, path.replace(/\.md$/, "")), links };
        });
        return { notes };
    },

    "GET /api/notes/:path": async ({ path }) => {
        const file = join(DOCS, path);
        if (!existsSync(file)) throw new HttpError(404, `no such note: ${path}`);
        return { path, content: readFileSync(file, "utf-8") };
    },

    "PUT /api/notes/:path": async ({ path, body }) => {
        if (typeof body.content !== "string") throw new HttpError(400, "content required");
        writeFileSync(join(DOCS, path), body.content, "utf-8");
        return { path, saved: true };
    },

    // What the network sees: the latest version of every note plus the link
    // graph between them, reduced from the namespace's append-only history.
    "GET /api/remote": async () => {
        const { contents, latest } = await remoteState();
        const notes = [...latest.entries()].map(([path, v]) => ({
            path,
            cid: v.cid,
            title: firstHeading(v.payload.content, path.replace(/\.md$/, "")),
            updatedAt: v.payload.updatedAt ?? null,
        }));
        return { notes, edges: latestEdges(contents, latest) };
    },

    // Materialize the remote state into docs/ — the "git pull". Only writes
    // files whose content differs; never deletes local files.
    "POST /api/pull": async () => {
        const { latest } = await remoteState();
        const written = [];
        for (const [path, v] of latest) {
            assertNotePath(path);
            const file = join(DOCS, path);
            if (existsSync(file) && readFileSync(file, "utf-8") === v.payload.content) continue;
            writeFileSync(file, v.payload.content, "utf-8");
            written.push(path);
        }
        return { written };
    },

    // Snapshot docs/ into a commit and settle it on-chain — the "git commit && git push".
    "POST /api/publish": async ({ body }) => {
        if (!isWritable()) {
            throw new HttpError(403,
                "this repo tracks someone else's namespace — you can read and sync, but only " +
                "the owner's wallet can push. Re-init under your own address to fork it.");
        }
        const { namespace, head } = repo.read();
        const t0 = Date.now();
        const { tip, latest } = await remoteState();
        const graph = buildWikiGraph(DOCS, latest);
        if (graph.vertices.length === 0) throw new HttpError(400, "docs/ has no markdown files");
        const tRead = Date.now();

        // Parent on the on-chain tip, not the local head: a publisher's root
        // spans ALL of its namespaces, so building on anything older would
        // drop sibling namespaces' recent state when this commit settles.
        const commit = await fangorn.commit({
            namespace,
            vertices: graph.vertices,
            edges: graph.edges,
            parent: tip ?? head ?? undefined,
            message: body.message || "update wiki",
        });
        const tCommit = Date.now();
        const { txHash, onChainTip } = await fangorn.push(commit.commitCid);
        remoteCache = null; // next read re-walks the new tip (cheap — blocks are in-process)
        repo.setHead(commit.commitCid);

        const timings = { readMs: tRead - t0, commitMs: tCommit - tRead, pushMs: Date.now() - tCommit };
        console.log(`[publish] read ${(timings.readMs / 1000).toFixed(1)}s · commit+flush ${(timings.commitMs / 1000).toFixed(1)}s · push ${(timings.pushMs / 1000).toFixed(1)}s`);
        return {
            commitCid: commit.commitCid,
            txHash,
            onChainTip,
            staged: { vertices: graph.vertices.length, edges: graph.edges.length },
            timings,
        };
    },

    "GET /api/history": async () => {
        const { head } = repo.read();
        if (!head) return { commits: [] };
        const commits = [];
        for await (const c of fangorn.log(head, 50)) commits.push(c);
        return { commits };
    },
};

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/events") return handleEvents(res);

    // Match "<METHOD> /api/notes/<path>" routes by collapsing the note path
    // into a `:path` param; everything else matches literally.
    let key = `${req.method} ${url.pathname}`;
    const params = {};
    const noteMatch = url.pathname.match(/^\/api\/notes\/(.+)$/);
    if (noteMatch) {
        params.path = decodeURIComponent(noteMatch[1]);
        key = `${req.method} /api/notes/:path`;
    }

    const handler = routes[key];
    if (!handler) return sendJson(res, 404, { error: `no route: ${key}` });

    try {
        if (params.path) assertNotePath(params.path);
        if (req.method === "PUT" || req.method === "POST") params.body = await readJson(req);
        sendJson(res, 200, await handler(params));
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        sendJson(res, status, { error: err.message });
    }
});

server.listen(PORT, () => {
    const { namespace, owner } = repo.read();
    console.log(`fangornmd server → http://localhost:${PORT}`);
    console.log(`  namespace: ${namespace}`);
    console.log(`  owner:     ${owner}`);
    console.log(`  wallet:    ${fangorn.getAddress()} ${isWritable() ? "(writable)" : "(read-only)"}`);

    // Warm the remote-state cache in the background so the first publish/pull
    // doesn't pay for the cold gateway walk.
    remoteState()
        .then(({ latest }) => console.log(`[remote] cache warmed — ${latest.size} note(s) at tip`))
        .catch((err) => console.warn(`[remote] cache warm failed (will retry on demand): ${err.message}`));
});

import { createServer } from "node:http";
import {
    readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, watch,
} from "node:fs";
import { join, extname, normalize } from "node:path";
import { Fangorn, FangornConfig, extractMarkdownLinks } from "@fangorn-network/sdk";
import { buildWikiGraph, latestByPath, latestEdges } from "./graph.js";
import { sealContent, unsealContent } from "./crypto.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = process.cwd();
const DOCS_ROOT = join(ROOT, "docs");
const REPOS_PATH = join(ROOT, ".fangorn", "repos.json");
const LEGACY_PATH = join(ROOT, ".fangorn", "repo.json");

for (const key of ["ETH_PRIVATE_KEY", "PINATA_JWT", "PINATA_GATEWAY"]) {
    if (!process.env[key]) {
        console.error(`Missing ${key} — copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
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

// ─── Repo store ─────────────────────────────────────────────────────────────
//
// One publisher's on-chain root spans ALL its namespaces, so this app can track
// several Fangorn repos at once. `.fangorn/repos.json` is the analogue of a
// multi-remote `.git/config` + HEAD: for each namespace we remember whose root
// it belongs to, its local tip commit, whether we encrypt it (private), and
// which subfolder holds its working tree. Repos owned by other addresses are
// read-only follows — reading and subscribing need no permission from anyone.

const relDir = (namespace) => `docs/${namespace}`;

function migrateLegacy() {
    // First boot after the multi-repo upgrade: wrap the single repo.json into
    // repos.json and move its flat docs/*.md into docs/<namespace>/.
    const legacy = JSON.parse(readFileSync(LEGACY_PATH, "utf-8"));
    const ns = legacy.namespace;
    const dir = relDir(ns);
    const abs = join(ROOT, dir);
    if (!existsSync(abs)) {
        mkdirSync(abs, { recursive: true });
        for (const f of readdirSync(DOCS_ROOT).filter((f) => f.endsWith(".md"))) {
            renameSync(join(DOCS_ROOT, f), join(abs, f));
        }
    }
    const store = {
        active: ns,
        repos: {
            [ns]: { namespace: ns, owner: legacy.owner, head: legacy.head ?? null, visibility: "public", dir },
        },
    };
    writeFileSync(REPOS_PATH, JSON.stringify(store, null, 2), "utf-8");
    console.log(`[migrate] repo.json → repos.json; moved docs/*.md into ${dir}/`);
}

if (!existsSync(REPOS_PATH)) {
    if (existsSync(LEGACY_PATH)) migrateLegacy();
    else {
        console.error(
            "No .fangorn/repos.json here. Run `pnpm exec fangorn repo init <namespace>` " +
            "then start again, or create a repo from the UI once the server is up.",
        );
        process.exit(1);
    }
}

const store = {
    read: () => JSON.parse(readFileSync(REPOS_PATH, "utf-8")),
    write(next) {
        writeFileSync(REPOS_PATH, JSON.stringify(next, null, 2), "utf-8");
    },
    list() {
        return Object.values(this.read().repos);
    },
    get(namespace) {
        const repo = this.read().repos[namespace];
        if (!repo) throw new HttpError(404, `no such repo: ${namespace}`);
        return repo;
    },
    active() {
        const s = this.read();
        return this.get(s.active);
    },
    setActive(namespace) {
        const s = this.read();
        this.get(namespace); // existence check
        s.active = namespace;
        this.write(s);
    },
    setHead(namespace, cid) {
        const s = this.read();
        s.repos[namespace].head = cid;
        this.write(s);
    },
    add(repo) {
        const s = this.read();
        s.repos[repo.namespace] = repo;
        s.active = repo.namespace;
        this.write(s);
    },
};

// We can only push to our OWN on-chain root. A repo tracking another owner is a
// read-only follow — reads and sync still work, publish is refused.
const writable = (repo) =>
    repo.owner.toLowerCase() === fangorn.getAddress().toLowerCase();

const docsDir = (repo) => join(ROOT, repo.dir);
const publicRepo = (repo) => ({ ...repo, writable: writable(repo) });

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Note paths are flat filenames inside a repo dir — reject anything else.
const NOTE_PATH = /^[\w][\w .-]*\.md$/;
// A namespace is a single on-chain key segment: keep it filesystem-safe.
const NAMESPACE = /^[\w][\w.-]{0,63}$/;
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

// A private repo stores `enc` (hex ciphertext) instead of `content`. Only the
// owner can decrypt; a follower without the key sees a placeholder. Returns a
// shallow-cloned vertex whose payload always has a usable `content`, so the
// rest of the pipeline (latestByPath / firstHeading) stays oblivious to
// encryption.
function decodeVertex(repo, v) {
    const p = v.payload ?? {};
    if (p.enc === undefined) return v;
    let content;
    try {
        content = unsealContent(repo.namespace, p.path, p.enc);
    } catch {
        content = "🔒 (encrypted — you don't hold the key for this repo)";
    }
    return { ...v, payload: { ...p, content } };
}

// Reading a namespace means walking the pail tree from the owner's on-chain
// root — dozens of *sequential* IPFS-gateway fetches, and by far the slowest
// thing this server does. The walk is fully determined by the on-chain tip, so
// cache it per namespace keyed by that tip: one cheap RPC read per call decides
// whether the cached walk is still current.
const remoteCache = new Map(); // namespace → { tip, contents }

async function remoteState(repo) {
    const tip = await fangorn.onChainTip(repo.owner);
    const cached = remoteCache.get(repo.namespace);
    if (!cached || cached.tip !== tip) {
        const started = Date.now();
        // listNamespace takes an explicit publisher, so it works for follows too.
        const raw = await fangorn.engine.listNamespace(repo.namespace, repo.owner);
        const contents = { ...raw, vertices: raw.vertices.map((v) => decodeVertex(repo, v)) };
        remoteCache.set(repo.namespace, { tip, contents });
        console.log(`[remote:${repo.namespace}] walked ${contents.vertices.length} vertices / ${contents.edges.length} edges in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const contents = remoteCache.get(repo.namespace).contents;
    return { tip, contents, latest: latestByPath(contents) };
}

// ─── Live events (SSE) ────────────────────────────────────────────────────────
//
// The browser holds one EventSource on /api/events. Three things flow through:
//   - "local-change":  a file in the ACTIVE repo's dir changed on disk
//   - "remote-change": some tracked owner pushed a new commit on-chain, tagged
//                      with the affected `namespace`
//
// The on-chain watch is a light client (polls StateCommitted, diffs pail roots,
// no indexer). We keep one subscription PER TRACKED REPO while anyone listens.

const sseClients = new Set();
const subscriptions = new Map(); // namespace → AbortController

function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data, bigintReplacer)}\n\n`;
    for (const res of sseClients) res.write(frame);
}

function watchRepo(repo) {
    if (subscriptions.has(repo.namespace)) return;
    const abort = new AbortController();
    subscriptions.set(repo.namespace, abort);
    const { signal } = abort;
    (async () => {
        try {
            for await (const change of fangorn.subscribe({ namespace: repo.namespace, owner: repo.owner, signal })) {
                remoteCache.delete(repo.namespace); // tip moved — re-walk on next read
                broadcast("remote-change", { ...change, namespace: repo.namespace });
            }
        } catch (err) {
            if (!signal.aborted) console.error(`subscribe(${repo.namespace}) failed:`, err.message);
        } finally {
            if (subscriptions.get(repo.namespace) === abort) subscriptions.delete(repo.namespace);
        }
    })();
}

// Ensure exactly the tracked repos are being watched (called on connect and
// whenever the repo set changes).
function syncSubscriptions() {
    if (sseClients.size === 0) return;
    for (const repo of store.list()) watchRepo(repo);
}

function stopAllSubscriptions() {
    for (const abort of subscriptions.values()) abort.abort();
    subscriptions.clear();
}

function handleEvents(res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write("retry: 3000\n\n");
    sseClients.add(res);
    syncSubscriptions();

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    res.on("close", () => {
        clearInterval(heartbeat);
        sseClients.delete(res);
        if (sseClients.size === 0) stopAllSubscriptions();
    });
}

// Surface out-of-band edits to the active repo's dir (vim, git checkout, a pull
// below...). Re-armed whenever the active repo changes.
let docsWatcher = null;
let watchDebounce = null;
function watchActiveDocs() {
    docsWatcher?.close();
    const dir = docsDir(store.active());
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    docsWatcher = watch(dir, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(() => broadcast("local-change", {}), 200);
    });
}

// ─── Routes ───────────────────────────────────────────────────────────────────

const routes = {
    // ── Repo management ──
    "GET /api/repos": async () => {
        const s = store.read();
        return { active: s.active, address: fangorn.getAddress(), repos: store.list().map(publicRepo) };
    },

    // The active repo, shaped like the old /api/repo response for the frontend.
    "GET /api/repo": async () => publicRepo(store.active()),

    // Allocate a namespace on our own on-chain root and start tracking it.
    "POST /api/repos": async ({ body }) => {
        const namespace = String(body.namespace ?? "").trim();
        if (!NAMESPACE.test(namespace)) throw new HttpError(400, "invalid namespace");
        if (store.read().repos[namespace]) throw new HttpError(409, `already tracking ${namespace}`);
        const visibility = body.visibility === "private" ? "private" : "public";

        await fangorn.initRepo(namespace); // idempotent on-chain allocation
        const dir = relDir(namespace);
        const abs = join(ROOT, dir);
        mkdirSync(abs, { recursive: true });
        const index = join(abs, "index.md");
        if (!existsSync(index)) writeFileSync(index, `# ${namespace}\n\nWelcome to your new repo.\n`, "utf-8");

        store.add({ namespace, owner: fangorn.getAddress(), head: null, visibility, dir });
        watchActiveDocs();
        syncSubscriptions();
        return publicRepo(store.active());
    },

    // Track someone else's published namespace read-only (owner + namespace is a
    // full address). No objects are downloaded — reads resolve from IPFS by CID.
    "POST /api/repos/follow": async ({ body }) => {
        const namespace = String(body.namespace ?? "").trim();
        const owner = String(body.owner ?? "").trim();
        if (!NAMESPACE.test(namespace)) throw new HttpError(400, "invalid namespace");
        if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new HttpError(400, "invalid owner address");
        if (store.read().repos[namespace]) throw new HttpError(409, `already tracking ${namespace}`);

        const head = await fangorn.onChainTip(owner);
        const dir = relDir(namespace);
        mkdirSync(join(ROOT, dir), { recursive: true });
        store.add({ namespace, owner, head, visibility: "public", dir });
        watchActiveDocs();
        syncSubscriptions();
        return publicRepo(store.active());
    },

    "POST /api/repos/active": async ({ body }) => {
        store.setActive(String(body.namespace ?? ""));
        watchActiveDocs();
        return publicRepo(store.active());
    },

    // ── Notes (operate on the active repo's dir) ──
    "GET /api/notes": async () => {
        const dir = docsDir(store.active());
        const paths = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
        const known = new Set(paths);
        const notes = paths.map((path) => {
            const content = readFileSync(join(dir, path), "utf-8");
            const links = [...new Set(extractMarkdownLinks(content).map((id) => `${id}.md`))]
                .filter((target) => target !== path && known.has(target));
            return { path, title: firstHeading(content, path.replace(/\.md$/, "")), links };
        });
        return { notes };
    },

    "GET /api/notes/:path": async ({ path }) => {
        const file = join(docsDir(store.active()), path);
        if (!existsSync(file)) throw new HttpError(404, `no such note: ${path}`);
        return { path, content: readFileSync(file, "utf-8") };
    },

    "PUT /api/notes/:path": async ({ path, body }) => {
        if (typeof body.content !== "string") throw new HttpError(400, "content required");
        const dir = docsDir(store.active());
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, path), body.content, "utf-8");
        return { path, saved: true };
    },

    // What the network sees for the active repo: latest version of every note
    // plus the link graph, reduced from the namespace's append-only history.
    "GET /api/remote": async () => {
        const repo = store.active();
        const { contents, latest } = await remoteState(repo);
        const notes = [...latest.entries()].map(([path, v]) => ({
            path,
            cid: v.cid,
            title: firstHeading(v.payload.content, path.replace(/\.md$/, "")),
            updatedAt: v.payload.updatedAt ?? null,
        }));
        return { notes, edges: latestEdges(contents, latest) };
    },

    // Materialize remote state into the active repo's dir — the "git pull".
    "POST /api/pull": async () => {
        const repo = store.active();
        const { latest } = await remoteState(repo);
        const dir = docsDir(repo);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const written = [];
        for (const [path, v] of latest) {
            assertNotePath(path);
            const file = join(dir, path);
            if (existsSync(file) && readFileSync(file, "utf-8") === v.payload.content) continue;
            writeFileSync(file, v.payload.content, "utf-8");
            written.push(path);
        }
        return { written };
    },

    // Snapshot the active repo's dir into a commit and settle it — "commit && push".
    "POST /api/publish": async ({ body }) => {
        const repo = store.active();
        if (!writable(repo)) {
            throw new HttpError(403,
                "this repo tracks someone else's namespace — you can read and sync, but only " +
                "the owner's wallet can push. Create a repo under your own address to publish.");
        }
        const t0 = Date.now();
        const { tip, latest } = await remoteState(repo);
        const graph = buildWikiGraph(docsDir(repo), latest);
        if (graph.vertices.length === 0) throw new HttpError(400, `${repo.dir}/ has no markdown files`);

        // Private repo: seal each note's content before it leaves this machine.
        // path + updatedAt stay clear (identity/ordering); content becomes `enc`.
        // buildWikiGraph reuses the (decrypted) remote payload verbatim when a
        // note is unchanged — so a payload that already carries `enc` is
        // untouched: keep that ciphertext (stable CID, no re-upload) and only
        // seal notes whose content actually changed. Sealing is non-determin-
        // istic (random nonce), so re-sealing an unchanged note would needlessly
        // churn its CID every publish.
        if (repo.visibility === "private") {
            for (const v of graph.vertices) {
                const { content, ...rest } = v.payload; // rest: {path, updatedAt, [enc]}
                v.payload = rest.enc !== undefined
                    ? rest
                    : { ...rest, enc: sealContent(repo.namespace, rest.path, content) };
            }
        }
        const tRead = Date.now();

        // Parent on the on-chain tip, not the local head: a publisher's root
        // spans ALL of its namespaces, so building on anything older would drop
        // sibling namespaces' recent state when this commit settles.
        const commit = await fangorn.commit({
            namespace: repo.namespace,
            vertices: graph.vertices,
            edges: graph.edges,
            parent: tip ?? repo.head ?? undefined,
            message: body.message || "update wiki",
        });
        const tCommit = Date.now();
        const { txHash, onChainTip } = await fangorn.push(commit.commitCid);
        remoteCache.delete(repo.namespace); // re-walk the new tip (cheap — blocks cached)
        store.setHead(repo.namespace, commit.commitCid);

        const timings = { readMs: tRead - t0, commitMs: tCommit - tRead, pushMs: Date.now() - tCommit };
        console.log(`[publish:${repo.namespace}] read ${(timings.readMs / 1000).toFixed(1)}s · commit+flush ${(timings.commitMs / 1000).toFixed(1)}s · push ${(timings.pushMs / 1000).toFixed(1)}s`);
        return {
            commitCid: commit.commitCid,
            txHash,
            onChainTip,
            visibility: repo.visibility,
            staged: { vertices: graph.vertices.length, edges: graph.edges.length },
            timings,
        };
    },

    "GET /api/history": async () => {
        const { head } = store.active();
        if (!head) return { commits: [] };
        const commits = [];
        for await (const c of fangorn.log(head, 50)) commits.push(c);
        return { commits };
    },
};

// ─── Static SPA (production) ────────────────────────────────────────────────
//
// In dev the Vite server serves the frontend and proxies /api here. In a built
// image there is no Vite: serve dist/ ourselves and fall back to index.html so
// client-side routing works. No-op if dist/ was never built (dev runs).

const DIST = join(ROOT, "dist");
const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};

function serveStatic(res, pathname) {
    if (!existsSync(DIST)) return sendJson(res, 404, { error: "no dist/ — run `vite build`" });
    // Resolve within DIST; anything escaping it or missing falls back to the SPA shell.
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel);
    if (!file.startsWith(DIST) || !existsSync(file) || pathname === "/") file = join(DIST, "index.html");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/events") return handleEvents(res);
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

    // Collapse "<METHOD> /api/notes/<path>" into a :path param; else match literally.
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
    const active = store.active();
    console.log(`fangornmd server → http://localhost:${PORT}`);
    console.log(`  tracking:  ${store.list().map((r) => r.namespace).join(", ")}`);
    console.log(`  active:    ${active.namespace} (${active.visibility}) ${writable(active) ? "(writable)" : "(read-only)"}`);
    console.log(`  wallet:    ${fangorn.getAddress()}`);
    watchActiveDocs();

    // Warm the active repo's remote-state cache so the first publish/pull
    // doesn't pay for the cold gateway walk.
    remoteState(active)
        .then(({ latest }) => console.log(`[remote:${active.namespace}] cache warmed — ${latest.size} note(s) at tip`))
        .catch((err) => console.warn(`[remote:${active.namespace}] cache warm failed (will retry on demand): ${err.message}`));
});

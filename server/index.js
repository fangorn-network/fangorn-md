import { createServer } from "node:http";
import {
    readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, watch, rmSync, renameSync,
} from "node:fs";
import { join, extname, normalize } from "node:path";
import { Fangorn, FangornConfig, extractMarkdownLinks } from "@fangorn-network/sdk";
import { createPublicClient, http, encodeFunctionData, toHex } from "viem";
import { CID } from "multiformats/cid";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { WebSocketServer } from "ws";
import { setupWSConnection, setPersistence, docs as yRooms } from "@y/websocket-server/utils";
import * as Y from "yjs";
import { docMarkdown, seedFromMarkdown, isReadFrame } from "./ydoc.js";
import { buildWikiGraph, latestByPath, latestEdges } from "./graph.js";

// ─── Config ───────────────────────────────────────────────────────────────────
//
// This server is now a MULTI-TENANT RELAY, not a wallet. It holds NO user key.
// Each user is a Privy wallet address (asserted per-request, proven on-chain at
// settle time). The server's own ETH_PRIVATE_KEY is a SERVICE key used only to
// construct the keyless engine (reads, graph build, IPFS pinning) — it never
// signs a user's on-chain settlement. That single tx is sent by the user's
// browser wallet; see /api/publish/prepare + /api/settle below.

const PORT = Number(process.env.PORT ?? 8787);
const ROOT = process.cwd();
// Persistent state (working trees + repo store) lives under DATA_DIR so a deploy
// can put it on one mounted volume; defaults to cwd for local/dev. The built SPA
// (dist/) stays under ROOT — it ships in the image, not the volume.
const DATA_DIR = process.env.DATA_DIR ?? ROOT;
const USERS_DIR = join(DATA_DIR, ".fangorn", "users");
const PRIVY_APP_ID = process.env.PRIVY_APP_ID ?? process.env.VITE_PRIVY_APP_ID;

for (const key of ["ETH_PRIVATE_KEY", "PINATA_JWT", "PINATA_GATEWAY"]) {
    if (!process.env[key]) {
        console.error(`Missing ${key} — copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
}
if (!PRIVY_APP_ID) {
    console.error("Missing VITE_PRIVY_APP_ID — needed to verify Privy login tokens.");
    process.exit(1);
}

const fangorn = Fangorn.create({
    privateKey: process.env.ETH_PRIVATE_KEY, // service key: engine construction + Pinata only
    storage: { pinata: { jwt: process.env.PINATA_JWT, gateway: process.env.PINATA_GATEWAY } },
    domain: "localhost",
    config: FangornConfig,
});

// Direct chain reads (current root) + the one tx the browser will sign.
const REGISTRY = FangornConfig.dataRegistryContractAddress;
const CHAIN = FangornConfig.chain;
const ZERO_BYTES32 = `0x${"0".repeat(64)}`;
const publicClient = createPublicClient({ chain: CHAIN, transport: http(FangornConfig.rpcUrl) });
const REGISTRY_ABI = [
    { type: "function", name: "getNamespaceHead", stateMutability: "view", inputs: [{ name: "publisher", type: "address" }], outputs: [{ type: "bytes32" }] },
    { type: "function", name: "commitStateRoot", stateMutability: "nonpayable", inputs: [{ name: "old_root", type: "bytes32" }, { name: "new_root", type: "bytes32" }], outputs: [] },
];

const readNamespaceHead = (owner) =>
    publicClient.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "getNamespaceHead", args: [owner] });
// The on-chain root hex is exactly the commit CID's multihash digest (see the
// SDK's pushCommit) — so a settlement tx is commitStateRoot(currentRoot, newRoot).
const rootHexFromCid = (cid) => `0x${Buffer.from(CID.parse(cid).multihash.digest).toString("hex")}`;

// ─── Auth (Privy) ───────────────────────────────────────────────────────────
//
// The access token proves a live Privy session (gates the service). The wallet
// ADDRESS is asserted by the client — that's safe because it's the settlement
// tx, signed by the actual wallet, that authenticates a publish on-chain: you
// can build/stage under any address, but you can only SETTLE from the wallet you
// hold. (Binding address→DID server-side would need the Privy app secret + API;
// tracked as a hardening step.)

const JWKS = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${PRIVY_APP_ID}/jwks.json`));

class HttpError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

async function authenticate(token, assertedAddress) {
    if (!token) throw new HttpError(401, "missing auth token");
    try {
        await jwtVerify(token, JWKS, { issuer: "privy.io", audience: PRIVY_APP_ID });
    } catch {
        throw new HttpError(401, "invalid auth token");
    }
    const address = String(assertedAddress ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new HttpError(400, "missing or invalid X-Wallet-Address");
    return address;
}

// ─── Per-user repo store ────────────────────────────────────────────────────
//
// One file per user at .fangorn/users/<address>.json — no shared mutable state
// between users. Same shape as the old repos.json: { active, repos: { ns → … } }.
// A repo is (owner, namespace).
//
// COLLABORATION. The owner's repo record carries `collaborators: [address]`.
// That list is the single source of truth — everyone else's store just points at
// (owner, namespace), so permission questions are answered by reading the
// OWNER's file, never by copying the grant around.
//
// A collaborator works IN THE OWNER'S DIRECTORY: same files, same sidebar, same
// .tree.json. That's the whole trick. Giving each collaborator their own copy
// (what a plain follow does) means a friend's edits never reach the tree the
// owner publishes — the owner would have to have every note open for the CRDT
// to carry them across. One shared tree makes "the owner publishes what we all
// wrote" true by construction. Read-only followers keep their own pulled copy.

const relDir = (address, namespace) => `docs/${address}/${namespace}`;
const userFile = (address) => join(USERS_DIR, `${address}.json`);
const readUserState = (address) => {
    try { return JSON.parse(readFileSync(userFile(address), "utf-8")); }
    catch { return { active: null, repos: {} }; }
};
const collaboratorsOf = (owner, namespace) => readUserState(owner).repos?.[namespace]?.collaborators ?? [];
// Edit rights = working-tree rights. Publishing stays owner-only everywhere.
const canEdit = (repo, address) => repo.owner === address || collaboratorsOf(repo.owner, repo.namespace).includes(address);

function userStore(address) {
    const file = userFile(address);
    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : { active: null, repos: {} });
    const write = (s) => writeFileSync(file, JSON.stringify(s, null, 2), "utf-8");
    // Point editors at the owner's tree; leave read-only followers on their own.
    const resolve = (r) => (r && canEdit(r, address) ? { ...r, dir: relDir(r.owner, r.namespace) } : r);
    return {
        read,
        list: () => Object.values(read().repos).map(resolve),
        get(ns) { const r = read().repos[ns]; if (!r) throw new HttpError(404, `no such repo: ${ns}`); return resolve(r); },
        activeOrNull() { const s = read(); return s.active ? resolve(s.repos[s.active]) : null; },
        active() { const r = this.activeOrNull(); if (!r) throw new HttpError(404, "no active repo — create one first"); return r; },
        setActive(ns) { const s = read(); if (!s.repos[ns]) throw new HttpError(404, `no such repo: ${ns}`); s.active = ns; write(s); },
        setHead(ns, cid) { const s = read(); s.repos[ns].head = cid; write(s); },
        add(repo) { const s = read(); s.repos[repo.namespace] = repo; s.active = repo.namespace; write(s); },
        setCollaborators(ns, list) {
            const s = read();
            if (!s.repos[ns]) throw new HttpError(404, `no such repo: ${ns}`);
            if (s.repos[ns].owner !== address) throw new HttpError(403, "not your repo");
            s.repos[ns].collaborators = list;
            write(s);
        },
    };
}

const docsDir = (repo) => join(DATA_DIR, repo.dir);
// `writable` = may edit the working tree (owner or collaborator).
// `isOwner`  = may publish on-chain and manage the collaborator list.
const publicRepo = (repo, address) => ({
    ...repo,
    writable: canEdit(repo, address),
    isOwner: repo.owner === address,
    collaborators: collaboratorsOf(repo.owner, repo.namespace),
});

// ─── Explicit page tree ───────────────────────────────────────────────────────
//
// The sidebar hierarchy is stored, not inferred: `.tree.json` inside the repo
// dir holds an ordered, nested [{path, children:[…]}] structure. Drag-and-drop
// rewrites it (PUT /api/tree); Publish derives the graph's edges from it (parent
// → child). It rides the dir scan like any note, so it publishes and pulls for
// free — followers get the exact hierarchy. Markdown [[links]] are navigation
// only now and no longer define structure.

const TREE_FILE = ".tree.json";
const treePath = (repo) => join(docsDir(repo), TREE_FILE);

// Read the stored tree, reconciled against the .md files actually on disk: drop
// nodes whose file is gone (or duplicated), append new files as unfiled roots.
// Returns { tree, childrenByPath } without writing — callers persist explicitly.
function reconcileTree(repo) {
    const dir = docsDir(repo);
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
    const present = new Set(files);
    let stored = [];
    try { stored = existsSync(treePath(repo)) ? JSON.parse(readFileSync(treePath(repo), "utf-8")) : []; } catch { stored = []; }

    const seen = new Set();
    const prune = (nodes) =>
        (Array.isArray(nodes) ? nodes : [])
            .filter((n) => n && present.has(n.path) && !seen.has(n.path))
            .map((n) => { seen.add(n.path); return { path: n.path, children: prune(n.children) }; });
    const tree = prune(stored);
    for (const f of files) if (!seen.has(f)) tree.push({ path: f, children: [] });

    const childrenByPath = new Map();
    const walk = (nodes) => { for (const n of nodes) { childrenByPath.set(n.path, n.children.map((c) => c.path)); walk(n.children); } };
    walk(tree);
    return { tree, childrenByPath };
}

const writeTree = (repo, tree) => writeFileSync(treePath(repo), JSON.stringify(tree, null, 2), "utf-8");
// Rename a note's path everywhere it appears in the stored tree.
const renameInTree = (tree, from, to) =>
    tree.map((n) => ({ path: n.path === from ? to : n.path, children: renameInTree(n.children, from, to) }));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOTE_PATH = /^[\w][\w .-]*\.md$/;
const NAMESPACE = /^[\w][\w.-]{0,63}$/;
function assertNotePath(path) {
    if (!NOTE_PATH.test(path)) throw new HttpError(400, `invalid note path: ${path}`);
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
        req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new HttpError(400, "invalid JSON body")); } });
        req.on("error", reject);
    });
}

const firstHeading = (content, fallback) => content?.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;

const indexBoilerplate = (namespace) => `# ${namespace}

Welcome to your new wiki. This note is **index.md** — the root of your tree.

## Getting started

- Just write — markdown renders as you type, and changes autosave.
- Add pages with **+**, then **drag them in the sidebar** to nest and reorder.
  That hierarchy is what gets published — no link-wrangling required.
- Hover a page in the sidebar to **rename** (✎) or **delete** (✕) it.
- \`[[wikilinks]]\` still work for cross-references — ⌘/Ctrl-click one to jump.
- Hit **Publish** to snapshot everything to the Fangorn network (you sign one
  transaction from your own wallet — the server never holds your keys).
- Use **Share** to hand a friend a link to follow this wiki.

Happy writing 🌲
`;

// The server never decrypts. A private note's payload carries `enc` (ciphertext)
// instead of `content`; decryption is the browser's job (owner-side key). Until
// that lands, encrypted content surfaces as a placeholder — the point is the
// server CANNOT read it.
function decodeVertex(v) {
    const p = v.payload ?? {};
    if (p.enc === undefined) return v;
    return { ...v, payload: { ...p, content: "🔒 (encrypted — opens in the owner's browser)" } };
}

// Reading a namespace walks the pail tree from the owner's on-chain root — many
// sequential gateway fetches. Cache per (owner, namespace) keyed by the tip.
//
// LRU-bounded so it can't grow without limit (one always-on process, every
// distinct namespace ever touched used to stick forever). A plain Map keeps
// insertion order, so promote-on-read (delete+re-set) puts hot keys last and we
// evict the oldest (first) once over the cap. The durable copy is on-chain, so
// an evicted entry just re-walks on next access.
// ponytail: fixed entry count, not byte-aware; switch to a size budget if a few
// huge namespaces blow memory before the count cap bites.
const REMOTE_CACHE_MAX = 256;
const remoteCache = new Map();
const cacheKey = (repo) => `${repo.owner}/${repo.namespace}`;
const cacheGet = (key) => {
    const v = remoteCache.get(key);
    if (v) { remoteCache.delete(key); remoteCache.set(key, v); } // promote to MRU
    return v;
};
const cacheSet = (key, v) => {
    remoteCache.delete(key);
    remoteCache.set(key, v);
    if (remoteCache.size > REMOTE_CACHE_MAX) remoteCache.delete(remoteCache.keys().next().value);
};

async function remoteState(repo) {
    const key = cacheKey(repo);
    const tip = await fangorn.onChainTip(repo.owner);
    let cached = cacheGet(key);
    if (!cached || cached.tip !== tip) {
        const started = Date.now();
        const raw = await fangorn.engine.listNamespace(repo.namespace, repo.owner);
        const contents = { ...raw, vertices: raw.vertices.map(decodeVertex) };
        cached = { tip, contents };
        cacheSet(key, cached);
        console.log(`[remote:${key}] walked ${contents.vertices.length} vertices / ${contents.edges.length} edges in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    return { tip, contents: cached.contents, latest: latestByPath(cached.contents) };
}

// ─── Live events (SSE) ────────────────────────────────────────────────────────
//
// EventSource can't set headers, so it passes ?token=&address= for auth. Each
// connection watches only its own user: local-change (their working tree) and
// remote-change (each tracked repo's on-chain updates). Repos added after
// connect are picked up on the next reconnect.

async function handleEvents(req, res, url) {
    let address;
    try { address = await authenticate(url.searchParams.get("token"), url.searchParams.get("address")); }
    catch { res.writeHead(401); return res.end(); }

    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write("retry: 3000\n\n");
    const write = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data, bigintReplacer)}\n\n`);

    // Watch our own root plus every shared tree we collaborate in — a repo we
    // co-edit lives under the OWNER's directory, so watching docs/<us> alone
    // would miss every change a friend makes.
    const repos = userStore(address).list();
    const dirs = new Set([join(DATA_DIR, "docs", address), ...repos.map((r) => join(DATA_DIR, r.dir))]);
    let debounce = null;
    const onLocal = () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => write("local-change", {}), 200);
    };
    const localWatchers = [...dirs].map((dir) => {
        mkdirSync(dir, { recursive: true });
        return watch(dir, { recursive: true }, onLocal);
    });

    const aborts = [];
    for (const repo of repos) {
        const abort = new AbortController();
        aborts.push(abort);
        (async () => {
            try {
                for await (const change of fangorn.subscribe({ namespace: repo.namespace, owner: repo.owner, signal: abort.signal })) {
                    remoteCache.delete(cacheKey(repo));
                    write("remote-change", { ...change, namespace: repo.namespace });
                }
            } catch (err) {
                if (!abort.signal.aborted) console.error(`subscribe(${cacheKey(repo)}) failed:`, err.message);
            }
        })();
    }

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
        clearInterval(heartbeat);
        clearTimeout(debounce);
        for (const w of localWatchers) w.close();
        for (const a of aborts) a.abort();
    });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
//
// Every handler receives { address } (the authenticated caller) plus body/path.

const routes = {
    // ── Repo management ──
    "GET /api/repos": async ({ address }) => {
        const s = userStore(address);
        const state = s.read();
        return { active: state.active, address, repos: s.list().map((r) => publicRepo(r, address)) };
    },

    "GET /api/repo": async ({ address }) => {
        const repo = userStore(address).activeOrNull();
        return repo ? publicRepo(repo, address) : null;
    },

    // Create a repo LOCALLY — no on-chain tx. The namespace is allocated on-chain
    // by its first publish (which parents on the user's current root).
    "POST /api/repos": async ({ address, body }) => {
        const namespace = String(body.namespace ?? "").trim();
        if (!NAMESPACE.test(namespace)) throw new HttpError(400, "invalid namespace");
        const s = userStore(address);
        if (s.read().repos[namespace]) throw new HttpError(409, `already tracking ${namespace}`);
        const visibility = body.visibility === "private" ? "private" : "public";
        const dir = relDir(address, namespace);
        const abs = join(DATA_DIR, dir);
        mkdirSync(abs, { recursive: true });
        const index = join(abs, "index.md");
        if (!existsSync(index)) writeFileSync(index, indexBoilerplate(namespace), "utf-8");
        s.add({ namespace, owner: address, head: null, visibility, dir });
        return publicRepo(s.active(), address);
    },

    // Track someone else's namespace read-only (owner + namespace).
    "POST /api/repos/follow": async ({ address, body }) => {
        const namespace = String(body.namespace ?? "").trim();
        const owner = String(body.owner ?? "").trim().toLowerCase();
        if (!NAMESPACE.test(namespace)) throw new HttpError(400, "invalid namespace");
        if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new HttpError(400, "invalid owner address");
        const s = userStore(address);
        if (s.read().repos[namespace]) throw new HttpError(409, `already tracking ${namespace}`);
        const tip = await fangorn.onChainTip(owner).catch(() => null);
        const dir = relDir(address, namespace);
        mkdirSync(join(DATA_DIR, dir), { recursive: true });
        s.add({ namespace, owner, head: tip ?? null, visibility: "public", dir });
        return publicRepo(s.active(), address);
    },

    "POST /api/repos/active": async ({ address, body }) => {
        const s = userStore(address);
        s.setActive(String(body.namespace ?? ""));
        return publicRepo(s.active(), address);
    },

    // Owner-only: who else may edit this namespace's working tree. This is a
    // working-tree grant, not an on-chain one — a collaborator can write and
    // co-edit, but only the owner's wallet can settle a publish. They still need
    // the share link to start tracking the namespace.
    "PUT /api/collaborators": async ({ address, body }) => {
        const s = userStore(address);
        const namespace = String(body.namespace ?? "") || s.active().namespace;
        const list = [...new Set((body.collaborators ?? []).map((a) => String(a).trim().toLowerCase()))]
            .filter((a) => a !== address);
        for (const a of list) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new HttpError(400, `invalid address: ${a}`);
        s.setCollaborators(namespace, list);
        return publicRepo(s.get(namespace), address);
    },

    // ── Notes (operate on the active repo's dir) ──
    // Returns the notes plus the explicit page `tree`. Per-note `links` are the
    // markdown [[wikilinks]] — kept only for backlinks/navigation, not structure.
    "GET /api/notes": async ({ address }) => {
        const repo = userStore(address).activeOrNull();
        if (!repo) return { notes: [], tree: [] };
        const dir = docsDir(repo);
        const paths = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
        const known = new Set(paths);
        const notes = paths.map((path) => {
            const content = readFileSync(join(dir, path), "utf-8");
            const links = [...new Set(extractMarkdownLinks(content).map((id) => `${id}.md`))].filter((t) => t !== path && known.has(t));
            return { path, title: firstHeading(content, path.replace(/\.md$/, "")), links };
        });
        return { notes, tree: reconcileTree(repo).tree };
    },

    // Drag-and-drop persisted the reordered hierarchy.
    "PUT /api/tree": async ({ address, body }) => {
        const repo = userStore(address).active();
        if (!canEdit(repo, address)) throw new HttpError(403, "read-only — ask the owner to add you as a collaborator");
        if (!Array.isArray(body.tree)) throw new HttpError(400, "tree array required");
        writeTree(repo, body.tree);
        return { tree: reconcileTree(repo).tree };
    },

    "GET /api/notes/:path": async ({ address, path }) => {
        const file = join(docsDir(userStore(address).active()), path);
        if (!existsSync(file)) throw new HttpError(404, `no such note: ${path}`);
        return { path, content: readFileSync(file, "utf-8") };
    },

    "PUT /api/notes/:path": async ({ address, path, body }) => {
        if (typeof body.content !== "string") throw new HttpError(400, "content required");
        const dir = docsDir(userStore(address).active());
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, path), body.content, "utf-8");
        return { path, saved: true };
    },

    "DELETE /api/notes/:path": async ({ address, path }) => {
        const repo = userStore(address).active();
        if (!canEdit(repo, address)) throw new HttpError(403, "read-only — ask the owner to add you as a collaborator");
        const file = join(docsDir(repo), path);
        if (!existsSync(file)) throw new HttpError(404, `no such note: ${path}`);
        rmSync(file);
        writeTree(repo, reconcileTree(repo).tree); // prune the now-missing node
        return { deleted: path };
    },

    // Rename in place: move the file and rewrite its path throughout the tree.
    // Existing [[wikilinks]] to the old name are left as-is (navigation only).
    "POST /api/notes/:path/rename": async ({ address, path, body }) => {
        const repo = userStore(address).active();
        if (!canEdit(repo, address)) throw new HttpError(403, "read-only — ask the owner to add you as a collaborator");
        let to = String(body.to ?? "").trim();
        if (!to.endsWith(".md")) to += ".md";
        assertNotePath(to);
        const dir = docsDir(repo);
        if (!existsSync(join(dir, path))) throw new HttpError(404, `no such note: ${path}`);
        if (existsSync(join(dir, to))) throw new HttpError(409, `already exists: ${to}`);
        renameSync(join(dir, path), join(dir, to));
        writeTree(repo, renameInTree(reconcileTree(repo).tree, path, to));
        return { path: to };
    },

    "GET /api/remote": async ({ address }) => {
        const repo = userStore(address).active();
        const { contents, latest } = await remoteState(repo);
        const notes = [...latest.entries()].map(([path, v]) => ({
            path, cid: v.cid,
            title: firstHeading(v.payload.content, path.replace(/\.md$/, "")),
            updatedAt: v.payload.updatedAt ?? null,
        }));
        return { notes, edges: latestEdges(contents, latest) };
    },

    "POST /api/pull": async ({ address }) => {
        const repo = userStore(address).active();
        // A collaborator already lives in the owner's live tree — pulling would
        // overwrite everyone's in-flight drafts with the last published snapshot.
        if (repo.owner !== address && canEdit(repo, address)) return { written: [], skippedEncrypted: [], shared: true };
        const { latest } = await remoteState(repo);
        const dir = docsDir(repo);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const written = [];
        const skippedEncrypted = [];
        for (const [path, v] of latest) {
            if (path !== TREE_FILE) assertNotePath(path); // the tree manifest rides along too
            // Encrypted notes only decrypt in the owner's browser — the server
            // must never overwrite local plaintext with the "🔒" placeholder.
            if (v.payload.enc !== undefined) { skippedEncrypted.push(path); continue; }
            const file = join(dir, path);
            if (existsSync(file) && readFileSync(file, "utf-8") === v.payload.content) continue;
            writeFileSync(file, v.payload.content, "utf-8");
            written.push(path);
        }
        return { written, skippedEncrypted };
    },

    // ── Self-custodial publish: prepare (keyless, server) → sign+send (browser)
    //    → settle (record head). The server builds and flushes the commit but
    //    NEVER signs; it hands back the unsigned settlement tx.
    "POST /api/publish/prepare": async ({ address, body }) => {
        const repo = body.namespace ? userStore(address).get(body.namespace) : userStore(address).active();
        if (repo.owner !== address) throw new HttpError(403, "not your repo — only the owner's wallet can publish");

        // Live rooms write to disk on a debounce, so publishing seconds after
        // someone types could snapshot a file that's a beat behind. Push every
        // open room for this namespace down first — otherwise a collaborator's
        // last sentence silently misses the commit.
        flushRooms(repo.owner, repo.namespace);

        const t0 = Date.now();
        const oldRoot = await readNamespaceHead(address);
        const parent = oldRoot === ZERO_BYTES32 ? undefined : fangorn.engine.commitCidFromRootHex(oldRoot);
        const { latest } = await remoteState(repo);
        // Persist the reconciled tree so it publishes as a vertex (exact
        // hierarchy for followers), and derive the graph's edges from it.
        const { tree, childrenByPath } = reconcileTree(repo);
        writeTree(repo, tree);
        const graph = buildWikiGraph(docsDir(repo), latest, childrenByPath);
        if (graph.vertices.length === 0) throw new HttpError(400, `${repo.dir}/ has no markdown files`);

        // Private repo: the browser sealed each note (content → hex `enc`) with a
        // key only it holds. Swap content→enc before it hits the commit — the
        // server pins ciphertext it can't read. path + updatedAt stay clear
        // (identity/ordering); filenames leak, bodies don't.
        // ponytail: re-seals every note each publish (fresh nonce → new CID);
        // the server can't decrypt remote to detect unchanged notes, so no reuse.
        if (repo.visibility === "private") {
            const sealed = body.sealed ?? {};
            for (const v of graph.vertices) {
                if (v.payload.path === TREE_FILE) continue; // structure vertex stays clear
                const enc = sealed[v.payload.path];
                if (!enc) throw new HttpError(400, `missing sealed content for ${v.payload.path} — is the wallet unlocked?`);
                const { content, ...rest } = v.payload; // rest: {path, updatedAt}
                v.payload = { ...rest, enc };
            }
        }

        const commit = await fangorn.commit({
            namespace: repo.namespace,
            vertices: graph.vertices,
            edges: graph.edges,
            parent,
            message: body.message || "update wiki",
        });
        const data = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "commitStateRoot", args: [oldRoot, rootHexFromCid(commit.commitCid)] });
        // Wallet fee estimation runs too tight for Arbitrum Sepolia's live base
        // fee — quote fees ourselves with headroom. maxFeePerGas is only a
        // ceiling (you pay baseFee+priority), so 2× is safe, not overpaying.
        const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
        // Estimate the gas limit here too, so the wallet never has to run its own
        // eth_estimateGas — that call against the public Arbitrum Sepolia RPC is
        // what surfaces as "Network fee Unavailable" in MetaMask. Simulating here
        // also turns a would-be revert (e.g. a stale root) into a clear error
        // instead of a cryptic wallet message. 1.5× headroom; gas is only a
        // ceiling, so overshooting costs nothing. Fallback keeps publish working
        // if the RPC hiccups on this one call.
        let gas;
        try {
            const estimate = await publicClient.estimateGas({ account: address, to: REGISTRY, data });
            gas = (estimate * 3n) / 2n;
        } catch (err) {
            if (/revert/i.test(err.message)) throw new HttpError(409, `settlement would revert (root moved on-chain?) — pull and retry: ${err.shortMessage ?? err.message}`);
            gas = 5_000_000n; // RPC hiccup, not a revert — proceed with a safe ceiling
        }
        console.log(`[prepare:${cacheKey(repo)}] commit+flush ${((Date.now() - t0) / 1000).toFixed(1)}s → ${commit.commitCid}`);
        return {
            namespace: repo.namespace,
            commitCid: commit.commitCid,
            staged: { vertices: graph.vertices.length, edges: graph.edges.length },
            tx: {
                to: REGISTRY, data, chainId: CHAIN.id, gas: toHex(gas),
                maxFeePerGas: toHex(maxFeePerGas * 2n),
                maxPriorityFeePerGas: toHex(maxPriorityFeePerGas),
            },
        };
    },

    // Record the settled head after the browser's tx confirms.
    "POST /api/settle": async ({ address, body }) => {
        const namespace = String(body.namespace ?? "");
        const repo = userStore(address).get(namespace);
        if (repo.owner !== address) throw new HttpError(403, "not your repo");
        userStore(address).setHead(namespace, String(body.commitCid ?? ""));
        remoteCache.delete(cacheKey(repo));
        return { ok: true, head: body.commitCid ?? null, txHash: body.txHash ?? null };
    },

    "GET /api/history": async ({ address }) => {
        const { head } = userStore(address).active();
        if (!head) return { commits: [] };
        const commits = [];
        for await (const c of fangorn.log(head, 50)) commits.push(c);
        return { commits };
    },
};

// ─── Static SPA (production) ────────────────────────────────────────────────

const DIST = join(ROOT, "dist");
const MIME = {
    ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
    ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
    ".ico": "image/x-icon", ".woff2": "font/woff2", ".map": "application/json",
};

function serveStatic(res, pathname) {
    if (!existsSync(DIST)) return sendJson(res, 404, { error: "no dist/ — run `vite build`" });
    const rel = normalize(pathname).replace(/^(\.\.[/\\])+/, "");
    let file = join(DIST, rel);
    if (!file.startsWith(DIST) || !existsSync(file) || pathname === "/") file = join(DIST, "index.html");
    res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/events") return handleEvents(req, res, url);
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

    let key = `${req.method} ${url.pathname}`;
    const params = {};
    const renameMatch = url.pathname.match(/^\/api\/notes\/(.+)\/rename$/);
    const noteMatch = url.pathname.match(/^\/api\/notes\/(.+)$/);
    if (renameMatch) {
        params.path = decodeURIComponent(renameMatch[1]);
        key = `${req.method} /api/notes/:path/rename`;
    } else if (noteMatch) {
        params.path = decodeURIComponent(noteMatch[1]);
        key = `${req.method} /api/notes/:path`;
    }

    const handler = routes[key];
    if (!handler) return sendJson(res, 404, { error: `no route: ${key}` });

    try {
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        params.address = await authenticate(bearer, req.headers["x-wallet-address"]);
        if (params.path) assertNotePath(params.path);
        if (req.method === "PUT" || req.method === "POST") params.body = await readJson(req);
        sendJson(res, 200, await handler(params));
    } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (status === 500) console.error(err);
        sendJson(res, status, { error: err.message });
    }
});

// ─── Live co-editing (Yjs rooms) ────────────────────────────────────────────
//
// The real-time layer for PUBLIC repos. One room per note, named
// `${owner}:${namespace}:${note}`. Everyone who can see the namespace joins and
// sees keystrokes live; only the owner and their named collaborators may type.
//
// The server owns the room's lifecycle rather than relaying blindly:
//
//   seed    — the room is filled from the owner's file when it's created, so a
//             viewer who arrives first sees the document instead of a blank
//             page (the old "first writer seeds it" rule meant readers, and
//             collaborators who opened before the owner, got nothing).
//   persist — the merged text is written back to the owner's working tree on a
//             debounce. This is what makes collaboration real: a friend's
//             edits land in the tree the owner publishes even when the owner
//             isn't connected. Previously each peer saved only to their own
//             copy, so a note the owner didn't have open lost every edit.
//
// The file stays the durable layer; the room is the shared unsaved buffer above
// it. Publishing is untouched, and still owner-only.
//
// Private repos never open a room — their content is ciphertext the server
// can't read, and a live plaintext room would defeat that.

// Resolve a room name to the file it mirrors, or null if it isn't a room anyone
// may open. Every component is validated — the note name reaches the filesystem.
function roomFile(room) {
    const [owner, namespace, note] = String(room).split(":");
    if (!/^0x[0-9a-f]{40}$/.test(owner ?? "")) return null;
    if (!NAMESPACE.test(namespace ?? "") || !NOTE_PATH.test(note ?? "")) return null;
    const repo = readUserState(owner).repos?.[namespace];
    if (!repo || repo.owner !== owner || repo.visibility === "private") return null;
    return { owner, namespace, note, file: join(DATA_DIR, relDir(owner, namespace), note) };
}

const FLUSH_MS = 800;

// Force every open room in a namespace to disk (used just before Publish reads
// the files). Rooms with no bound file are skipped by the optional call.
const flushRooms = (owner, namespace) => {
    const prefix = `${owner}:${namespace}:`;
    for (const [room, doc] of yRooms) if (room.startsWith(prefix)) doc.flushToDisk?.();
};

setPersistence({
    provider: null,
    bindState: (room, doc) => {
        const target = roomFile(room);
        if (!target) return;
        const xml = doc.get("content", Y.XmlText);
        if (xml.length === 0 && existsSync(target.file)) {
            seedFromMarkdown(xml, readFileSync(target.file, "utf-8"));
        }
        let timer = null;
        const flush = () => {
            clearTimeout(timer);
            timer = null;
            const md = docMarkdown(xml);
            // Never conjure a file from an empty room — that's how a race
            // between "room created" and "first client synced" would truncate.
            if (!existsSync(target.file)) { if (!md.trim()) return; }
            else if (readFileSync(target.file, "utf-8") === md) return;
            writeFileSync(target.file, md, "utf-8");
        };
        doc.flushToDisk = flush;
        // Registered after seeding, so the seed itself doesn't schedule a write.
        doc.on("update", () => { clearTimeout(timer); timer = setTimeout(flush, FLUSH_MS); });
    },
    // Last peer left: write the final text. The doc is then destroyed and the
    // next visitor re-seeds from the file — which also stops rooms accumulating
    // in memory for the life of the process.
    writeState: async (_room, doc) => { doc.flushToDisk?.(); },
});

// A read-only peer may watch and show up in presence, but must not write — and
// now that the server persists rooms to the owner's tree, that's a file
// integrity boundary, not a UI nicety, so it's enforced here rather than
// trusted to the client (isReadFrame lives in ydoc.js).
//
// setupWSConnection only ever touches these members, so a small facade is
// enough to filter — no need to fork it.
function readOnlyConn(conn) {
    conn.binaryType = "arraybuffer";
    return {
        binaryType: "arraybuffer",
        get readyState() { return conn.readyState; },
        send: (...args) => conn.send(...args),
        ping: () => conn.ping(),
        close: () => conn.close(),
        on: (event, fn) =>
            conn.on(event, event !== "message" ? fn : (m) => { if (isReadFrame(new Uint8Array(m))) fn(m); }),
    };
}

const yws = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/yjs/")) return; // not a collab socket
    const deny = (line) => { socket.write(`HTTP/1.1 ${line}\r\n\r\n`); socket.destroy(); };

    let address;
    try { address = await authenticate(url.searchParams.get("token"), url.searchParams.get("address")); }
    catch { return deny("401 Unauthorized"); }

    const docName = decodeURIComponent(url.pathname.slice("/yjs/".length));
    const target = roomFile(docName);
    if (!target) return deny("404 Not Found");

    // Anyone with the link can watch a public namespace live; only the owner and
    // the collaborators they named may type into it.
    const writer = canEdit({ owner: target.owner, namespace: target.namespace }, address);
    yws.handleUpgrade(req, socket, head, (conn) =>
        setupWSConnection(writer ? conn : readOnlyConn(conn), req, { docName }));
});

server.listen(PORT, () => {
    mkdirSync(USERS_DIR, { recursive: true });
    console.log(`fangornmd server → http://localhost:${PORT}`);
    console.log(`  mode:    multi-tenant relay (self-custodial — holds no user keys)`);
    console.log(`  service: ${fangorn.getAddress()} (engine + Pinata only)`);
    console.log(`  privy:   ${PRIVY_APP_ID}`);
});

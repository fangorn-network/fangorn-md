import { createServer } from "node:http";
import {
    readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, watch,
} from "node:fs";
import { join, extname, normalize } from "node:path";
import { Fangorn, FangornConfig, extractMarkdownLinks } from "@fangorn-network/sdk";
import { createPublicClient, http, encodeFunctionData, toHex } from "viem";
import { CID } from "multiformats/cid";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { WebSocketServer } from "ws";
import { setupWSConnection } from "@y/websocket-server/utils";
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
// A repo is (owner, namespace); repos the user owns are writable, follows aren't.

const relDir = (address, namespace) => `docs/${address}/${namespace}`;

function userStore(address) {
    const file = join(USERS_DIR, `${address}.json`);
    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : { active: null, repos: {} });
    const write = (s) => writeFileSync(file, JSON.stringify(s, null, 2), "utf-8");
    return {
        read,
        list: () => Object.values(read().repos),
        get(ns) { const r = read().repos[ns]; if (!r) throw new HttpError(404, `no such repo: ${ns}`); return r; },
        activeOrNull() { const s = read(); return s.active ? s.repos[s.active] : null; },
        active() { const r = this.activeOrNull(); if (!r) throw new HttpError(404, "no active repo — create one first"); return r; },
        setActive(ns) { const s = read(); if (!s.repos[ns]) throw new HttpError(404, `no such repo: ${ns}`); s.active = ns; write(s); },
        setHead(ns, cid) { const s = read(); s.repos[ns].head = cid; write(s); },
        add(repo) { const s = read(); s.repos[repo.namespace] = repo; s.active = repo.namespace; write(s); },
    };
}

const docsDir = (repo) => join(DATA_DIR, repo.dir);
const publicRepo = (repo, address) => ({ ...repo, writable: repo.owner === address });

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

- Edit here on the left; changes autosave.
- Add notes with **+**, then link them with \`[[wikilink]]\` or
  \`[title](note.md)\` — the sidebar tree is built from those links.
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
const remoteCache = new Map();
const cacheKey = (repo) => `${repo.owner}/${repo.namespace}`;

async function remoteState(repo) {
    const tip = await fangorn.onChainTip(repo.owner);
    const cached = remoteCache.get(cacheKey(repo));
    if (!cached || cached.tip !== tip) {
        const started = Date.now();
        const raw = await fangorn.engine.listNamespace(repo.namespace, repo.owner);
        const contents = { ...raw, vertices: raw.vertices.map(decodeVertex) };
        remoteCache.set(cacheKey(repo), { tip, contents });
        console.log(`[remote:${cacheKey(repo)}] walked ${contents.vertices.length} vertices / ${contents.edges.length} edges in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    }
    const contents = remoteCache.get(cacheKey(repo)).contents;
    return { tip, contents, latest: latestByPath(contents) };
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

    const userDir = join(DATA_DIR, "docs", address);
    mkdirSync(userDir, { recursive: true });
    let debounce = null;
    const localWatcher = watch(userDir, { recursive: true }, () => {
        clearTimeout(debounce);
        debounce = setTimeout(() => write("local-change", {}), 200);
    });

    const aborts = [];
    for (const repo of userStore(address).list()) {
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
        localWatcher.close();
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

    // ── Notes (operate on the active repo's dir) ──
    "GET /api/notes": async ({ address }) => {
        const repo = userStore(address).activeOrNull();
        if (!repo) return { notes: [] };
        const dir = docsDir(repo);
        const paths = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")) : [];
        const known = new Set(paths);
        const notes = paths.map((path) => {
            const content = readFileSync(join(dir, path), "utf-8");
            const links = [...new Set(extractMarkdownLinks(content).map((id) => `${id}.md`))].filter((t) => t !== path && known.has(t));
            return { path, title: firstHeading(content, path.replace(/\.md$/, "")), links };
        });
        return { notes };
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
        const { latest } = await remoteState(repo);
        const dir = docsDir(repo);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const written = [];
        const skippedEncrypted = [];
        for (const [path, v] of latest) {
            assertNotePath(path);
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

        const t0 = Date.now();
        const oldRoot = await readNamespaceHead(address);
        const parent = oldRoot === ZERO_BYTES32 ? undefined : fangorn.engine.commitCidFromRootHex(oldRoot);
        const { latest } = await remoteState(repo);
        const graph = buildWikiGraph(docsDir(repo), latest);
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
        console.log(`[prepare:${cacheKey(repo)}] commit+flush ${((Date.now() - t0) / 1000).toFixed(1)}s → ${commit.commitCid}`);
        return {
            namespace: repo.namespace,
            commitCid: commit.commitCid,
            staged: { vertices: graph.vertices.length, edges: graph.edges.length },
            tx: {
                to: REGISTRY, data, chainId: CHAIN.id,
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
    const noteMatch = url.pathname.match(/^\/api\/notes\/(.+)$/);
    if (noteMatch) {
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

// ─── Live co-editing (Yjs relay) ────────────────────────────────────────────
//
// The real-time collaborative-draft layer for PUBLIC repos. The server is a
// PURE RELAY: it shuttles Yjs sync + awareness messages between everyone in a
// room (room = owner/namespace/note) and never interprets the content — same
// "holds no user data" posture as the rest of the server. The durable, signed
// layer is still Publish (owner-only); this is just the shared unsaved buffer
// below it. Each collaborator's own editor autosaves the merged text to their
// working tree, so Publish stays exactly as-is.
//
// Private repos never open a room (their plaintext would be readable here), so
// there's nothing to leak — that gate lives in the browser (public repos only).
// ponytail: any authenticated user may join any room — no per-repo allowlist
// yet. Add owner-managed allowlists with the private/team work (Increment 4b).
const yws = new WebSocketServer({ noServer: true });
server.on("upgrade", async (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!url.pathname.startsWith("/yjs/")) return; // not a collab socket
    try {
        await authenticate(url.searchParams.get("token"), url.searchParams.get("address"));
    } catch {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return socket.destroy();
    }
    // Room = the URL path after /yjs/ (an opaque key; peers agree on it).
    const docName = url.pathname.slice("/yjs/".length);
    yws.handleUpgrade(req, socket, head, (conn) => setupWSConnection(conn, req, { docName }));
});

server.listen(PORT, () => {
    mkdirSync(USERS_DIR, { recursive: true });
    console.log(`fangornmd server → http://localhost:${PORT}`);
    console.log(`  mode:    multi-tenant relay (self-custodial — holds no user keys)`);
    console.log(`  service: ${fangorn.getAddress()} (engine + Pinata only)`);
    console.log(`  privy:   ${PRIVY_APP_ID}`);
});

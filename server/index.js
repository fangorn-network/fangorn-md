import { createServer } from "node:http";
import {
    readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, watch, rmSync, renameSync,
} from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { Fangorn, FangornConfig, appId, extractMarkdownLinks } from "@fangorn-network/sdk";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { WebSocketServer } from "ws";
import { setupWSConnection, setPersistence, docs as yRooms } from "@y/websocket-server/utils";
import * as Y from "yjs";
import { docMarkdown, seedFromMarkdown, replaceMarkdown, isReadFrame, encodeRoomState, applyRoomState } from "./ydoc.js";
import { buildWikiGraph, latestByPath, latestEdges } from "./graph.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createFangornmdServer, httpCall } from "../mcp/tools.js";
// Shared with the browser: one renderer for the pane, the export and the
// published page, so a public URL can't drift from what the author saw.
import { publicPage } from "../src/render.js";

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

for (const key of ["ETH_PRIVATE_KEY"]) {
    if (!process.env[key]) {
        console.error(`Missing ${key} — copy .env.example to .env and fill it in.`);
        process.exit(1);
    }
}
if (!PRIVY_APP_ID) {
    console.error("Missing VITE_PRIVY_APP_ID — needed to verify Privy login tokens.");
    process.exit(1);
}

// Namespaces are hierarchical — `app:publisher:namespace` — and fangornmd owns
// the `fangornmd` app prefix. Every wiki published through this server lives
// under it, which is what lets one subscription see the whole instance rather
// than a per-publisher fan-out. The app id must be claimed on-chain once (see
// the startup check below); publishers register separately, for the right to
// write at all.
const APP_ID = appId("fangornmd");
const CONFIG = { ...FangornConfig, appId: APP_ID };

const fangorn = Fangorn.create({
    privateKey: process.env.ETH_PRIVATE_KEY,
    // storage: { pinata: { jwt: process.env.PINATA_JWT, gateway: process.env.PINATA_GATEWAY } },
    storage: {
        signedUrl: {
            workerUrl: 'https://sepolia.storage-worker.fangorn.network',
            gateway: process.env.PINATA_GATEWAY,
        }
    },
    domain: "localhost",
    config: CONFIG,
});

/**
 * The app prefix must exist on-chain before anyone can publish under it —
 * `commitStateRoot` reverts with AppNotFound otherwise. Checking at boot turns
 * that into one clear line at startup instead of a failed publish for the first
 * user who tries.
 */
async function assertAppRegistered() {
    const owner = await fangorn.getDataRegistry().getAppOwner();
    if (owner === `0x${"0".repeat(40)}`) {
        console.error(
            `App "fangornmd" (${APP_ID}) is not registered on-chain — publishing will fail.\n` +
            `Claim it once from any funded wallet:\n` +
            `  cast send ${CONFIG.dataRegistryContractAddress} "registerApp(bytes32)" ${APP_ID} \\\n` +
            `    --rpc-url ${CONFIG.rpcUrl} --private-key <key>`,
        );
        process.exit(1);
    }
    return owner;
}

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

// ─── Auth (agent tokens) ────────────────────────────────────────────────────
//
// A Privy JWT proves a live browser session, which an agent can't have. So an
// owner can mint a long-lived token their agent holds instead:
//
//     fmd_<owner address>_<random>
//
// The address is IN the token so a lookup is one file read — no index, no scan
// across every user. Only the sha256 is stored, so the user file is not itself
// a credential; the token is shown once at mint time.
//
// A token reaches every namespace its owner tracks, and the caller names which
// one per request (`?ns=`). Connecting an agent is then a ONE-TIME setup rather
// than one endpoint per wiki — which matters, because a per-namespace token
// means re-configuring every MCP client each time someone makes a new wiki, and
// nobody does that.
//
// `namespace` on the record optionally PINS a token to one wiki. Then `?ns=`
// can't move it, and the token is worth exactly one namespace if it leaks. It's
// the right default for a token you hand to somebody else's agent, and the
// wrong one for your own, so the browser offers both and defaults to unpinned.
//
// What no token may do, pinned or not: mint tokens, and publish. Note that
// `agent` is tracked separately from `agentNs` — an unpinned token has no
// namespace, and if that were the agent test, an unpinned token would read as a
// browser session and could publish. Publishing is refused here for tidiness
// anyway: settling is a transaction signed by the owner's wallet, which lives
// in their browser and not on this server. That is the real boundary; this
// check is just the polite error.
const hashToken = (t) => createHash("sha256").update(t).digest("hex");

function agentAuth(token) {
    const [, address] = token.match(/^fmd_(0x[0-9a-f]{40})_[0-9a-f]+$/i) ?? [];
    if (!address) return null;
    const rec = readUserState(address.toLowerCase()).tokens?.[hashToken(token)];
    if (!rec) throw new HttpError(401, "unknown or revoked agent token");
    return { address: address.toLowerCase(), agent: true, agentNs: rec.namespace ?? null };
}

async function authenticate(token, assertedAddress) {
    if (!token) throw new HttpError(401, "missing auth token");
    const agent = agentAuth(token);
    if (agent) return agent;
    try {
        await jwtVerify(token, JWKS, { issuer: "privy.io", audience: PRIVY_APP_ID });
    } catch {
        throw new HttpError(401, "invalid auth token");
    }
    const address = String(assertedAddress ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new HttpError(400, "missing or invalid X-Wallet-Address");
    return { address, agent: false, agentNs: null };
}

const assertHuman = (p) => {
    if (p.agent) throw new HttpError(403, "agent tokens cannot do this — a human must, from the browser");
};

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
        // Agent tokens, keyed by hash. `name` is for the human's list; the token
        // itself is returned once by mint() and never stored.
        tokens: () => Object.entries(read().tokens ?? {})
            .map(([hash, t]) => ({ hash, name: t.name, namespace: t.namespace, createdAt: t.createdAt })),
        // `namespace` null → the token reaches every repo this user tracks.
        mintToken(name, namespace) {
            const s = read();
            if (namespace && !s.repos[namespace]) throw new HttpError(404, `no such repo: ${namespace}`);
            const token = `fmd_${address}_${randomBytes(24).toString("hex")}`;
            s.tokens = { ...s.tokens, [hashToken(token)]: { name, namespace, createdAt: Date.now() } };
            write(s);
            return token;
        },
        revokeToken(hash) {
            const s = read();
            if (!s.tokens?.[hash]) throw new HttpError(404, "no such token");
            delete s.tokens[hash];
            write(s);
        },
    };
}

// The repo a request operates on. An agent token is pinned to its namespace;
// a browser session follows the user's active repo. Every note route goes
// through here, so the scope holds everywhere by construction.
// The live Yjs doc for a note, if anyone has it open right now. While it
// exists it — not the file — is the current text: it seeds from disk once and
// then flushes back on a debounce. So an API read/write has to go through it
// or it is reading stale text and writing text that gets overwritten.
function openRoom(repo, note) {
    const doc = yRooms.get(`${repo.owner}:${repo.namespace}:${note}`);
    return doc ? { doc, xml: doc.get("content", Y.XmlText) } : null;
}

// Which repo a request acts on:
//   pinned token  → its namespace, and `?ns=` may only agree with it
//   otherwise     → `?ns=` if given, else the user's active repo
// A browser never sends `?ns=`, so the human keeps following their own tabs.
const repoForOrNull = (p) => {
    const store = userStore(p.address);
    if (p.agentNs) {
        if (p.ns && p.ns !== p.agentNs) throw new HttpError(403, `this token is pinned to ${p.agentNs}`);
        return store.get(p.agentNs);
    }
    return p.ns ? store.get(p.ns) : store.activeOrNull();
};
const repoFor = (p) => {
    const repo = repoForOrNull(p);
    if (!repo) throw new HttpError(404, "no active repo — create one first");
    return repo;
};

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
// A namespace is a display name people type, but it's also a directory name and
// a segment of the `owner:namespace:note` room key — so the rule is a blacklist
// of what would break those, not a whitelist of safe characters.
const NAMESPACE = {
    test: (ns) =>
        typeof ns === "string" &&
        ns.length > 0 && ns.length <= 64 &&
        ns === ns.trim() &&
        !/[/\\:\x00-\x1f]/.test(ns) &&
        ns !== "." && ns !== "..",
};
function assertNotePath(path) {
    if (!NOTE_PATH.test(path)) throw new HttpError(400, `invalid note path: ${path}`);
}

const bigintReplacer = (_k, v) => (typeof v === "bigint" ? v.toString() : v);

function sendJson(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body, bigintReplacer));
}

// The public route has readers, not API clients, on the other end.
function sendText(res, status, body) {
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(body);
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

const cacheKey = (repo) => `${repo.owner}/${repo.namespace}`;

// `readNamespace` is the SDK's tip-keyed, LRU-bounded read: walking the pail
// tree is many sequential gateway fetches, and the tip only moves on publish,
// so there's nothing to invalidate here after a settle or a remote change.
async function remoteState(repo) {
    const { tip, contents: raw } = await fangorn.readNamespace(repo.owner, repo.namespace);
    const contents = { ...raw, vertices: raw.vertices.map(decodeVertex) };
    return { tip, contents, latest: latestByPath(contents) };
}

// ─── Live events (SSE) ────────────────────────────────────────────────────────
//
// EventSource can't set headers, so it passes ?token=&address= for auth. Each
// connection watches only its own user: local-change (their working tree) and
// remote-change (each tracked repo's on-chain updates). Repos added after
// connect are picked up on the next reconnect.
//
// Remote changes come off ONE app-wide subscription shared by every connection
// (`fangorn.appFeed()`), not one watch per connection × per tracked repo. Since
// fangornmd owns the `fangornmd` app prefix, every wiki this server serves is
// already in that single topic filter — each connection just picks out the
// repos it tracks.

async function handleEvents(req, res, url) {
    let address;
    try { ({ address } = await authenticate(url.searchParams.get("token"), url.searchParams.get("address"))); }
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

    const tracked = new Set(repos.map(cacheKey));
    const offFeed = fangorn.appFeed().on(
        (change) => {
            // The event carries a checksummed address; repo owners are stored
            // lowercase.
            if (tracked.has(cacheKey({ owner: change.owner.toLowerCase(), namespace: change.namespace })))
                write("remote-change", change);
        },
        (err) => console.error(`app feed (${address}):`, err.message),
    );

    const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);
    req.on("close", () => {
        clearInterval(heartbeat);
        clearTimeout(debounce);
        for (const w of localWatchers) w.close();
        offFeed();
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

    "GET /api/repo": async (p) => {
        const repo = repoForOrNull(p);
        return repo ? publicRepo(repo, p.address) : null;
    },

    // Create a repo LOCALLY — no on-chain tx. The namespace is allocated on-chain
    // by its first publish (which parents on the user's current root).
    "POST /api/repos": async ({ address, body }) => {
        const namespace = String(body.namespace ?? "").trim();
        if (!NAMESPACE.test(namespace)) throw new HttpError(400, "invalid name — 1-64 characters, no / \\ or :");
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
        if (!NAMESPACE.test(namespace)) throw new HttpError(400, "invalid name — 1-64 characters, no / \\ or :");
        if (!/^0x[0-9a-f]{40}$/.test(owner)) throw new HttpError(400, "invalid owner address");
        const s = userStore(address);
        if (s.read().repos[namespace]) throw new HttpError(409, `already tracking ${namespace}`);
        const tip = await fangorn.onChainTip(owner, namespace).catch(() => null);
        const dir = relDir(address, namespace);
        mkdirSync(join(DATA_DIR, dir), { recursive: true });
        s.add({ namespace, owner, head: tip ?? null, visibility: "public", dir });
        return publicRepo(s.active(), address);
    },

    // Browser-only: this moves the human's UI. An agent names its target with
    // `?ns=` per call instead, so it never has a reason to reach for this —
    // and can't yank someone's editor to another wiki mid-sentence.
    "POST /api/repos/active": async (p) => {
        assertHuman(p);
        const { address, body } = p;
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

    // ── Agent tokens (browser-only: an agent cannot mint itself more reach) ──
    "GET /api/tokens": async (p) => {
        assertHuman(p);
        return { tokens: userStore(p.address).tokens() };
    },

    "POST /api/tokens": async (p) => {
        assertHuman(p);
        // No namespace = every wiki this user tracks, which is what makes
        // connecting an agent a one-time step rather than a per-wiki one.
        const namespace = String(p.body.namespace ?? "").trim() || null;
        const name = String(p.body.name ?? "agent").trim().slice(0, 64) || "agent";
        if (namespace && userStore(p.address).get(namespace).owner !== p.address) {
            throw new HttpError(403, "not your repo — pin a token to a namespace you own");
        }
        // Returned ONCE. Only the hash is stored, so this is the only moment the
        // token exists anywhere we can show it.
        return { token: userStore(p.address).mintToken(name, namespace), name, namespace };
    },

    "POST /api/tokens/revoke": async (p) => {
        assertHuman(p);
        userStore(p.address).revokeToken(String(p.body.hash ?? ""));
        return { revoked: true };
    },

    // ── Notes (operate on the active repo's dir) ──
    // Returns the notes plus the explicit page `tree`. Per-note `links` are the
    // markdown [[wikilinks]] — kept only for backlinks/navigation, not structure.
    "GET /api/notes": async (p) => {
        const repo = repoForOrNull(p);
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
    "PUT /api/tree": async (p) => {
        const { address, body } = p;
        const repo = repoFor(p);
        if (!canEdit(repo, address)) throw new HttpError(403, "read-only — ask the owner to add you as a collaborator");
        if (!Array.isArray(body.tree)) throw new HttpError(400, "tree array required");
        writeTree(repo, body.tree);
        return { tree: reconcileTree(repo).tree };
    },

    // Both of these prefer the LIVE room over the file when one is open — see
    // openRoom(). The file lags a room by up to FLUSH_MS, and a plain
    // writeFileSync into a note somebody has open is erased by the next flush.
    "GET /api/notes/:path": async (p) => {
        const { path } = p;
        const repo = repoFor(p);
        const live = openRoom(repo, path);
        if (live) return { path, content: docMarkdown(live.xml), live: true };
        const file = join(docsDir(repo), path);
        if (!existsSync(file)) throw new HttpError(404, `no such note: ${path}`);
        return { path, content: readFileSync(file, "utf-8"), live: false };
    },

    "PUT /api/notes/:path": async (p) => {
        const { path, body } = p;
        if (typeof body.content !== "string") throw new HttpError(400, "content required");
        const repo = repoFor(p);
        const live = openRoom(repo, path);
        if (live) {
            replaceMarkdown(live.doc, live.xml, body.content);
            live.doc.flushToDisk?.(); // don't wait out the debounce to answer "saved"
            return { path, saved: true, live: true };
        }
        const dir = docsDir(repo);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, path), body.content, "utf-8");
        return { path, saved: true, live: false };
    },

    "DELETE /api/notes/:path": async (p) => {
        const { address, path } = p;
        const repo = repoFor(p);
        if (!canEdit(repo, address)) throw new HttpError(403, "read-only — ask the owner to add you as a collaborator");
        const file = join(docsDir(repo), path);
        if (!existsSync(file)) throw new HttpError(404, `no such note: ${path}`);
        closeRoom(repo.owner, repo.namespace, path); // before the unlink, or the room writes it back
        rmSync(file);
        writeTree(repo, reconcileTree(repo).tree); // prune the now-missing node
        return { deleted: path };
    },

    // Rename in place: move the file and rewrite its path throughout the tree.
    // Existing [[wikilinks]] to the old name are left as-is (navigation only).
    "POST /api/notes/:path/rename": async (p) => {
        const { address, path, body } = p;
        const repo = repoFor(p);
        if (!canEdit(repo, address)) throw new HttpError(403, "read-only — ask the owner to add you as a collaborator");
        let to = String(body.to ?? "").trim();
        if (!to.endsWith(".md")) to += ".md";
        assertNotePath(to);
        const dir = docsDir(repo);
        if (!existsSync(join(dir, path))) throw new HttpError(404, `no such note: ${path}`);
        if (existsSync(join(dir, to))) throw new HttpError(409, `already exists: ${to}`);
        // The room is named after the note, so the old name's room is orphaned —
        // close it first, or it flushes the note straight back to the old path.
        // The new name seeds fresh from the file it's about to get.
        closeRoom(repo.owner, repo.namespace, path);
        renameSync(join(dir, path), join(dir, to));
        writeTree(repo, renameInTree(reconcileTree(repo).tree, path, to));
        return { path: to };
    },

    "GET /api/remote": async (p) => {
        const repo = repoFor(p);
        const { contents, latest } = await remoteState(repo);
        const notes = [...latest.entries()].map(([path, v]) => ({
            path, cid: v.cid,
            title: firstHeading(v.payload.content, path.replace(/\.md$/, "")),
            updatedAt: v.payload.updatedAt ?? null,
        }));
        return { notes, edges: latestEdges(contents, latest) };
    },

    "POST /api/pull": async (p) => {
        const { address } = p;
        const repo = repoFor(p);
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
    "POST /api/publish/prepare": async (p) => {
        assertHuman(p); // the tx this returns can only be signed in a browser anyway
        const { address, body } = p;
        const repo = body.namespace ? userStore(address).get(body.namespace) : userStore(address).active();
        if (repo.owner !== address) throw new HttpError(403, "not your repo — only the owner's wallet can publish");

        // Live rooms write to disk on a debounce, so publishing seconds after
        // someone types could snapshot a file that's a beat behind. Push every
        // open room for this namespace down first — otherwise a collaborator's
        // last sentence silently misses the commit.
        flushRooms(repo.owner, repo.namespace);

        const t0 = Date.now();
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

        // Builds the commit on the namespace's current on-chain head, pins it, and
        // returns the UNSIGNED settlement tx (fees and gas already quoted with
        // headroom, and a would-be revert surfaced here rather than in the
        // wallet). The server never signs — the head moves only when the owner's
        // browser wallet sends this.
        let prepared;
        try {
            prepared = await fangorn.prepareCommit({
                owner: address,
                namespace: repo.namespace,
                vertices: graph.vertices,
                edges: graph.edges,
                message: body.message || "update wiki",
            });
        } catch (err) {
            if (/revert/i.test(err.message)) throw new HttpError(409, `settlement would revert (root moved on-chain?) — pull and retry: ${err.message}`);
            throw err;
        }

        console.log(`[prepare:${cacheKey(repo)}] commit+flush ${((Date.now() - t0) / 1000).toFixed(1)}s → ${prepared.commitCid}`);
        return {
            namespace: repo.namespace,
            commitCid: prepared.commitCid,
            staged: prepared.staged,
            // The SDK builds its public client without a `chain`, so the tx it
            // hands back carries `chainId: undefined` — which reaches the browser
            // as a missing field and makes Privy's switchChain(Number(undefined))
            // fail with "chainId NaN". The chain is fixed by config; fill it in.
            tx: { ...prepared.tx, chainId: prepared.tx.chainId ?? CONFIG.chain.id },
        };
    },

    // Record the settled head after the browser's tx confirms.
    "POST /api/settle": async (p) => {
        assertHuman(p);
        const { address, body } = p;
        const namespace = String(body.namespace ?? "");
        const repo = userStore(address).get(namespace);
        if (repo.owner !== address) throw new HttpError(403, "not your repo");
        userStore(address).setHead(namespace, String(body.commitCid ?? ""));
        return { ok: true, head: body.commitCid ?? null, txHash: body.txHash ?? null };
    },

    "GET /api/history": async (p) => {
        const { head } = repoFor(p);
        if (!head) return { commits: [] };
        const commits = [];
        for await (const c of fangorn.log(head, 50)) commits.push(c);
        return { commits };
    },
};

// ─── Public read (no auth) ──────────────────────────────────────────────────
//
// `/r/:owner/:namespace/:note.md` — the published snapshot of one note, served
// to anyone with the link. No token, no wallet, no SPA shell: the HTML arrives
// rendered, which is what makes it work for a stranger's browser, a link
// preview, a crawler and an agent's fetch all at once. Those are the same
// requirement, so they get the same route.
//
// `Accept: text/markdown` (or text/plain) returns the source instead. An agent
// wants the markdown, and markdown is what's stored — no lossy conversion step
// the way there'd be out of a proprietary document format.
//
// What's served is the last PUBLISHED version, read straight from the chain +
// IPFS via `remoteState`, never the working tree: drafts stay private until
// their author signs a publish. `decodeVertex` has already replaced any
// encrypted payload with a placeholder, so ciphertext can't leak here either.
const PUBLIC_PREFIX = "/r/";

// Only namespaces this server knows AND that are marked public are served —
// mirroring roomFile()'s rule. Anything else would make the box an open gateway
// for the whole network, which is a different product decision than "my share
// links work".
function publicTarget(pathname) {
    const [owner, ns, note = "index.md"] = pathname.slice(PUBLIC_PREFIX.length).split("/").map(decodeURIComponent);
    if (!/^0x[0-9a-f]{40}$/i.test(owner ?? "")) return null;
    if (!NAMESPACE.test(ns ?? "") || !NOTE_PATH.test(note)) return null;
    const repo = readUserState(owner.toLowerCase()).repos?.[ns];
    if (!repo || repo.visibility === "private") return null;
    return { repo, owner: owner.toLowerCase(), ns, note };
}

async function servePublic(req, res, pathname) {
    const target = publicTarget(pathname);
    if (!target) return sendText(res, 404, "no such published note");

    // /r/owner/ns → /r/owner/ns/index.md, so relative wikilinks resolve against
    // a note path rather than the namespace.
    if (pathname.slice(PUBLIC_PREFIX.length).split("/").length < 3) {
        res.writeHead(302, { Location: `${pathname.replace(/\/$/, "")}/index.md` });
        return res.end();
    }

    const { latest } = await remoteState(target.repo);
    const v = latest.get(target.note);
    if (!v) return sendText(res, 404, `not published yet: ${target.note}`);

    const md = v.payload.content ?? "";
    const wantsMarkdown = /text\/(markdown|plain)/.test(req.headers.accept ?? "");
    // Cache on the CID: a published note is immutable, so a hit is always valid.
    const headers = { "Cache-Control": "public, max-age=60", ETag: `"${v.cid}"` };
    if (wantsMarkdown) {
        res.writeHead(200, { ...headers, "Content-Type": "text/markdown; charset=utf-8" });
        return res.end(md);
    }
    res.writeHead(200, { ...headers, "Content-Type": "text/html; charset=utf-8" });
    res.end(publicPage(md, {
        title: firstHeading(md, target.note.replace(/\.md$/, "")),
        owner: target.owner, ns: target.ns, note: target.note,
        cid: v.cid, updatedAt: v.payload.updatedAt,
    }));
}

// ─── MCP over HTTP ──────────────────────────────────────────────────────────
//
// The same five tools as mcp/fangornmd.js, on the server that is already
// hosted. This is how anyone other than the person with the checkout uses it:
//
//   claude mcp add --transport http fangornmd https://host/mcp \
//     --header "Authorization: Bearer fmd_0x…"
//
// No install, no Node on the agent's side, nothing to distribute or keep in
// version step — the tools ship with the server, so every user of an instance
// gets whatever that instance is running.
//
// Stateless: one server + transport per request, no session ids. An agent
// token already identifies the caller on every call, so a session would be a
// second, weaker identity to keep in sync with the first.
//
// The tools reach the API the same way an outside client would — an HTTP call
// to this process carrying the caller's own token — rather than calling the
// route handlers directly. It costs a loopback request per tool call, which is
// nothing at this scale, and buys the guarantee that MCP cannot become a way
// around a rule the HTTP API enforces.
async function handleMcp(req, res) {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!token) return sendJson(res, 401, { error: "missing agent token — mint one in the browser (🤖) and send it as `Authorization: Bearer`" });

    const base = `http://127.0.0.1:${PORT}`;
    const server = createFangornmdServer({ call: httpCall(base, token), base });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.method === "POST" ? await readJson(req) : undefined);
}

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

    if (url.pathname === "/mcp") {
        try { return await handleMcp(req, res); }
        catch (err) { console.error(err); return sendJson(res, 500, { error: err.message }); }
    }
    if (req.method === "GET" && url.pathname === "/api/events") return handleEvents(req, res, url);
    if (req.method === "GET" && url.pathname.startsWith(PUBLIC_PREFIX)) {
        // Unauthenticated and reaching the network — its own try//catch, so a
        // gateway hiccup is a 502 rather than an unhandled rejection.
        try { return await servePublic(req, res, url.pathname); }
        catch (err) { console.error(err); return sendText(res, 502, "could not read the published namespace"); }
    }
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) return serveStatic(res, url.pathname);

    let key = `${req.method} ${url.pathname}`;
    // `?ns=` lets one agent token address every wiki its owner has, naming the
    // target per call instead of carrying it in the credential.
    const params = { ns: url.searchParams.get("ns") || null };
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
        Object.assign(params, await authenticate(bearer, req.headers["x-wallet-address"]));
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

// The room's CRDT state, kept beside the working tree so a room survives being
// evicted (last peer left) or the process restarting. Without it, the next
// visitor gets a room re-seeded from markdown with fresh identities, and a peer
// that reconnects holding the old one merges the note into itself — the whole
// body, twice. See the note in ydoc.js.
const roomStateFile = ({ owner, namespace, note }) =>
    join(DATA_DIR, ".fangorn", "rooms", owner, namespace, `${note}.json`);

const readRoomState = (target) => {
    try { return JSON.parse(readFileSync(roomStateFile(target), "utf-8")); }
    catch { return null; } // never seen, or unreadable — either way, seed instead
};

// `md` is the text this snapshot decodes to. Restoring checks it against the
// file, so a room only resumes while the file is still the one it came from.
const writeRoomState = (target, doc, md) => {
    const file = roomStateFile(target);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ md, update: encodeRoomState(doc) }), "utf-8");
};

// Retire a note's room: the snapshot AND the live doc, if anyone is still in
// it. A room outlives the file it mirrors — its debounced flush, and the write
// the last peer triggers on leaving, both re-create the file from memory. That
// is how a rename left the old name sitting on disk beside the new one. So the
// doc is disarmed and evicted before the file moves; the client reconnects to
// the room named after the new file.
const closeRoom = (owner, namespace, note) => {
    const room = `${owner}:${namespace}:${note}`;
    const doc = yRooms.get(room);
    if (doc) {
        doc.flushToDisk = undefined; // writeState on the last disconnect is now a no-op
        yRooms.delete(room);
        for (const conn of doc.conns.keys()) conn.close();
        doc.destroy();
    }
    rmSync(roomStateFile({ owner, namespace, note }), { force: true });
};

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
            const md = readFileSync(target.file, "utf-8");
            const saved = readRoomState(target);
            // Resume the room where it left off, but only while its snapshot
            // still decodes to what's on disk. Anything else means the file
            // moved on underneath it (a pull, an external editor) and the file
            // wins — which is the one case worth minting new identities for.
            if (saved?.md === md) applyRoomState(doc, saved.update);
            else {
                seedFromMarkdown(xml, md);
                // Snapshot the seed immediately: a peer can join, hold this
                // exact state, and reconnect after an eviction without ever
                // having typed a character.
                writeRoomState(target, doc, md);
            }
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
            writeRoomState(target, doc, md);
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
    try { ({ address } = await authenticate(url.searchParams.get("token"), url.searchParams.get("address"))); }
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

const appOwner = await assertAppRegistered();

server.listen(PORT, () => {
    mkdirSync(USERS_DIR, { recursive: true });
    console.log(`fangornmd server → http://localhost:${PORT}`);
    console.log(`  mode:    multi-tenant relay (self-custodial — holds no user keys)`);
    console.log(`  service: ${fangorn.getAddress()} (engine + Pinata only)`);
    console.log(`  app:     fangornmd ${APP_ID} (owner ${appOwner})`);
    console.log(`  privy:   ${PRIVY_APP_ID}`);
    console.log(`  mcp:     POST /mcp (agent token as Bearer)`);
});

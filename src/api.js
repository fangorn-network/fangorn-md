// Thin client for the fangornmd server (see server/index.js). The Vite dev
// server proxies /api to it, so the browser sees a single origin.
//
// Every request carries the Privy access token (set once at login via
// setTokenGetter) so the server can identify the caller. The token getter is
// injected rather than imported to keep this module free of React.

let tokenGetter = null;
let walletAddress = null;
export const setTokenGetter = (fn) => { tokenGetter = fn; };
export const setAddress = (addr) => { walletAddress = addr; };

async function authHeaders(extra) {
    const token = tokenGetter ? await tokenGetter() : null;
    return {
        ...extra,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(walletAddress ? { "X-Wallet-Address": walletAddress } : {}),
    };
}

async function json(res) {
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
}

const get = async (url) => fetch(url, { headers: await authHeaders() }).then(json);

const post = async (url, body) =>
    fetch(url, {
        method: "POST",
        headers: await authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body ?? {}),
    }).then(json);

export const api = {
    repo: () => get("/api/repo"),
    repos: () => get("/api/repos"),
    createRepo: (namespace, visibility) => post("/api/repos", { namespace, visibility }),
    followRepo: (owner, namespace) => post("/api/repos/follow", { owner, namespace }),
    setActiveRepo: (namespace) => post("/api/repos/active", { namespace }),
    // Rebuild the repo list from the chain — this relay may never have seen you.
    discoverRepos: () => post("/api/repos/discover"),
    // Owner-only: the addresses allowed to co-edit this namespace's working tree.
    setCollaborators: async (namespace, collaborators) =>
        fetch("/api/collaborators", {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ namespace, collaborators }),
        }).then(json),
    notes: () => get("/api/notes"),
    note: (path) => get(`/api/notes/${encodeURIComponent(path)}`),
    // `ns` names the target namespace instead of leaning on the server's active
    // pointer. Any write that spans an await the user can interrupt — a wallet
    // prompt, most of all — must name it, or the switch they make while waiting
    // redirects the write into whatever namespace is active when it lands.
    // `parent` files the new note under another note in the stored tree — the
    // same "inside" drop the drag does, which is how a note gets created
    // already nested instead of created then dragged.
    save: async (path, content, ns, parent) =>
        fetch(`/api/notes/${encodeURIComponent(path)}${ns ? `?ns=${encodeURIComponent(ns)}` : ""}`, {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify(parent ? { content, parent } : { content }),
        }).then(json),
    deleteNote: async (path) =>
        fetch(`/api/notes/${encodeURIComponent(path)}`, { method: "DELETE", headers: await authHeaders() }).then(json),
    deleteNotes: (paths) => post("/api/notes/delete", { paths }),
    renameNote: (path, to) => post(`/api/notes/${encodeURIComponent(path)}/rename`, { to }),
    // Local delete: stop tracking, remove the working tree. Published commits
    // stay on-chain — nothing can unpublish those.
    deleteRepo: (namespace) => post("/api/repos/delete", { namespace }),
    saveTree: async (tree) =>
        fetch("/api/tree", {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ tree }),
        }).then(json),
    // Agent tokens: long-lived credentials for an MCP client (see mcp/fangornmd.js).
    // The token itself comes back only from mint — the server stores its hash.
    tokens: () => get("/api/tokens"),
    // namespace null → the token reaches every wiki this user tracks.
    mintToken: (namespace, name) => post("/api/tokens", { namespace, name }),
    revokeToken: (hash) => post("/api/tokens/revoke", { hash }),
    remote: () => get("/api/remote"),
    history: () => get("/api/history"),
    pull: (ns) => post(`/api/pull${ns ? `?ns=${encodeURIComponent(ns)}` : ""}`),
    // Self-custodial publish: server builds the commit (keyless) and returns the
    // unsigned settlement tx; the browser signs+sends it, then reports back.
    // `confirmDrop` acknowledges that this publish removes notes from the
    // namespace (a publish is a snapshot; see the 409 from prepare).
    publishPrepare: (message, sealed, confirmDrop) =>
        post("/api/publish/prepare", { message, sealed, confirmDrop }),
    settle: (namespace, commitCid, txHash) => post("/api/settle", { namespace, commitCid, txHash }),
};

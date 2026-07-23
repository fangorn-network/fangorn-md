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
    // Owner-only: the addresses allowed to co-edit this namespace's working tree.
    setCollaborators: async (namespace, collaborators) =>
        fetch("/api/collaborators", {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ namespace, collaborators }),
        }).then(json),
    notes: () => get("/api/notes"),
    note: (path) => get(`/api/notes/${encodeURIComponent(path)}`),
    save: async (path, content) =>
        fetch(`/api/notes/${encodeURIComponent(path)}`, {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ content }),
        }).then(json),
    deleteNote: async (path) =>
        fetch(`/api/notes/${encodeURIComponent(path)}`, { method: "DELETE", headers: await authHeaders() }).then(json),
    renameNote: (path, to) => post(`/api/notes/${encodeURIComponent(path)}/rename`, { to }),
    saveTree: async (tree) =>
        fetch("/api/tree", {
            method: "PUT",
            headers: await authHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ tree }),
        }).then(json),
    remote: () => get("/api/remote"),
    history: () => get("/api/history"),
    pull: () => post("/api/pull"),
    // Self-custodial publish: server builds the commit (keyless) and returns the
    // unsigned settlement tx; the browser signs+sends it, then reports back.
    publishPrepare: (message, sealed) => post("/api/publish/prepare", { message, sealed }),
    settle: (namespace, commitCid, txHash) => post("/api/settle", { namespace, commitCid, txHash }),
};

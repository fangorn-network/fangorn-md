// Thin client for the local fangornmd server (see server/index.js). The Vite
// dev server proxies /api to it, so the browser sees a single origin.

async function json(res) {
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body;
}

const post = (url, body) =>
    fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body ?? {}),
    }).then(json);

export const api = {
    repo: () => fetch("/api/repo").then(json),
    repos: () => fetch("/api/repos").then(json),
    createRepo: (namespace, visibility) => post("/api/repos", { namespace, visibility }),
    followRepo: (owner, namespace) => post("/api/repos/follow", { owner, namespace }),
    setActiveRepo: (namespace) => post("/api/repos/active", { namespace }),
    notes: () => fetch("/api/notes").then(json),
    note: (path) => fetch(`/api/notes/${encodeURIComponent(path)}`).then(json),
    save: (path, content) =>
        fetch(`/api/notes/${encodeURIComponent(path)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content }),
        }).then(json),
    remote: () => fetch("/api/remote").then(json),
    history: () => fetch("/api/history").then(json),
    pull: () => post("/api/pull"),
    publish: (message) => post("/api/publish", { message }),
};

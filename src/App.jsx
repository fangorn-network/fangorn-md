import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets, useSignMessage } from "@privy-io/react-auth";
import { api, setTokenGetter, setAddress } from "./api.js";
import { deriveSecret, sealContent } from "./crypto.js";
import { useEvents } from "./useEvents.js";
import { buildBacklinks, moveInTree } from "./structure.js";
import Editor, { CollabEditor } from "./Editor.jsx";

const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "");

// How long after our own save to treat an incoming "local-change" as our echo.
// The server's watcher debounces 200ms before emitting, so this only has to
// outlast that plus SSE delivery.
const SELF_WRITE_MS = 1500;

// Parse a repo reference to follow: a pasted share URL (?owner=&ns=&note=), or
// a bare "owner/namespace". Returns { owner, ns, note } or null.
export function parseRepoRef(input) {
    const s = (input ?? "").trim();
    try {
        const u = new URL(s);
        const owner = u.searchParams.get("owner"), ns = u.searchParams.get("ns");
        if (owner && ns) return { owner, ns, note: u.searchParams.get("note") };
    } catch { /* not a URL, fall through */ }
    const m = s.match(/^(0x[0-9a-fA-F]{40})\s*\/\s*(.+)$/);
    return m ? { owner: m[1], ns: m[2].trim(), note: null } : null;
}

// One node of the explicit page tree (stored server-side; see structure.js),
// rendered recursively. Writers can drag to reorder/nest and rename/delete.
function TreeRow({ node, depth, notes, active, writable, onOpen, onMove, onRename, onDelete }) {
    const [zone, setZone] = useState(null); // "before" | "inside" | "after"
    const title = notes.find((n) => n.path === node.path)?.title ?? node.path.replace(/\.md$/, "");

    const onDragOver = (e) => {
        if (!writable) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const y = (e.clientY - r.top) / r.height;
        setZone(y < 0.3 ? "before" : y > 0.7 ? "after" : "inside");
    };
    const onDrop = (e) => {
        e.preventDefault();
        e.stopPropagation();
        const drag = e.dataTransfer.getData("text/path");
        if (drag && zone) onMove(drag, node.path, zone);
        setZone(null);
    };

    return (
        <>
            <div
                className={`tree-row ${zone ? `drop-${zone}` : ""}`}
                draggable={writable}
                onDragStart={(e) => e.dataTransfer.setData("text/path", node.path)}
                onDragOver={onDragOver}
                onDragLeave={() => setZone(null)}
                onDrop={onDrop}
            >
                <button
                    className={`note-item ${node.path === active ? "active" : ""}`}
                    style={{ paddingLeft: `${10 + depth * 16}px` }}
                    onClick={() => onOpen(node.path)}
                    title={node.path}
                >
                    <span className="tree-glyph">{depth > 0 ? "└ " : ""}</span>
                    {title}
                </button>
                {writable && (
                    <span className="tree-actions">
                        <button className="tree-act" title="Rename" onClick={() => onRename(node.path)}>✎</button>
                        <button className="tree-act" title="Delete" onClick={() => onDelete(node.path)}>✕</button>
                    </span>
                )}
            </div>
            {node.children.map((child) => (
                <TreeRow
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    notes={notes}
                    active={active}
                    writable={writable}
                    onOpen={onOpen}
                    onMove={onMove}
                    onRename={onRename}
                    onDelete={onDelete}
                />
            ))}
        </>
    );
}

// The repo switcher: every tracked Fangorn namespace, plus inline forms to
// create one on your own root (public or private/encrypted) or follow someone
// else's read-only. A dot marks repos with an unseen on-chain update.
function RepoBar({ repos, active, nudges, onSwitch, onCreate, onFollow }) {
    const [form, setForm] = useState(null); // "new" | "follow" | null
    const [name, setName] = useState("");
    const [visibility, setVisibility] = useState("public");
    const [ref, setRef] = useState("");

    const submitNew = (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name.trim(), visibility);
        setName(""); setVisibility("public"); setForm(null);
    };
    const submitFollow = (e) => {
        e.preventDefault();
        if (!ref.trim()) return;
        onFollow(ref.trim());
        setRef(""); setForm(null);
    };

    return (
        <div className="repo-bar">
            <div className="repo-bar-head">
                <span className="repo-bar-label">your namespaces</span>
                <span className="repo-bar-actions">
                    <button className="btn ghost small" title="New namespace" onClick={() => setForm(form === "new" ? null : "new")}>＋</button>
                    <button className="btn ghost small" title="Subscribe to a namespace" onClick={() => setForm(form === "follow" ? null : "follow")}>⌕</button>
                </span>
            </div>
            <div className="repo-switch">
                {repos.map((r) => (
                    <button
                        key={r.namespace}
                        className={`repo-item ${r.namespace === active ? "active" : ""}`}
                        onClick={() => onSwitch(r.namespace)}
                        title={`${r.namespace} · owner ${r.owner}`}
                    >
                        <span className="repo-name">{r.namespace}</span>
                        {nudges[r.namespace] && r.namespace !== active && <span className="repo-dot" title="on-chain update" />}
                        {r.visibility === "private" && <span className="repo-badge" title="private (encrypted)">🔒</span>}
                        {!r.writable && <span className="repo-badge" title="read-only subscription">👁</span>}
                    </button>
                ))}
            </div>
            {form === "new" && (
                <form className="repo-form" onSubmit={submitNew}>
                    <input className="repo-input" placeholder="namespace (e.g. images)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                    <select className="repo-input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                        <option value="public">public</option>
                        <option value="private">private (encrypted)</option>
                    </select>
                    <button className="btn small primary" type="submit">Create</button>
                </form>
            )}
            {form === "follow" && (
                <form className="repo-form" onSubmit={submitFollow}>
                    <input className="repo-input" placeholder="paste a share link or owner/namespace" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus />
                    <button className="btn small primary" type="submit">Subscribe</button>
                </form>
            )}
        </div>
    );
}

// Owner-only: the addresses allowed to co-edit this namespace's working tree.
// This is a working-tree grant — collaborators write into the owner's files and
// co-edit live, but settling a publish on-chain stays with the owner's wallet.
function CollaboratorPanel({ repo, onSave, onClose }) {
    const [text, setText] = useState((repo.collaborators ?? []).join("\n"));
    return (
        <form
            className="collab-panel"
            onSubmit={(e) => { e.preventDefault(); onSave(text.split(/[\s,]+/).filter(Boolean)); }}
        >
            <label className="collab-panel-label">
                Collaborators — one wallet address per line. They can edit every note here; only you can publish.
            </label>
            <textarea
                className="repo-input collab-panel-input"
                rows={4}
                spellCheck={false}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="0x…"
                autoFocus
            />
            <div className="collab-panel-actions">
                <button className="btn small primary" type="submit">Save</button>
                <button className="btn ghost small" type="button" onClick={onClose}>Close</button>
            </div>
        </form>
    );
}

export default function App({ address, onLogout }) {
    const { getAccessToken } = usePrivy();
    const { wallets } = useWallets();
    const { signMessage } = useSignMessage();

    // Send a tx from the user's embedded wallet, explicitly resolved (don't rely
    // on Privy's implicit default-wallet pick). Returns the tx hash.
    const sendFromWallet = useCallback(async (tx) => {
        const wallet =
            wallets.find((w) => w.address?.toLowerCase() === address?.toLowerCase()) ??
            wallets.find((w) => w.walletClientType === "privy") ??
            wallets[0];
        if (!wallet) throw new Error("no wallet available — is Privy still loading?");
        await wallet.switchChain(tx.chainId);
        const provider = await wallet.getEthereumProvider();
        const params = { from: wallet.address, to: tx.to, data: tx.data };
        // Explicit fees AND gas limit from the server, so the wallet never runs
        // its own estimation — that's what shows as "Network fee Unavailable" when
        // the public Arbitrum Sepolia RPC rate-limits eth_estimateGas.
        if (tx.gas) params.gas = tx.gas;
        if (tx.maxFeePerGas) params.maxFeePerGas = tx.maxFeePerGas;
        if (tx.maxPriorityFeePerGas) params.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
        return provider.request({ method: "eth_sendTransaction", params: [params] });
    }, [wallets, address]);
    // Adapter: crypto.deriveSecret wants an async (msg) → hex-signature fn.
    // Pass the address so Privy resolves the *connected* wallet (MetaMask) when
    // there's no embedded wallet — without it the hook throws
    // EMBEDDED_WALLET_NOT_FOUND for wallet-auth logins.
    const signForKey = useCallback(async (msg) => {
        const r = await signMessage({ message: msg }, { address });
        return r?.signature ?? r;
    }, [signMessage, address]);
    // Wire identity into the api layer before any effect fires (this component
    // only mounts once authenticated, so it's always valid here).
    setTokenGetter(getAccessToken);
    setAddress(address);

    const [repos, setRepos] = useState([]); // all tracked repos
    const [repo, setRepo] = useState(null); // the active one
    const [notes, setNotes] = useState([]);
    const [tree, setTree] = useState([]); // explicit page hierarchy (stored)
    const [active, setActive] = useState(null);
    const [content, setContent] = useState("");
    const [saveState, setSaveState] = useState("saved"); // saved | unsaved | saving
    const [nudges, setNudges] = useState({}); // namespace → last on-chain NamespaceChange
    const [status, setStatus] = useState(null); // { kind: ok|err|busy, text, tx? }
    const [showCollabs, setShowCollabs] = useState(false);
    // Off-canvas sidebar; only ever visible on narrow screens (see styles.css).
    const [navOpen, setNavOpen] = useState(false);
    // An incoming share link (?owner=&ns=&note=) — parsed once on mount.
    const [share, setShare] = useState(() => {
        const p = new URLSearchParams(window.location.search);
        const owner = p.get("owner"), ns = p.get("ns");
        return owner && ns ? { owner, ns, note: p.get("note") } : null;
    });
    const saveTimer = useRef(null);
    const lastSaveRef = useRef(0); // when we last wrote — see onLocalChange
    const dirtyRef = useRef(false);
    dirtyRef.current = saveState !== "saved";

    const refreshNotes = useCallback(async () => {
        const { notes, tree } = await api.notes();
        setNotes(notes);
        setTree(tree ?? []);
        return notes;
    }, []);

    const openNote = useCallback(async (path) => {
        const note = await api.note(path);
        setActive(path);
        setContent(note.content);
        setSaveState("saved");
        setNavOpen(false); // on mobile the drawer covers the note you just picked
    }, []);

    // Load the active repo's pointer + notes and open its index (or first note).
    const loadActive = useCallback(async () => {
        const { active: activeNs, repos } = await api.repos();
        setRepos(repos);
        const current = repos.find((r) => r.namespace === activeNs) ?? null;
        setRepo(current);
        const list = await refreshNotes();
        const first = list.find((n) => n.path === "index.md") ?? list[0];
        if (first) await openNote(first.path);
        else { setActive(null); setContent(""); }
        return current;
    }, [refreshNotes, openNote]);

    // Boot.
    useEffect(() => {
        loadActive().catch((err) =>
            setStatus({ kind: "err", text: `server unreachable: ${err.message}` }));
    }, [loadActive]);

    // Autosave: every keystroke marks the note dirty; 600ms of quiet flushes it
    // to disk. Publishing is a separate, explicit act.
    const onChange = (next) => {
        setContent(next);
        setSaveState("unsaved");
        clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(async () => {
            setSaveState("saving");
            try {
                await api.save(active, next);
                lastSaveRef.current = Date.now();
                setSaveState("saved");
            } catch (err) {
                setSaveState("unsaved");
                setStatus({ kind: "err", text: `save failed: ${err.message}` });
            }
        }, 600);
    };

    useEvents({
        // The active repo's dir changed on disk (external editor, a pull):
        // refresh the sidebar, reload the open note unless there are unsaved edits.
        onLocalChange: async () => {
            // …but our OWN autosave writes that dir too, and the server's watcher
            // can't tell who wrote. Without this guard every save bounced back as
            // two refetches plus a setContent, which lands mid-typing and can
            // reset the caret — the editor felt laggy and ate backspaces.
            if (Date.now() - lastSaveRef.current < SELF_WRITE_MS) return;
            const list = await refreshNotes();
            if (active && !dirtyRef.current && list.some((n) => n.path === active)) {
                const note = await api.note(active);
                setContent((cur) => (dirtyRef.current ? cur : note.content));
            }
        },
        // A new commit settled on-chain for some tracked repo. Don't touch local
        // files — just record the nudge, keyed by namespace.
        onRemoteChange: (change) =>
            setNudges((n) => ({ ...n, [change.namespace]: change })),
    }, { getToken: getAccessToken, address });

    const switchRepo = async (namespace) => {
        if (namespace === repo?.namespace) return;
        try {
            await api.setActiveRepo(namespace);
            await loadActive();
        } catch (err) {
            setStatus({ kind: "err", text: `switch failed: ${err.message}` });
        }
    };

    const createRepo = async (namespace, visibility) => {
        setStatus({ kind: "busy", text: `creating ${namespace}…` });
        try {
            await api.createRepo(namespace, visibility);
            await loadActive();
            setStatus({ kind: "ok", text: `created ${namespace} (${visibility}) — Publish to settle it on-chain` });
        } catch (err) {
            setStatus({ kind: "err", text: `create failed: ${err.message}` });
        }
    };

    // Subscribe to someone else's repo: follow (idempotent), make it active, pull
    // its notes, and open the shared page. Shared by the follow form and the
    // incoming-share banner so both give the same one-step "paste → read" flow.
    const subscribe = async ({ owner, ns, note }) => {
        setStatus({ kind: "busy", text: `subscribing to ${ns}…` });
        try {
            try { await api.followRepo(owner, ns); }
            catch (e) { if (!/already tracking/i.test(e.message)) throw e; }
            await api.setActiveRepo(ns);
            await api.pull();
            const joined = await loadActive();
            if (note) await openNote(note).catch(() => {});
            setStatus({
                kind: "ok",
                text: joined?.writable
                    ? `joined ${ns} as a collaborator — edits are live; ${short(joined.owner)} publishes`
                    : `subscribed to ${ns} (read-only — you'll still see edits live)`,
            });
        } catch (err) {
            setStatus({ kind: "err", text: `subscribe failed: ${err.message}` });
        }
    };

    // From the follow form: accepts a pasted share link or "owner/namespace".
    const followRepo = (input) => {
        const ref = parseRepoRef(input);
        if (!ref) { setStatus({ kind: "err", text: "not a share link or owner/namespace" }); return; }
        subscribe(ref);
    };

    const pull = async () => {
        setStatus({ kind: "busy", text: "pulling from the network…" });
        try {
            const { written } = await api.pull();
            setNudges((n) => { const c = { ...n }; delete c[repo?.namespace]; return c; });
            await refreshNotes();
            setStatus({ kind: "ok", text: written.length ? `pulled ${written.length} note(s): ${written.join(", ")}` : "already up to date" });
        } catch (err) {
            setStatus({ kind: "err", text: `pull failed: ${err.message}` });
        }
    };

    // Sharing (public repos): copy a link that lets a friend follow this repo.
    // The repo is already public on-chain — the link just carries (owner, ns) so
    // their app can clone it; ?note focuses one page on open.
    const shareLink = () => {
        if (!repo) return;
        const url = new URL(window.location.origin + window.location.pathname);
        url.searchParams.set("owner", repo.owner);
        url.searchParams.set("ns", repo.namespace);
        if (active) url.searchParams.set("note", active);
        navigator.clipboard?.writeText(url.toString());
        setStatus({
            kind: "ok",
            text: repo.head ? "share link copied — anyone can paste it to subscribe" : "link copied — Publish first so subscribers see anything",
        });
    };

    const saveCollaborators = async (list) => {
        try {
            const updated = await api.setCollaborators(repo.namespace, list);
            setRepo(updated);
            setRepos((rs) => rs.map((r) => (r.namespace === updated.namespace ? updated : r)));
            setShowCollabs(false);
            setStatus({
                kind: "ok",
                text: updated.collaborators.length
                    ? `${updated.collaborators.length} collaborator(s) — send them the Share link so they can open it`
                    : "collaborators cleared",
            });
        } catch (err) {
            setStatus({ kind: "err", text: `collaborators failed: ${err.message}` });
        }
    };

    const cleanShareUrl = () => window.history.replaceState({}, "", window.location.pathname);

    // Accept an incoming share link: same subscribe flow, then clear the banner.
    const acceptShare = async () => {
        await subscribe(share);
        setShare(null);
        cleanShareUrl();
    };

    const publish = async () => {
        const message = window.prompt("Commit message", "update wiki");
        if (message === null) return;
        try {
            const started = Date.now();

            // Private repo: seal every note in the browser so the server only
            // ever receives ciphertext it can't read.
            let sealed;
            if (repo?.visibility === "private") {
                setStatus({ kind: "busy", text: "unlocking your encryption key…" });
                const secret = await deriveSecret(signForKey);
                setStatus({ kind: "busy", text: "encrypting notes…" });
                sealed = {};
                for (const n of notes) {
                    const { content } = await api.note(n.path);
                    sealed[n.path] = sealContent(repo.namespace, n.path, content, secret);
                }
            }

            setStatus({ kind: "busy", text: "preparing commit…" });
            const { namespace, commitCid, staged, tx } = await api.publishPrepare(message, sealed);

            // The server built the commit but holds no key: WE sign the one
            // settlement tx with our own wallet.
            setStatus({ kind: "busy", text: "approve the transaction in your wallet…" });
            const txHash = await sendFromWallet(tx);

            setStatus({ kind: "busy", text: "recording the new head…" });
            await api.settle(namespace, commitCid, txHash);
            setStatus({
                kind: "ok",
                text: `published ${short(commitCid)} (${staged.vertices} notes, ${staged.edges} links) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
                tx: txHash,
            });
        } catch (err) {
            setStatus({ kind: "err", text: `publish failed: ${err.message}` });
        }
    };

    const newNote = async () => {
        const name = window.prompt("Note name (e.g. ideas)");
        if (!name) return;
        const path = name.endsWith(".md") ? name : `${name}.md`;
        try {
            await api.save(path, `# ${name.replace(/\.md$/, "")}\n\n`);
            await refreshNotes();
            await openNote(path);
        } catch (err) {
            setStatus({ kind: "err", text: err.message });
        }
    };

    // Drag-and-drop reorder/nest: apply the move locally, then persist the whole
    // tree. On failure, re-sync from the server so the sidebar can't drift.
    const moveNote = async (dragPath, targetPath, pos) => {
        const next = moveInTree(tree, dragPath, targetPath, pos);
        if (next === tree) return;
        setTree(next);
        try { const { tree: saved } = await api.saveTree(next); setTree(saved); }
        catch (err) { setStatus({ kind: "err", text: `move failed: ${err.message}` }); refreshNotes(); }
    };

    const renameNoteAt = async (path) => {
        const to = window.prompt("Rename note to", path.replace(/\.md$/, ""));
        if (!to) return;
        try {
            const { path: newPath } = await api.renameNote(path, to);
            await refreshNotes();
            if (active === path) await openNote(newPath);
        } catch (err) {
            setStatus({ kind: "err", text: `rename failed: ${err.message}` });
        }
    };

    const deleteNoteAt = async (path) => {
        if (!window.confirm(`Delete ${path}? It's removed from your working tree (published history is kept).`)) return;
        try {
            await api.deleteNote(path);
            const list = await refreshNotes();
            if (active === path) {
                const first = list.find((n) => n.path === "index.md") ?? list[0];
                if (first) await openNote(first.path);
                else { setActive(null); setContent(""); }
            }
        } catch (err) {
            setStatus({ kind: "err", text: `delete failed: ${err.message}` });
        }
    };

    const navigate = async (path) => {
        if (notes.some((n) => n.path === path)) await openNote(path);
        else setStatus({ kind: "err", text: `no such note: ${path}` });
    };

    const activeTitle = notes.find((n) => n.path === active)?.title ?? active;
    const backlinks = useMemo(() => buildBacklinks(notes), [notes]);
    const activeBacklinks = (backlinks.get(active) ?? []).map((p) => ({
        path: p,
        title: notes.find((n) => n.path === p)?.title ?? p,
    }));
    const activeNudge = repo && nudges[repo.namespace];

    return (
        <div className="app">
            <aside className={`sidebar${navOpen ? " open" : ""}`}>
                <div className="sidebar-head">
                    <span className="brand">🌲 fangornmd</span>
                    <button className="btn small" onClick={newNote} title="New note">＋</button>
                </div>
                <div className="account-bar">
                    <button
                        className="account-addr"
                        title={address ? `${address} — click to copy` : "no wallet"}
                        disabled={!address}
                        onClick={() => {
                            navigator.clipboard?.writeText(address);
                            setStatus({ kind: "ok", text: "wallet address copied" });
                        }}
                    >
                        {address ? short(address) : "no wallet"}
                    </button>
                    <button className="btn ghost small" onClick={onLogout} title="Log out">log out</button>
                </div>
                <RepoBar
                    repos={repos}
                    active={repo?.namespace}
                    nudges={nudges}
                    onSwitch={switchRepo}
                    onCreate={createRepo}
                    onFollow={followRepo}
                />
                <nav
                    className="note-list"
                    onDragOver={(e) => repo?.writable && e.preventDefault()}
                    onDrop={(e) => {
                        // Dropped on empty space → move to the end of the top level.
                        const drag = e.dataTransfer.getData("text/path");
                        const last = tree[tree.length - 1];
                        if (drag && last && drag !== last.path) moveNote(drag, last.path, "after");
                    }}
                >
                    {tree.map((node) => (
                        <TreeRow
                            key={node.path}
                            node={node}
                            depth={0}
                            notes={notes}
                            active={active}
                            writable={!!repo?.writable}
                            onOpen={openNote}
                            onMove={moveNote}
                            onRename={renameNoteAt}
                            onDelete={deleteNoteAt}
                        />
                    ))}
                    {tree.length === 0 && <div className="tree-section">no notes yet</div>}
                </nav>
                {repo && (
                    <footer className="repo-info">
                        <div>
                            <b>{repo.namespace}</b> · {repo.visibility}
                            {repo.isOwner ? "" : repo.writable ? " · collaborator" : " · read-only"}
                        </div>
                        <div title={repo.owner}>owner {short(repo.owner)}</div>
                        {repo.isOwner && repo.collaborators?.length > 0 && (
                            <div title={repo.collaborators.join("\n")}>{repo.collaborators.length} collaborator(s)</div>
                        )}
                        <div title={repo.head ?? ""}>head {repo.head ? short(repo.head) : "(none)"}</div>
                    </footer>
                )}
            </aside>
            {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

            <main className="main">
                {share && (
                    <div className="banner">
                        🔗 A namespace was shared with you — <b>{share.ns}</b> by {short(share.owner)}
                        {share.note ? ` · ${share.note}` : ""}.
                        <button className="btn" onClick={acceptShare} disabled={status?.kind === "busy"}>Subscribe &amp; open</button>
                        <button className="btn ghost" onClick={() => { setShare(null); cleanShareUrl(); }}>Dismiss</button>
                    </div>
                )}
                {activeNudge && (
                    <div className="banner">
                        <b>{repo.namespace}</b> updated on-chain (block {activeNudge.blockNumber},{" "}
                        {activeNudge.addedVertices?.length ?? 0} new version(s)).
                        <button className="btn" onClick={pull}>Pull</button>
                        <button className="btn ghost" onClick={() => setNudges((n) => { const c = { ...n }; delete c[repo.namespace]; return c; })}>Dismiss</button>
                    </div>
                )}
                <header className="topbar">
                    <button
                        className="btn ghost nav-toggle"
                        onClick={() => setNavOpen((v) => !v)}
                        aria-label="Notes"
                        aria-expanded={navOpen}
                    >
                        ☰
                    </button>
                    <span className="doc-title">{activeTitle ?? "—"}</span>
                    {/* Public notes live in the shared room — the server persists
                        them, so there's no local save state to report. */}
                    {repo?.visibility !== "public" && (
                        <span className={`save-state ${saveState}`}>{saveState}</span>
                    )}
                    <span className="spacer" />
                    {repo && repo.visibility !== "private" && (
                        <button className="btn share" onClick={shareLink} title="Copy a link — anyone can paste it to subscribe to this namespace">
                            🔗 Share
                        </button>
                    )}
                    {repo?.isOwner && repo.visibility !== "private" && (
                        <button
                            className="btn"
                            onClick={() => setShowCollabs((v) => !v)}
                            title="Choose who can co-edit this namespace"
                        >
                            👥 {repo.collaborators?.length ?? 0}
                        </button>
                    )}
                    {repo?.isOwner && (
                        <button className="btn primary" onClick={publish} disabled={status?.kind === "busy"}>
                            Publish
                        </button>
                    )}
                </header>
                {showCollabs && repo?.isOwner && (
                    <CollaboratorPanel
                        key={repo.namespace}
                        repo={repo}
                        onSave={saveCollaborators}
                        onClose={() => setShowCollabs(false)}
                    />
                )}
                {status && (
                    <div className={`status ${status.kind}`}>
                        {status.text}
                        {status.tx && (
                            <a href={`https://sepolia.arbiscan.io/tx/${status.tx}`} target="_blank" rel="noreferrer">
                                view tx ↗
                            </a>
                        )}
                        <button className="btn ghost" onClick={() => setStatus(null)}>×</button>
                    </div>
                )}
                {active ? (
                    <>
                        {/* Everyone on a public namespace joins the live room —
                            read-only subscribers included, so they watch it
                            change instead of staring at their last pull. The
                            server seeds the room and persists it, and drops
                            writes from anyone who isn't a collaborator. */}
                        {repo && repo.visibility === "public" ? (
                            <CollabEditor
                                key={`${repo.owner}:${repo.namespace}:${active}`}
                                owner={repo.owner}
                                namespace={repo.namespace}
                                note={active}
                                onNavigate={navigate}
                                address={address}
                                getToken={getAccessToken}
                                readOnly={!repo.writable}
                            />
                        ) : (
                            <Editor
                                content={content}
                                onChange={onChange}
                                onNavigate={navigate}
                                noteKey={active}
                                readOnly={!repo?.writable}
                            />
                        )}
                        {activeBacklinks.length > 0 && (
                            <footer className="backlinks">
                                linked from:
                                {activeBacklinks.map((b) => (
                                    <button key={b.path} className="btn small" onClick={() => openNote(b.path)}>
                                        {b.title}
                                    </button>
                                ))}
                            </footer>
                        )}
                    </>
                ) : (
                    <div className="empty">No notes yet — create one, or Pull if this is a subscribed namespace.</div>
                )}
            </main>
        </div>
    );
}

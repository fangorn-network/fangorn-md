import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { useEvents } from "./useEvents.js";
import { buildTree, buildBacklinks } from "./structure.js";
import Editor from "./Editor.jsx";

const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "");

// One node of the inferred wiki tree (see structure.js), rendered recursively.
function TreeNode({ path, depth, tree, notes, active, onOpen }) {
    const note = notes.find((n) => n.path === path);
    if (!note) return null;
    return (
        <>
            <button
                className={`note-item ${path === active ? "active" : ""}`}
                style={{ paddingLeft: `${10 + depth * 16}px` }}
                onClick={() => onOpen(path)}
                title={path}
            >
                <span className="tree-glyph">{depth > 0 ? "└ " : ""}</span>
                {note.title}
            </button>
            {(tree.children.get(path) ?? []).map((child) => (
                <TreeNode
                    key={child}
                    path={child}
                    depth={depth + 1}
                    tree={tree}
                    notes={notes}
                    active={active}
                    onOpen={onOpen}
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
    const [owner, setOwner] = useState("");

    const submitNew = (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        onCreate(name.trim(), visibility);
        setName(""); setVisibility("public"); setForm(null);
    };
    const submitFollow = (e) => {
        e.preventDefault();
        if (!owner.trim() || !name.trim()) return;
        onFollow(owner.trim(), name.trim());
        setName(""); setOwner(""); setForm(null);
    };

    return (
        <div className="repo-bar">
            <div className="repo-bar-head">
                <span className="repo-bar-label">repos</span>
                <span className="repo-bar-actions">
                    <button className="btn ghost small" title="New repo" onClick={() => setForm(form === "new" ? null : "new")}>＋</button>
                    <button className="btn ghost small" title="Follow a repo" onClick={() => setForm(form === "follow" ? null : "follow")}>⌕</button>
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
                        {!r.writable && <span className="repo-badge" title="read-only follow">👁</span>}
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
                    <input className="repo-input" placeholder="owner 0x…" value={owner} onChange={(e) => setOwner(e.target.value)} autoFocus />
                    <input className="repo-input" placeholder="namespace" value={name} onChange={(e) => setName(e.target.value)} />
                    <button className="btn small primary" type="submit">Follow</button>
                </form>
            )}
        </div>
    );
}

export default function App() {
    const [repos, setRepos] = useState([]); // all tracked repos
    const [repo, setRepo] = useState(null); // the active one
    const [notes, setNotes] = useState([]);
    const [active, setActive] = useState(null);
    const [content, setContent] = useState("");
    const [saveState, setSaveState] = useState("saved"); // saved | unsaved | saving
    const [nudges, setNudges] = useState({}); // namespace → last on-chain NamespaceChange
    const [status, setStatus] = useState(null); // { kind: ok|err|busy, text, tx? }
    const saveTimer = useRef(null);
    const dirtyRef = useRef(false);
    dirtyRef.current = saveState !== "saved";

    const refreshNotes = useCallback(async () => {
        const { notes } = await api.notes();
        setNotes(notes);
        return notes;
    }, []);

    const openNote = useCallback(async (path) => {
        const note = await api.note(path);
        setActive(path);
        setContent(note.content);
        setSaveState("saved");
    }, []);

    // Load the active repo's pointer + notes and open its index (or first note).
    const loadActive = useCallback(async () => {
        const { active: activeNs, repos } = await api.repos();
        setRepos(repos);
        setRepo(repos.find((r) => r.namespace === activeNs) ?? null);
        const list = await refreshNotes();
        const first = list.find((n) => n.path === "index.md") ?? list[0];
        if (first) await openNote(first.path);
        else { setActive(null); setContent(""); }
        return activeNs;
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
    });

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
        setStatus({ kind: "busy", text: `initializing ${namespace} on-chain…` });
        try {
            await api.createRepo(namespace, visibility);
            await loadActive();
            setStatus({ kind: "ok", text: `created ${namespace} (${visibility})` });
        } catch (err) {
            setStatus({ kind: "err", text: `create failed: ${err.message}` });
        }
    };

    const followRepo = async (owner, namespace) => {
        setStatus({ kind: "busy", text: `following ${namespace}…` });
        try {
            await api.followRepo(owner, namespace);
            await loadActive();
            setStatus({ kind: "ok", text: `following ${namespace} (read-only) — Pull to fetch notes` });
        } catch (err) {
            setStatus({ kind: "err", text: `follow failed: ${err.message}` });
        }
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

    const publish = async () => {
        const message = window.prompt("Commit message", "update wiki");
        if (message === null) return;
        setStatus({ kind: "busy", text: "publishing — committing and settling on-chain…" });
        try {
            const started = Date.now();
            const r = await api.publish(message);
            setStatus({
                kind: "ok",
                text: `published ${r.visibility} commit ${short(r.commitCid)} (${r.staged.vertices} notes, ${r.staged.edges} links) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
                tx: r.txHash,
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

    const navigate = async (path) => {
        if (notes.some((n) => n.path === path)) await openNote(path);
        else setStatus({ kind: "err", text: `no such note: ${path}` });
    };

    const activeTitle = notes.find((n) => n.path === active)?.title ?? active;
    const tree = useMemo(() => buildTree(notes), [notes]);
    const backlinks = useMemo(() => buildBacklinks(notes), [notes]);
    const activeBacklinks = (backlinks.get(active) ?? []).map((p) => ({
        path: p,
        title: notes.find((n) => n.path === p)?.title ?? p,
    }));
    const activeNudge = repo && nudges[repo.namespace];

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="sidebar-head">
                    <span className="brand">🌲 fangornmd</span>
                    <button className="btn small" onClick={newNote} title="New note">＋</button>
                </div>
                <RepoBar
                    repos={repos}
                    active={repo?.namespace}
                    nudges={nudges}
                    onSwitch={switchRepo}
                    onCreate={createRepo}
                    onFollow={followRepo}
                />
                <nav className="note-list">
                    {tree.root && (
                        <TreeNode
                            path={tree.root}
                            depth={0}
                            tree={tree}
                            notes={notes}
                            active={active}
                            onOpen={openNote}
                        />
                    )}
                    {tree.orphans.length > 0 && (
                        <>
                            <div className="tree-section">unlinked</div>
                            {tree.orphans.map((path) => (
                                <button
                                    key={path}
                                    className={`note-item orphan ${path === active ? "active" : ""}`}
                                    onClick={() => openNote(path)}
                                    title={path}
                                >
                                    {notes.find((n) => n.path === path)?.title ?? path}
                                </button>
                            ))}
                        </>
                    )}
                </nav>
                {repo && (
                    <footer className="repo-info">
                        <div><b>{repo.namespace}</b> · {repo.visibility}{repo.writable ? "" : " · read-only"}</div>
                        <div title={repo.owner}>owner {short(repo.owner)}</div>
                        <div title={repo.head ?? ""}>head {repo.head ? short(repo.head) : "(none)"}</div>
                    </footer>
                )}
            </aside>

            <main className="main">
                {activeNudge && (
                    <div className="banner">
                        <b>{repo.namespace}</b> updated on-chain (block {activeNudge.blockNumber},{" "}
                        {activeNudge.addedVertices?.length ?? 0} new version(s)).
                        <button className="btn" onClick={pull}>Pull</button>
                        <button className="btn ghost" onClick={() => setNudges((n) => { const c = { ...n }; delete c[repo.namespace]; return c; })}>Dismiss</button>
                    </div>
                )}
                <header className="topbar">
                    <span className="doc-title">{activeTitle ?? "—"}</span>
                    <span className={`save-state ${saveState}`}>{saveState}</span>
                    <span className="spacer" />
                    {repo?.writable && (
                        <button className="btn primary" onClick={publish} disabled={status?.kind === "busy"}>
                            Publish
                        </button>
                    )}
                </header>
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
                        <Editor content={content} onChange={onChange} onNavigate={navigate} />
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
                    <div className="empty">No notes yet — create one, or Pull if this is a followed repo.</div>
                )}
            </main>
        </div>
    );
}

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

export default function App() {
    const [repo, setRepo] = useState(null);
    const [notes, setNotes] = useState([]);
    const [active, setActive] = useState(null);
    const [content, setContent] = useState("");
    const [saveState, setSaveState] = useState("saved"); // saved | unsaved | saving
    const [remoteNudge, setRemoteNudge] = useState(null); // last on-chain NamespaceChange
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

    // Boot: repo pointer + note list, then open the index (or the first note).
    useEffect(() => {
        (async () => {
            try {
                setRepo(await api.repo());
                const list = await refreshNotes();
                const first = list.find((n) => n.path === "index.md") ?? list[0];
                if (first) await openNote(first.path);
            } catch (err) {
                setStatus({ kind: "err", text: `server unreachable: ${err.message}` });
            }
        })();
    }, [refreshNotes, openNote]);

    // Autosave: every keystroke marks the note dirty; 600ms of quiet flushes it
    // to docs/ on disk. Publishing is a separate, explicit act.
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
        // docs/ changed on disk (external editor, a pull): refresh the sidebar,
        // and reload the open note unless there are unsaved edits to protect.
        onLocalChange: async () => {
            const list = await refreshNotes();
            if (active && !dirtyRef.current && list.some((n) => n.path === active)) {
                const note = await api.note(active);
                setContent((cur) => (dirtyRef.current ? cur : note.content));
            }
        },
        // A new commit settled on-chain. Don't touch local files — just offer
        // to pull. (Your own publishes echo back here too; pulling is a no-op.)
        onRemoteChange: (change) => setRemoteNudge(change),
    });

    const pull = async () => {
        setStatus({ kind: "busy", text: "pulling from the network…" });
        try {
            const { written } = await api.pull();
            setRemoteNudge(null);
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
                text: `published commit ${short(r.commitCid)} (${r.staged.vertices} notes, ${r.staged.edges} links) in ${((Date.now() - started) / 1000).toFixed(1)}s`,
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

    return (
        <div className="app">
            <aside className="sidebar">
                <div className="sidebar-head">
                    <span className="brand">🌲 fangornmd</span>
                    <button className="btn small" onClick={newNote} title="New note">＋</button>
                </div>
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
                        <div><b>{repo.namespace}</b> {repo.writable ? "· writable" : "· read-only clone"}</div>
                        <div title={repo.owner}>owner {short(repo.owner)}</div>
                        <div title={repo.head ?? ""}>head {repo.head ? short(repo.head) : "(none)"}</div>
                    </footer>
                )}
            </aside>

            <main className="main">
                {remoteNudge && (
                    <div className="banner">
                        Remote updated on-chain (block {remoteNudge.blockNumber},{" "}
                        {remoteNudge.addedVertices?.length ?? 0} new version(s)).
                        <button className="btn" onClick={pull}>Pull</button>
                        <button className="btn ghost" onClick={() => setRemoteNudge(null)}>Dismiss</button>
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
                    <div className="empty">No notes yet — create one, or pull a cloned wiki.</div>
                )}
            </main>
        </div>
    );
}

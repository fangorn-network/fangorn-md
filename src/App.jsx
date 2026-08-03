import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets, useSignMessage } from "@privy-io/react-auth";
import { api, setTokenGetter, setAddress } from "./api.js";
import { deriveSecret, deriveSecretHex, sealContent, readSecrets, unsealAny } from "./crypto.js";
import { useEvents } from "./useEvents.js";
import { buildBacklinks, flattenTree, moveInTree, pathsBetween } from "./structure.js";
import Editor, { CollabEditor } from "./Editor.jsx";
import { exportHtml } from "./render.js";

const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "");

// ponytail: Intl.RelativeTimeFormat, no date library. Coarse on purpose — the
// Files column answers "did I touch this recently", not "when exactly".
const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [["year", 31536e6], ["month", 2592e6], ["day", 864e5], ["hour", 36e5], ["minute", 6e4]];
function ago(ms) {
    const delta = ms - Date.now();
    const [unit, size] = UNITS.find(([, s]) => Math.abs(delta) >= s) ?? ["second", 1000];
    return rtf.format(Math.round(delta / size), unit);
}

// How long after our own save to treat an incoming "local-change" as our echo.
// The server's watcher debounces 200ms before emitting, so this only has to
// outlast that plus SSE delivery.
const SELF_WRITE_MS = 1500;

// ── leaving the app ───────────────────────────────────────────────
// Export is one rendered document (see render.js) with two destinations: a file
// on disk, and a hidden frame we ask the browser to print. Printing the frame
// rather than the page means the export and the printout are the same document,
// so there's no second print stylesheet to keep in step with the first.
const download = (name, text, type) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
};

const printDocument = (html) => {
    const frame = document.createElement("iframe");
    frame.setAttribute("aria-hidden", "true");
    frame.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0";
    frame.srcdoc = html;
    frame.onload = () => {
        const win = frame.contentWindow;
        // Chrome blocks on print(); Safari doesn't, so also clean up on the
        // afterprint event and keep a timer as the last resort.
        win.onafterprint = () => frame.remove();
        win.focus();
        win.print();
        setTimeout(() => frame.isConnected && frame.remove(), 60_000);
    };
    document.body.appendChild(frame);
};

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

// Reordering the tree runs on pointer events, not HTML5 drag-and-drop: DnD
// never fires for touch, so the sidebar was desktop-only. Dragging starts from
// a grip (the only element with `touch-action: none`) so a finger anywhere else
// on the row still scrolls the list.
//
// The drop marker is a class on the row under the pointer. It's feedback that
// lasts exactly as long as the gesture and nothing re-renders mid-drag, so it
// stays a DOM class rather than React state threaded down the recursion.
const DROP_MARKS = ["drop-before", "drop-inside", "drop-after"];
const clearMarks = () =>
    document.querySelectorAll(".tree-row").forEach((el) => el.classList.remove(...DROP_MARKS));

// The row under (x, y) and which third of it, or null if it isn't a drop.
function dropAt(x, y, dragPath) {
    const el = document.elementFromPoint(x, y)?.closest?.(".tree-row");
    if (!el?.dataset.path || el.dataset.path === dragPath) return null;
    const r = el.getBoundingClientRect();
    const f = (y - r.top) / r.height;
    return { el, path: el.dataset.path, zone: f < 0.3 ? "before" : f > 0.7 ? "after" : "inside" };
}

// One node of the explicit page tree (stored server-side; see structure.js),
// rendered recursively. Writers can drag to reorder/nest and rename/delete.
function TreeRow({ node, depth, notes, active, writable, onOpen, onMove, onRename, onDelete }) {
    const drag = useRef(null); // { x, y, id, started } while a drag is live
    // A drag that ends where it began still emits a click, which would open the
    // note you were only trying to move. Cleared on the next pointerdown, so a
    // gesture that never produces a click can't eat a later one.
    const justDragged = useRef(false);
    const title = notes.find((n) => n.path === node.path)?.title ?? node.path.replace(/\.md$/, "");

    // Capture belongs on the ROW, never on the grip: the grip lives inside
    // `.tree-actions`, which is `display:none` until the row is hovered, and a
    // captured element that gets hidden fires pointercancel and kills the
    // gesture. The row is always there.
    const onPointerDown = (e) => {
        if (e.button > 0) return;
        if (e.target.closest(".tree-act:not(.tree-grip)")) return; // ✎ and ✕ are buttons, not handles
        // A mouse can grab the row anywhere, the way the old HTML5 drag did —
        // requiring a 17px hover-revealed grip to reorder was a regression.
        // Touch has to start on the grip, because the grip is the only element
        // that gives up `touch-action`, and the rest of the row has to stay
        // free or the sidebar can't be scrolled with a finger.
        if (e.pointerType !== "mouse" && !e.target.closest(".tree-grip")) return;
        justDragged.current = false;
        drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId, started: false };
        // Capture is deliberately NOT taken here. While a pointer is captured,
        // the compatibility mouse events retarget to the capturing element, so
        // the click lands on the row instead of the note button and opening a
        // note by clicking it silently stops working. Capture is taken below,
        // once the movement threshold says this is a drag and not a click.
    };
    const onPointerMove = (e) => {
        const d = drag.current;
        if (!d) return;
        // A few pixels of slop, so a tap on the grip isn't a one-pixel move.
        if (!d.started && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) return;
        if (!d.started) e.currentTarget.setPointerCapture(d.id); // now it's a drag: follow the pointer off the row
        d.started = true;
        e.currentTarget.classList.add("dragging"); // keeps the grip on screen once hover is gone
        clearMarks();
        const hit = dropAt(e.clientX, e.clientY, node.path);
        if (hit) hit.el.classList.add(`drop-${hit.zone}`);
    };
    const onPointerUp = (e) => {
        const d = drag.current;
        drag.current = null;
        e.currentTarget.classList.remove("dragging");
        clearMarks();
        if (!d?.started) return;
        justDragged.current = true;
        const hit = dropAt(e.clientX, e.clientY, node.path);
        if (hit) onMove(node.path, hit.path, hit.zone);
    };

    return (
        <>
            <div
                className="tree-row"
                data-path={node.path}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={(e) => { drag.current = null; e.currentTarget.classList.remove("dragging"); clearMarks(); }}
            >
                <button
                    className={`note-item ${node.path === active ? "active" : ""}`}
                    style={{ paddingLeft: `${10 + depth * 16}px` }}
                    onClick={() => { if (!justDragged.current) onOpen(node.path); }}
                    title={node.path}
                >
                    <span className="tree-glyph">{depth > 0 ? "└ " : ""}</span>
                    {title}
                </button>
                {writable && (
                    <span className="tree-actions">
                        <button className="tree-act" title="Rename" onClick={() => onRename(node.path)}>✎</button>
                        <button className="tree-act" title="Delete" onClick={() => onDelete(node.path)}>✕</button>
                        <button className="tree-act tree-grip" title="Drag to reorder">⠿</button>
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

// The Files view: every note in the namespace as one table, in tree order.
// It exists because the 240px sidebar can't be a file manager and a navigation
// rail at once — bulk selection, paths and dates need the width of the main
// pane, and the sidebar goes back to being a list you click.
function FilesView({ notes, tree, active, writable, onOpen, onRename, onDelete, onClose }) {
    const [selection, setSelection] = useState(() => new Set());
    const [query, setQuery] = useState("");
    const anchor = useRef(null); // last row clicked, for shift-click ranges

    const byPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes]);
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return flattenTree(tree)
            .map((r) => ({ ...r, note: byPath.get(r.path) }))
            .filter((r) => r.note)
            .filter((r) => !q || r.path.toLowerCase().includes(q) || r.note.title.toLowerCase().includes(q));
    }, [tree, byPath, query]);

    // Selecting a note that's since been deleted (or filtered out of the tree)
    // would send a dead path to the bulk delete, so the set is derived, never
    // trusted: everything below reads `picked`, not `selection`.
    const picked = useMemo(
        () => new Set([...selection].filter((p) => byPath.has(p))),
        [selection, byPath],
    );

    const click = (path, e) => {
        const next = new Set(picked);
        if (e.shiftKey && anchor.current) {
            for (const p of pathsBetween(rows, anchor.current, path)) next.add(p);
        } else {
            next.has(path) ? next.delete(path) : next.add(path);
            anchor.current = path;
        }
        setSelection(next);
    };

    const allShown = rows.length > 0 && rows.every((r) => picked.has(r.path));
    const chosen = [...picked];

    return (
        <div className="files">
            <div className="files-bar">
                <input
                    className="files-search"
                    type="search"
                    placeholder="Filter by title or filename…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    autoFocus
                />
                <button
                    className="btn ghost small"
                    onClick={() => setSelection(allShown ? new Set() : new Set(rows.map((r) => r.path)))}
                    disabled={rows.length === 0}
                >
                    {allShown ? "none" : "all"}
                </button>
                <span className="files-count">
                    {picked.size > 0 ? `${picked.size} selected` : `${rows.length} note${rows.length === 1 ? "" : "s"}`}
                </span>
                {writable && picked.size === 1 && (
                    <button className="btn small" onClick={() => onRename(chosen[0])}>Rename</button>
                )}
                {writable && (
                    <button className="btn small danger" disabled={picked.size === 0} onClick={() => onDelete(chosen)}>
                        Delete
                    </button>
                )}
                <button className="btn ghost small" onClick={onClose} title="Back to the editor">✕</button>
            </div>
            <div className="files-table" role="grid">
                {rows.map(({ path, depth, note }) => (
                    <div
                        key={path}
                        role="row"
                        className={`files-row${picked.has(path) ? " picked" : ""}${path === active ? " active" : ""}`}
                        onClick={(e) => click(path, e)}
                    >
                        <input
                            type="checkbox"
                            className="files-check"
                            checked={picked.has(path)}
                            onChange={() => {}}  // the row owns the click, so this is state, not a hit target
                            tabIndex={-1}
                            aria-label={`Select ${note.title}`}
                        />
                        <button
                            className="files-title"
                            style={{ paddingLeft: `${depth * 18}px` }}
                            // Opening is the one action that must not be swallowed
                            // by the row's select handler.
                            onClick={(e) => { e.stopPropagation(); onOpen(path); }}
                            title={`Open ${path}`}
                        >
                            <span className="tree-glyph">{depth > 0 ? "└ " : ""}</span>
                            {note.title}
                        </button>
                        <span className="files-path">{path}</span>
                        <span className="files-when">{note.updatedAt ? ago(note.updatedAt) : ""}</span>
                    </div>
                ))}
                {rows.length === 0 && (
                    <div className="files-empty">{query ? "nothing matches that filter" : "no notes yet"}</div>
                )}
            </div>
        </div>
    );
}

// The repo switcher: every tracked Fangorn namespace, plus inline forms to
// create one on your own root (public or private/encrypted) or follow someone
// else's read-only. A dot marks repos with an unseen on-chain update.
function RepoBar({ repos, active, nudges, onSwitch, onCreate, onFollow, onDiscover, onDelete }) {
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
                <span className="repo-bar-label">your data</span>
                <span className="repo-bar-actions">
                    <button className="btn ghost small" title="New — create a space for your notes" onClick={() => setForm(form === "new" ? null : "new")}>＋</button>
                    <button className="btn ghost small" title="Subscribe to someone else's space" onClick={() => setForm(form === "follow" ? null : "follow")}>⌕</button>
                    <button className="btn ghost small" title="Sync — find spaces this wallet published on-chain" onClick={onDiscover}>↻</button>
                </span>
            </div>
            <div className="repo-switch">
                {repos.map((r) => (
                    // A row, not a button: the delete has to sit inside it and a
                    // button can't nest. Deleting from here — rather than only
                    // from the active space's footer — is the difference between
                    // "delete this" and "switch to it, scroll past every note,
                    // then delete it", which read as no delete at all.
                    <div key={r.namespace} className={`repo-row ${r.namespace === active ? "active" : ""}`}>
                        <button
                            className="repo-item"
                            onClick={() => onSwitch(r.namespace)}
                            title={`${r.namespace} · owner ${r.owner}`}
                        >
                            <span className="repo-name">{r.namespace}</span>
                            {nudges[r.namespace] && r.namespace !== active && <span className="repo-dot" title="on-chain update" />}
                            {r.visibility === "private" && <span className="repo-badge" title="private (encrypted)">🔒</span>}
                            {!r.writable && <span className="repo-badge" title="read-only subscription">👁</span>}
                            {/* Whether anything was ever settled decides what a
                                delete actually costs, so it's on the row. */}
                            <span className="repo-badge" title={r.head ? `published on-chain (head ${short(r.head)}) — deleting is local only` : "never published — local only, deleting is permanent"}>
                                {r.head ? "⛓" : "◦"}
                            </span>
                        </button>
                        <button
                            className="tree-act"
                            title={r.writable ? `Delete ${r.namespace}` : `Stop following ${r.namespace}`}
                            onClick={() => onDelete(r)}
                        >
                            ✕
                        </button>
                    </div>
                ))}
            </div>
            {form === "new" && (
                <form className="repo-form" onSubmit={submitNew}>
                    <input className="repo-input" placeholder="name it (e.g. My Recipes)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                    <select className="repo-input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                        <option value="public">public</option>
                        <option value="private">private (encrypted)</option>
                    </select>
                    <button className="btn small primary" type="submit">Create</button>
                </form>
            )}
            {form === "follow" && (
                <form className="repo-form" onSubmit={submitFollow}>
                    <input className="repo-input" placeholder="paste a share link or owner/name" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus />
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

// Owner-only: long-lived tokens an agent holds instead of a browser session.
// Never able to publish — that needs the wallet, which is here and not wherever
// the agent is running.
//
// The default reaches every wiki you have, so connecting an agent is something
// you do once rather than once per namespace. Pinning is offered for the token
// you hand to somebody else's agent, where one wiki is the whole point.
function AgentPanel({ repo, onClose, signForKey }) {
    const [tokens, setTokens] = useState([]);
    const [name, setName] = useState("");
    const [pinned, setPinned] = useState(false);
    const [shareKey, setShareKey] = useState(false);
    const [minted, setMinted] = useState(null); // shown once — only the hash is stored
    const [err, setErr] = useState(null);
    // In production the server serves this page, so its own origin is the MCP
    // endpoint. In dev the SPA is on Vite (5173) and the server is on 8787, and
    // an agent connects to the server directly rather than through the proxy.
    const mcpUrl = `${window.location.origin}/mcp`;

    const load = useCallback(() => {
        api.tokens().then((r) => setTokens(r.tokens)).catch((e) => setErr(e.message));
    }, []);
    useEffect(load, [load]);

    const mint = async (e) => {
        e.preventDefault();
        try {
            const token = await api.mintToken(pinned ? repo.namespace : null, name || "agent");
            // Derived HERE and never sent anywhere. If the server ever saw this
            // value it could decrypt everything published from this namespace,
            // and sealing on publish would stop meaning anything — so it is
            // computed in the tab, shown once, and kept out of every request.
            const secret = shareKey ? await deriveSecretHex(signForKey, repo.namespace) : null;
            setMinted({ ...token, secret });
            setName("");
            load();
        } catch (e2) { setErr(e2.message); }
    };
    const revoke = async (hash) => {
        try { await api.revokeToken(hash); load(); } catch (e2) { setErr(e2.message); }
    };

    return (
        <div className="collab-panel">
            <label className="collab-panel-label">
                Agent tokens — an agent holding one can read and write your notes, and names which wiki it
                means per request. Set it up once; new wikis need no new token. It cannot publish: that
                needs your wallet.
            </label>
            <label className="collab-panel-label">
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
                {" "}Limit this token to <b>{repo.namespace}</b> — for an agent that isn't yours
            </label>
            {/* Only private wikis have anything sealed to hand a key for. The
                warning is not decoration: a token is a row in a file and dies
                when you revoke it, but a key that has left this tab has read
                every version ever published and cannot be called back. */}
            {repo.visibility === "private" && (
                <label className="collab-panel-label">
                    <input type="checkbox" checked={shareKey} onChange={(e) => setShareKey(e.target.checked)} />
                    {" "}Also hand over the decryption key for <b>{repo.namespace}</b> — lets the agent read
                    published notes, <b>cannot be revoked</b> (re-key by re-sealing every note)
                </label>
            )}
            <form className="collab-panel-actions" onSubmit={mint}>
                <input
                    className="repo-input"
                    placeholder="what is this token for? e.g. claude-code"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                />
                <button className="btn small primary" type="submit">Mint</button>
                <button className="btn ghost small" type="button" onClick={onClose}>Close</button>
            </form>
            {minted && (
                <div className="agent-token">
                    <div>Copy it now — it is not stored and cannot be shown again.</div>
                    <code onClick={() => navigator.clipboard?.writeText(minted.token)}>{minted.token}</code>
                    {minted.secret && (
                        <>
                            <div>
                                Decryption key for <b>{repo.namespace}</b> — it decrypts and nothing else: it
                                cannot spend, publish, or sign. Never give an agent your wallet key.
                            </div>
                            <code onClick={() => navigator.clipboard?.writeText(minted.secret)}>{minted.secret}</code>
                        </>
                    )}
                    <details>
                        <summary>Connect an agent</summary>
                        <div>Claude Code:</div>
                        <pre>{`claude mcp add --transport http fangornmd ${mcpUrl} --header "Authorization: Bearer ${minted.token}"`}</pre>
                        <div>Anything else that speaks MCP:</div>
                        <pre>{JSON.stringify({
                            mcpServers: {
                                fangornmd: {
                                    type: "http",
                                    url: mcpUrl,
                                    headers: { Authorization: `Bearer ${minted.token}` },
                                },
                            },
                        }, null, 2)}</pre>
                    </details>
                </div>
            )}
            {tokens.length > 0 && (
                <ul className="agent-token-list">
                    {tokens.map((t) => (
                        <li key={t.hash}>
                            {t.name} · {t.namespace ?? "all wikis"} · {new Date(t.createdAt).toLocaleDateString()}
                            <button className="btn ghost small" onClick={() => revoke(t.hash)}>Revoke</button>
                        </li>
                    ))}
                </ul>
            )}
            {err && <div className="status err">{err}</div>}
        </div>
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
    // The open note's text as it stands right now. For a solo note that's just
    // `content`, but a collab note is never saved through here — the room is —
    // so it reports itself up, and this is what the read pane and Export use.
    const [renderText, setRenderText] = useState("");
    const [view, setView] = useState("split"); // edit | split | read
    const [saveState, setSaveState] = useState("saved"); // saved | unsaved | saving
    const [nudges, setNudges] = useState({}); // namespace → last on-chain NamespaceChange
    const [status, setStatus] = useState(null); // { kind: ok|err|busy, text, tx? }
    const [showCollabs, setShowCollabs] = useState(false);
    const [showAgents, setShowAgents] = useState(false);
    // Off-canvas sidebar; only ever visible on narrow screens (see styles.css).
    const [navOpen, setNavOpen] = useState(false);
    // The Files view takes over the main pane (the editor stays mounted-in-state
    // behind it, so closing it lands back on the same note).
    const [showFiles, setShowFiles] = useState(false);
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
        setRenderText(note.content);
        setSaveState("saved");
        setNavOpen(false); // on mobile the drawer covers the note you just picked
    }, []);

    // A private namespace's published notes are ciphertext the relay can't write
    // to disk, so a pull hands them back sealed and they're opened HERE, with the
    // wallet key, and saved as the plaintext working copy (which is what a
    // private repo's working tree has always been). This is the only path by
    // which a private space published from somewhere else becomes readable on
    // this instance — without it the sidebar is empty and the notes look lost.
    //
    // Notes another wallet sealed simply don't open. They're reported rather
    // than stubbed: a placeholder saved into the tree would be published over
    // the real note on the next publish.
    const restoreSealed = useCallback(async (sealed, namespace) => {
        const paths = Object.keys(sealed ?? {});
        if (paths.length === 0) return 0;
        setStatus({ kind: "busy", text: `unlocking ${paths.length} note(s)…` });
        // Every write names its namespace. The signature prompt below is a long
        // pause the user can spend switching spaces, and a save that resolved
        // against the active pointer would land in whichever one they picked —
        // one namespace's notes written into another's tree.
        const secrets = await readSecrets(signForKey, namespace);
        const failed = [];
        for (const path of paths) {
            const text = unsealAny(namespace, path, sealed[path], secrets);
            if (text === null) { failed.push(path); continue; }
            await api.save(path, text, namespace);
        }
        await refreshNotes();
        if (failed.length) {
            setStatus({ kind: "err", text: `couldn't decrypt ${failed.length} note(s) — sealed by a different wallet: ${failed.join(", ")}` });
        }
        return paths.length - failed.length;
    }, [signForKey, refreshNotes]);

    // Load the active repo's pointer + notes and open its index (or first note).
    const loadActive = useCallback(async () => {
        const { active: activeNs, repos } = await api.repos();
        setRepos(repos);
        const current = repos.find((r) => r.namespace === activeNs) ?? null;
        setRepo(current);
        const list = await refreshNotes();
        // An empty private space MIGHT be the "my notes are gone" case (adopted
        // by discover, bodies still sealed on-chain) — but it is just as likely
        // that the user deleted every note, and restoring here silently undid
        // their delete on the next refresh. The two are indistinguishable from
        // here, so it's a prompt, not an action: the Pull button already does
        // the restore.
        // (the empty-space banner in <main> offers the Pull that restores them)
        const first = list.find((n) => n.path === "index.md") ?? list[0];
        if (first) await openNote(first.path);
        else { setActive(null); setContent(""); setRenderText(""); }
        return current;
    }, [refreshNotes, openNote]);

    // Boot.
    useEffect(() => {
        loadActive().catch((err) =>
            setStatus({ kind: "err", text: `server unreachable: ${err.message}` }));
    }, [loadActive]);

    // A phone has no console, so an exception thrown inside an event handler —
    // Slate's input path especially — is invisible: the editor just stops
    // behaving and there's nothing to read. Surface it in the status bar, which
    // is already the place this app says things went wrong.
    useEffect(() => {
        const onErr = (e) => setStatus({
            kind: "err",
            text: `js: ${e.message ?? e.reason?.message ?? String(e.reason)}`,
        });
        window.addEventListener("error", onErr);
        window.addEventListener("unhandledrejection", onErr);
        return () => {
            window.removeEventListener("error", onErr);
            window.removeEventListener("unhandledrejection", onErr);
        };
    }, []);

    // Autosave: every keystroke marks the note dirty; 600ms of quiet flushes it
    // to disk. Publishing is a separate, explicit act.
    const onChange = (next) => {
        setContent(next);
        setRenderText(next);
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
                if (!dirtyRef.current) setRenderText(note.content);
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

    // This relay tracks repos in its own state, so a wallet that published from
    // another instance (or before a volume was wiped) arrives to an empty list.
    // Ask the chain what it actually owns.
    const discover = async () => {
        setStatus({ kind: "busy", text: "looking for your spaces on-chain…" });
        try {
            const { found } = await api.discoverRepos();
            await loadActive();
            setStatus(found.length
                ? { kind: "ok", text: `found ${found.map((f) => f.namespace).join(", ")}` }
                : { kind: "ok", text: "nothing new — this wallet has published nothing else" });
        } catch (err) {
            setStatus({ kind: "err", text: `sync failed: ${err.message}` });
        }
    };

    const pull = async () => {
        setStatus({ kind: "busy", text: "pulling from the network…" });
        try {
            const ns = repo?.namespace;
            const { written, sealed } = await api.pull(ns);
            setNudges((n) => { const c = { ...n }; delete c[ns]; return c; });
            await refreshNotes();
            const opened = await restoreSealed(sealed, ns);
            const got = written.length + opened;
            setStatus({ kind: "ok", text: got ? `pulled ${got} note(s)${written.length ? `: ${written.join(", ")}` : ""}` : "already up to date" });
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
                const secret = await deriveSecret(signForKey, repo.namespace);
                setStatus({ kind: "busy", text: "encrypting notes…" });
                sealed = {};
                for (const n of notes) {
                    const { content } = await api.note(n.path);
                    sealed[n.path] = sealContent(repo.namespace, n.path, content, secret);
                }
            }

            setStatus({ kind: "busy", text: "preparing commit…" });
            // A publish is a snapshot, so notes missing locally leave the
            // namespace. The server refuses until that's acknowledged — it's
            // either the deletions you just made, or a working tree that never
            // had them (a discovered private namespace).
            const prepare = (confirmDrop) => api.publishPrepare(message, sealed, confirmDrop);
            const { namespace, commitCid, staged, tx } = await prepare(false).catch((err) => {
                if (!/would remove/.test(err.message)) throw err;
                if (!window.confirm(`${err.message}\n\nThey stay in history, but drop out of the current wiki. Continue?`)) throw new Error("cancelled");
                return prepare(true);
            });

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

    // One or many — the same call, so the tree is rewritten once and the sidebar
    // reopens on a note that still exists.
    const deleteNotes = async (paths) => {
        const what = paths.length === 1 ? paths[0] : `${paths.length} notes`;
        if (!window.confirm(`Delete ${what}? Removed from your working tree; published versions leave the wiki on your next publish.`)) return;
        try {
            const { deleted } = await api.deleteNotes(paths);
            const list = await refreshNotes();
            if (deleted.includes(active)) {
                const first = list.find((n) => n.path === "index.md") ?? list[0];
                if (first) await openNote(first.path);
                else { setActive(null); setContent(""); setRenderText(""); }
            }
            setStatus({ kind: "ok", text: `deleted ${deleted.length} note(s)` });
        } catch (err) {
            setStatus({ kind: "err", text: `delete failed: ${err.message}` });
        }
    };

    // Local delete: the relay forgets it and the working tree goes. Published
    // commits are settled on-chain and stay readable by anyone who followed.
    // `target` is any tracked space, not just the active one — the note count is
    // only known for the one that's open, so the warning names it when it can.
    const deleteRepo = async (target = repo) => {
        if (!target) return;
        const here = target.namespace === repo?.namespace ? ` and its ${notes.length} local note(s)` : "";
        const warning = target.owner === address
            ? target.head
                ? `Delete "${target.namespace}"${here}?\n\nAlready published versions stay on-chain and readable — this app just stops tracking it. To empty the wiki first, delete the notes and publish.`
                : `Delete "${target.namespace}"${here}? Nothing was ever published, so this is permanent.`
            : `Stop following "${target.namespace}"? The owner's copy is untouched.`;
        if (!window.confirm(warning)) return;
        try {
            await api.deleteRepo(target.namespace);
            await loadActive();
            setStatus({ kind: "ok", text: `${target.namespace} removed from this app` });
        } catch (err) {
            setStatus({ kind: "err", text: `delete failed: ${err.message}` });
        }
    };

    const navigate = async (path) => {
        if (notes.some((n) => n.path === path)) await openNote(path);
        else setStatus({ kind: "err", text: `no such note: ${path}` });
    };

    const activeTitle = notes.find((n) => n.path === active)?.title ?? active;
    const exportDoc = () => exportHtml(renderText, activeTitle ?? "note");
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
                    <span className="sidebar-head-actions">
                        {repo?.writable && <button className="btn small" onClick={newNote} title="New note">＋</button>}
                    </span>
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
                    onDiscover={discover}
                    onDelete={deleteRepo}
                />
                {/* ponytail: dropping on empty space is gone — drop "after" the
                    last row for the same result. */}
                <nav className="note-list">
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
                            onDelete={(path) => deleteNotes([path])}
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
                {/* Nothing local. Either the notes were deleted, or they're
                    published and this relay has never materialized them (a
                    discovered space, or an agent that publishes the wiki from
                    its own process). Restoring on its own would undo a delete,
                    so the Pull is offered, not performed. */}
                {repo?.writable && notes.length === 0 && (
                    <div className="banner">
                        <b>{repo.namespace}</b> is empty here. Anything published to it can be pulled back.
                        <button className="btn" onClick={pull}>Pull</button>
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
                    <span className="doc-title">{showFiles ? "Files" : activeTitle ?? "—"}</span>
                    {active && !showFiles && (
                        <div className="view-switch" role="group" aria-label="View">
                            {["edit", "split", "read"].map((m) => (
                                <button
                                    key={m}
                                    className={`view-btn ${view === m ? "active" : ""}`}
                                    aria-pressed={view === m}
                                    onClick={() => setView(m)}
                                    title={
                                        m === "edit" ? "Markdown source only"
                                            : m === "split" ? "Source beside the rendered document"
                                                : "Rendered document — links are clickable"
                                    }
                                >
                                    {m}
                                </button>
                            ))}
                        </div>
                    )}
                    {/* Public notes live in the shared room — the server persists
                        them, so there's no local save state to report. */}
                    {repo?.visibility !== "public" && (
                        <span className={`save-state ${saveState}`}>{saveState}</span>
                    )}
                    <span className="spacer" />
                    <button
                        className={`btn${showFiles ? " primary" : ""}`}
                        onClick={() => setShowFiles((v) => !v)}
                        aria-pressed={showFiles}
                        title="All files — bulk select, rename, delete"
                    >
                        🗂 Files
                    </button>
                    {active && !showFiles && (
                        <>
                            <button
                                className="btn"
                                onClick={() => download(`${(activeTitle ?? active).replace(/[/\\?%*:|"<>]/g, "-")}.html`, exportDoc(), "text/html")}
                                title="Download this note as a standalone HTML document"
                            >
                                ⤓ HTML
                            </button>
                            <button className="btn" onClick={() => printDocument(exportDoc())} title="Print (or save as PDF)">
                                🖨
                            </button>
                        </>
                    )}
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
                        <button
                            className="btn"
                            onClick={() => setShowAgents((v) => !v)}
                            title="Mint a token so an agent can read and write this namespace"
                        >
                            🤖
                        </button>
                    )}
                    {repo?.isOwner && (
                        <button className="btn primary" onClick={publish} disabled={status?.kind === "busy"}>
                            Publish
                        </button>
                    )}
                </header>
                {showAgents && repo?.isOwner && (
                    <AgentPanel
                        key={repo.namespace}
                        repo={repo}
                        onClose={() => setShowAgents(false)}
                        signForKey={signForKey}
                    />
                )}
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
                {showFiles ? (
                    <FilesView
                        // Paths are per-namespace: `index.md` exists in most of
                        // them, so a pick carried across a switch would delete
                        // the wrong file. Remounting drops the selection.
                        key={repo?.namespace}
                        notes={notes}
                        tree={tree}
                        active={active}
                        writable={!!repo?.writable}
                        onOpen={(path) => { setShowFiles(false); openNote(path); }}
                        onRename={renameNoteAt}
                        onDelete={deleteNotes}
                        onClose={() => setShowFiles(false)}
                    />
                ) : active ? (
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
                                view={view}
                                onViewChange={setView}
                                onText={setRenderText}
                                previewText={renderText}
                            />
                        ) : (
                            <Editor
                                content={content}
                                onChange={onChange}
                                onNavigate={navigate}
                                noteKey={active}
                                readOnly={!repo?.writable}
                                view={view}
                                onViewChange={setView}
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

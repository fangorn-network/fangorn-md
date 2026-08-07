import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePrivy, useWallets, useSignMessage } from "@privy-io/react-auth";
import { api, setTokenGetter, setAddress } from "./api.js";
import { deriveSecret, deriveSecretHex, sealContent, readSecrets, unsealAny } from "./crypto.js";
import { useEvents } from "./useEvents.js";
import { ancestorsOf, buildBacklinks, flattenTree, foldTree, moveInTree, pathsBetween } from "./structure.js";
import Editor, { CollabEditor } from "./Editor.jsx";
import { exportHtml } from "./render.js";

const short = (s) => (s ? `${s.slice(0, 8)}…${s.slice(-6)}` : "");

// ponytail: Intl.RelativeTimeFormat, no date library. Coarse on purpose — the
// home view's date answers "did I touch this recently", not "when exactly".
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

// Reordering runs on pointer events, not HTML5 drag-and-drop: DnD never fires
// for touch. Dragging starts from a grip (the only element with
// `touch-action: none`) so a finger anywhere else on the row still scrolls.
//
// The drop marker is a class on the row under the pointer. It's feedback that
// lasts exactly as long as the gesture and nothing re-renders mid-drag, so it
// stays a DOM class rather than React state threaded through the list.
const DROP_MARKS = ["drop-before", "drop-inside", "drop-after"];
const clearMarks = () =>
    document.querySelectorAll(".home-row").forEach((el) => el.classList.remove(...DROP_MARKS));

// The row under (x, y) and which third of it, or null if it isn't a drop.
function dropAt(x, y, dragPath) {
    const el = document.elementFromPoint(x, y)?.closest?.(".home-row");
    if (!el?.dataset.path || el.dataset.path === dragPath) return null;
    const r = el.getBoundingClientRect();
    const f = (y - r.top) / r.height;
    return { el, path: el.dataset.path, zone: f < 0.3 ? "before" : f > 0.7 ? "after" : "inside" };
}

// One row of the space home. The path back to the open note is drawn as lit
// grain rails, so a note nested four levels down still shows you which branch
// it hangs off without expanding anything.
function HomeRow({ row, note, active, lineage, writable, picked, onOpen, onToggle, onPick, onMove, onRename, onDelete, onNest }) {
    const drag = useRef(null); // { x, y, id, started } while a drag is live
    // A drag that ends where it began still emits a click, which would open the
    // note you were only trying to move. Cleared on the next pointerdown, so a
    // gesture that never produces a click can't eat a later one.
    const justDragged = useRef(false);
    const node = row;

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

    const cls = ["home-row"];
    if (row.path === active) cls.push("active");
    if (lineage) cls.push("lineage");
    if (picked) cls.push("picked");

    return (
        <div
            className={cls.join(" ")}
            data-path={node.path}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={(e) => { drag.current = null; e.currentTarget.classList.remove("dragging"); clearMarks(); }}
        >
            {writable && (
                <input
                    type="checkbox"
                    className="home-pick tree-act"
                    checked={picked}
                    onChange={(e) => onPick(row.path, e.nativeEvent)}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={`Select ${note.title}`}
                />
            )}
            {/* One rail per level of nesting — the grain the whole view reads by.
                The innermost is tagged: CSS can't find it on its own, because
                `:last-of-type` picks the last <span> in the row, which is never
                a rail. */}
            {Array.from({ length: row.depth }, (_, i) => (
                <span key={i} className={i === row.depth - 1 ? "grain tip" : "grain"} />
            ))}
            {row.count > 0 ? (
                <button
                    className="twist tree-act"
                    aria-expanded={row.open}
                    aria-label={`${row.open ? "Collapse" : "Expand"} ${note.title}`}
                    onClick={() => onToggle(row.path)}
                >
                    {row.open ? "▾" : "▸"}
                </button>
            ) : (
                <span className="twist" aria-hidden="true" />
            )}
            <button
                className="home-title"
                onClick={() => { if (!justDragged.current) onOpen(node.path); }}
                title={`Open ${node.path}`}
            >
                {note.title}
            </button>
            <span className="home-count">{row.count > 0 && !row.open ? row.count : ""}</span>
            <span className="home-when">{note.updatedAt ? ago(note.updatedAt) : ""}</span>
            {writable && (
                <span className="tree-actions">
                    {/* Nesting used to be drag-only, which is undiscoverable and
                        impossible to do accurately on a phone. The server has
                        always taken a `parent` on create — this just asks for it. */}
                    <button className="tree-act" title={`New document under ${note.title}`} onClick={() => onNest(node.path)}>＋</button>
                    <button className="tree-act" title="Rename" onClick={() => onRename(node.path)}>✎</button>
                    <button className="tree-act" title="Delete" onClick={() => onDelete(node.path)}>✕</button>
                    <button className="tree-act tree-grip" title="Drag to reorder">⠿</button>
                </span>
            )}
        </div>
    );
}

// One collection's documents, browsable, in the width of the main pane. This is
// the answer to a 240px rail trying to be a file manager, a collection switcher
// and a nav list at once — folding keeps a 200-document collection to a screen
// of rows, and the same view works on a phone because it isn't in a drawer.
function CollectionHome({ notes, tree, active, writable, repo, onPull, onOpen, onMove, onRename, onDelete, onNew }) {
    // Land on the branch the open note lives on. Everything else starts folded,
    // which is the whole point — the old view rendered every note, always.
    const [open, setOpen] = useState(() => new Set(ancestorsOf(tree, active) ?? []));
    const [query, setQuery] = useState("");
    const [selection, setSelection] = useState(() => new Set());
    const anchor = useRef(null); // last row picked, for shift-click ranges

    const byPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes]);
    const lineage = useMemo(() => new Set(ancestorsOf(tree, active) ?? []), [tree, active]);

    // A filter searches the whole namespace, so it ignores folding and goes flat —
    // matches you can't see aren't matches.
    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        const base = q
            ? flattenTree(tree).map((r) => ({ ...r, depth: 0, count: 0, open: false }))
            : foldTree(tree, open);
        return base
            .map((r) => ({ ...r, note: byPath.get(r.path) }))
            .filter((r) => r.note)
            .filter((r) => !q || r.path.toLowerCase().includes(q) || r.note.title.toLowerCase().includes(q));
    }, [tree, open, byPath, query]);

    // Selecting a note that's since been deleted (or filtered out of the tree)
    // would send a dead path to the bulk delete, so the set is derived, never
    // trusted: everything below reads `picked`, not `selection`.
    const picked = useMemo(
        () => new Set([...selection].filter((p) => byPath.has(p))),
        [selection, byPath],
    );

    const toggle = (path) =>
        setOpen((o) => { const n = new Set(o); n.has(path) ? n.delete(path) : n.add(path); return n; });

    // Dropping a note INSIDE a collapsed parent folds it out of sight the
    // instant it lands, which reads as "nesting is broken / my note is gone".
    // The parent opens so you see where it went.
    const move = (dragPath, targetPath, pos) => {
        if (pos === "inside") setOpen((o) => new Set(o).add(targetPath));
        onMove(dragPath, targetPath, pos);
    };

    // The row opens the note; only the checkbox selects. The old view had this
    // backwards — clicking a row selected it and only the title opened it,
    // which is not what a list of documents should do.
    const pick = (path, e) => {
        const next = new Set(picked);
        if (e.shiftKey && anchor.current) {
            for (const p of pathsBetween(rows, anchor.current, path)) next.add(p);
        } else {
            next.has(path) ? next.delete(path) : next.add(path);
            anchor.current = path;
        }
        setSelection(next);
    };

    const chosen = [...picked];
    const allShown = rows.length > 0 && rows.every((r) => picked.has(r.path));

    return (
        <div className="home">
            {/* A published collection whose working tree is thinner than its commit is
                indistinguishable, from here, from one you emptied on purpose —
                so this offers the Pull rather than performing it. The empty-collection
                banner only fires at zero notes and never covered this case. */}
            {writable && repo?.head && (
                <div className="home-note">
                    <span>
                        Published as <code>{short(repo.head)}</code>. Notes published from elsewhere
                        won't be here until you pull them.
                    </span>
                    <button className="btn ghost small" onClick={onPull}>Pull</button>
                </div>
            )}

            <div className="home-bar">
                <input
                    className="home-search"
                    type="search"
                    placeholder="Filter this collection by title or path…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <span className="home-tally">
                    {notes.length} document{notes.length === 1 ? "" : "s"} in {repo?.namespace ?? "—"}
                </span>
                {writable && <button className="btn small" onClick={() => onNew()}>New document</button>}
            </div>

            {/* Bulk actions only exist once something is selected, so browsing
                isn't shadowed by a Delete button that does nothing. */}
            {picked.size > 0 && (
                <div className="home-bulk">
                    <span className="home-tally">{picked.size} selected</span>
                    <button
                        className="btn ghost small"
                        onClick={() => setSelection(allShown ? new Set() : new Set(rows.map((r) => r.path)))}
                    >
                        {allShown ? "Clear" : "Select all"}
                    </button>
                    {picked.size === 1 && <button className="btn small" onClick={() => onRename(chosen[0])}>Rename</button>}
                    <button className="btn small danger" onClick={() => onDelete(chosen)}>Delete</button>
                </div>
            )}

            <div className="home-list">
                {rows.map((row) => (
                    <HomeRow
                        key={row.path}
                        row={row}
                        note={row.note}
                        active={active}
                        lineage={lineage.has(row.path)}
                        writable={writable}
                        picked={picked.has(row.path)}
                        onOpen={onOpen}
                        onToggle={toggle}
                        onPick={pick}
                        onMove={move}
                        onRename={onRename}
                        onDelete={(p) => onDelete([p])}
                        onNest={(p) => { setOpen((o) => new Set(o).add(p)); onNew(p); }}
                    />
                ))}
                {rows.length === 0 && (
                    <div className="home-empty">
                        {query
                            ? <>Nothing here matches “{query}”.</>
                            : writable
                                ? <>This collection is empty. <button className="btn small" onClick={() => onNew()}>Write the first document</button></>
                                : <>Nothing published here yet.</>}
                    </div>
                )}
            </div>
        </div>
    );
}

// The root of the browser: every collection this wallet tracks, as rows in the
// same view its notes use one level down. Pills were a second navigation model
// bolted beside the first — this is just the top of the same tree, so the
// breadcrumb, the row shape and the click target all keep meaning what they
// meant. Counts are absent on purpose: only the open collection's documents are
// loaded, and a made-up number is worse than none.
// `form` ("new" | "follow" | null) lives in App, not here: the thumb bar at the
// bottom of the screen opens the same two forms, and on a phone that bar is the
// only copy of these actions you can reach.
function CollectionList({ repos, active, nudges, address, form, setForm, onOpen, onDelete, onCreate, onFollow }) {
    const [query, setQuery] = useState("");
    const q = query.trim().toLowerCase();
    const rows = repos.filter((r) => !q || r.namespace.toLowerCase().includes(q));

    return (
        <div className="home">
            <div className="home-bar">
                <input
                    className="home-search"
                    type="search"
                    placeholder="Filter collections…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <span className="home-tally">
                    {repos.length} collection{repos.length === 1 ? "" : "s"}
                </span>
                <button
                    className="btn ghost small"
                    aria-expanded={form === "follow"}
                    onClick={() => setForm(form === "follow" ? null : "follow")}
                >
                    Subscribe
                </button>
                <button
                    className="btn small"
                    aria-expanded={form === "new"}
                    onClick={() => setForm(form === "new" ? null : "new")}
                >
                    New collection
                </button>
            </div>
            {/* Inline rather than in a popover: choosing public or private can't
                be undone, and that warning should sit in the page you're
                looking at, at full width, not in a 260px panel that closes if
                you click past it. */}
            {form && (
                <div className="home-form">
                    {form === "new"
                        ? <NewCollectionForm onCreate={onCreate} done={() => setForm(null)} />
                        : <SubscribeForm onFollow={onFollow} done={() => setForm(null)} />}
                </div>
            )}
            <div className="home-list">
                {rows.map((r) => (
                    <div key={r.namespace} className={`home-row coll-row${r.namespace === active ? " active" : ""}`}>
                        {/* Name and facts share a wrapper so a phone can stack
                            them. Flat, they competed for one line and the name
                            — the only part you navigate by — was the part that
                            truncated. */}
                        <span className="coll-main">
                            <button className="home-title coll-title" onClick={() => onOpen(r.namespace)} title={`Open ${r.namespace}`}>
                                {r.namespace}
                            </button>
                            {nudges?.[r.namespace] && r.namespace !== active && (
                                <span className="repo-dot" title="updated on-chain since you last looked" />
                            )}
                            {/* Three facts that change what this collection IS, so
                                they're words rather than icons you have to learn. */}
                            <span className="coll-facts">
                                <span className={`coll-tag ${r.visibility}`}>
                                    {r.visibility === "private" ? "private" : "public"}
                                </span>
                                <span className="coll-tag">
                                    {r.owner === address ? "owner" : r.writable ? "collaborator" : "read-only"}
                                </span>
                                {/* Whether it exists off this disk, in the same
                                    ●/◦ the switcher and the footer already use.
                                    The truncated CID that used to sit here was
                                    the widest thing in the row and the least
                                    readable — it's in the tooltip, whole. */}
                                <span
                                    className={`coll-head${r.head ? " on" : ""}`}
                                    title={r.head ? `published on-chain — head ${r.head}` : "nothing settled on-chain yet"}
                                >
                                    <span aria-hidden="true">{r.head ? "●" : "◦"}</span>
                                    {r.head ? "published" : "unpublished"}
                                </span>
                            </span>
                        </span>
                        <span className="tree-actions">
                            <button
                                className="tree-act"
                                title={r.owner === address ? `Delete ${r.namespace}` : `Stop following ${r.namespace}`}
                                onClick={() => onDelete(r)}
                            >
                                ✕
                            </button>
                        </span>
                    </div>
                ))}
                {/* An empty account is the one screen every new person sees,
                    and it used to be a full stop. It's the only place the two
                    ways in can be explained at length, so it does that. */}
                {rows.length === 0 && (
                    <div className="home-empty">
                        {query ? <>No collection matches “{query}”.</> : (
                            <div className="home-start">
                                <p>A collection is a set of documents you publish together, under one name.</p>
                                <p className="home-start-sub">
                                    Start one of your own, or subscribe to someone else's with a share link.
                                </p>
                                <button className="btn primary" onClick={() => setForm("new")}>New collection</button>
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

// The open collection's structure, in the sidebar, while you write. The main
// browser is for managing (bulk select, rename, reorder); this is for moving.
// It only works now because folding exists — the version that rendered every
// descendant unconditionally is what made a large collection unusable here.
function SideTree({ tree, notes, active, onOpen }) {
    const [open, setOpen] = useState(() => new Set(ancestorsOf(tree, active) ?? []));

    // Opening a note from anywhere else — ⌘K, a breadcrumb, a backlink — has to
    // reveal it here too, or the sidebar quietly disagrees with the editor.
    // Returning the same Set when nothing is new keeps this from re-rendering
    // itself forever.
    useEffect(() => {
        const trail = ancestorsOf(tree, active) ?? [];
        if (trail.length === 0) return;
        setOpen((o) => (trail.every((p) => o.has(p)) ? o : new Set([...o, ...trail])));
    }, [tree, active]);

    const lineage = useMemo(() => new Set(ancestorsOf(tree, active) ?? []), [tree, active]);
    const rows = useMemo(() => foldTree(tree, open), [tree, open]);
    const byPath = useMemo(() => new Map(notes.map((n) => [n.path, n])), [notes]);

    const toggle = (path) =>
        setOpen((o) => { const n = new Set(o); n.has(path) ? n.delete(path) : n.add(path); return n; });

    if (rows.length === 0) return <div className="side-empty">No documents yet.</div>;

    return (
        <div className="side-tree">
            {rows.map((row) => {
                const note = byPath.get(row.path);
                if (!note) return null;
                return (
                    <div
                        key={row.path}
                        className={`side-row${row.path === active ? " active" : ""}${lineage.has(row.path) ? " lineage" : ""}`}
                    >
                        {Array.from({ length: row.depth }, (_, i) => (
                            <span key={i} className={i === row.depth - 1 ? "grain tip" : "grain"} />
                        ))}
                        {row.count > 0 ? (
                            <button
                                className="twist tree-act"
                                aria-expanded={row.open}
                                aria-label={`${row.open ? "Collapse" : "Expand"} ${note.title}`}
                                onClick={() => toggle(row.path)}
                            >
                                {row.open ? "▾" : "▸"}
                            </button>
                        ) : (
                            <span className="twist" aria-hidden="true" />
                        )}
                        <button className="side-title" onClick={() => onOpen(row.path)} title={row.path}>
                            {note.title}
                        </button>
                    </div>
                );
            })}
        </div>
    );
}

// One popover, two jobs: the collection switcher and the topbar's overflow menu.
// A scrim rather than a document listener — it closes on any outside tap,
// which is the behaviour a phone needs and an outside-click handler fumbles.
function Popover({ label, title, className, panelClass, children }) {
    const [open, setOpen] = useState(false);
    return (
        <div className={`pop ${className ?? ""}`}>
            <button className="btn ghost pop-trigger" title={title} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
                {label}
            </button>
            {open && (
                <>
                    <div className="pop-scrim" onClick={() => setOpen(false)} />
                    <div className={`pop-panel ${panelClass ?? ""}`}>{children(() => setOpen(false))}</div>
                </>
            )}
        </div>
    );
}

// Where a note is: its title's position in the namespace, and the substring that
// matched. Negative means no match at all.
const rank = (q, title, path) => {
    if (!q) return 0;
    const t = title.toLowerCase().indexOf(q);
    if (t >= 0) return t;
    const p = path.toLowerCase().indexOf(q);
    return p >= 0 ? 100 + p : -1;
};

// ⌘K. Every document in the open collection plus every collection you track —
// the fastest path to anything, and the only navigation on a phone that
// doesn't cost a drawer, a scroll and three taps.
function JumpPalette({ notes, repos, activeNs, onOpen, onSwitch, onClose }) {
    const [q, setQ] = useState("");
    const [i, setI] = useState(0);

    // Full-text results from the server, every collection included. Kept apart
    // from the local list so the palette stays instant: names rank with zero
    // latency, bodies arrive a moment later underneath.
    const [found, setFound] = useState([]);
    useEffect(() => {
        const s = q.trim();
        if (s.length < 2) { setFound([]); return; }
        let live = true;
        const t = setTimeout(
            () => api.search(s).then((r) => live && setFound(r.hits)).catch(() => live && setFound([])),
            180, // a keystroke is ~120ms apart; this searches the pause, not the typing
        );
        return () => { live = false; clearTimeout(t); };
    }, [q]);

    const hits = useMemo(() => {
        const s = q.trim().toLowerCase();
        const local = [
            ...notes.map((n) => ({ kind: "note", id: n.path, label: n.title, hint: n.path, score: rank(s, n.title, n.path) })),
            ...repos
                .filter((r) => r.namespace !== activeNs)
                .map((r) => ({ kind: "coll", id: r.namespace, label: r.namespace, hint: "switch collection", score: rank(s, r.namespace, r.namespace) })),
        ].filter((h) => h.score >= 0).sort((a, b) => a.score - b.score);

        // A note already listed by name doesn't earn a second row for also
        // containing the word.
        const seen = new Set(local.map((h) => `${activeNs}:${h.id}`));
        const text = found
            .filter((h) => h.snippet && !seen.has(`${h.namespace}:${h.path}`))
            .map((h) => ({
                kind: "text", id: `${h.namespace}:${h.path}`, ns: h.namespace, path: h.path,
                label: h.title, hint: h.snippet,
            }));
        return [...local.slice(0, 8), ...text.slice(0, 12)];
    }, [q, notes, repos, activeNs, found]);

    const choose = async (hit) => {
        if (!hit) return;
        onClose();
        if (hit.kind === "coll") return onSwitch(hit.id);
        if (hit.kind === "note") return onOpen(hit.id);
        // A text hit can live in a collection that isn't open. Switch first —
        // openNote reads through the server's active pointer.
        if (hit.ns !== activeNs) await onSwitch(hit.ns);
        onOpen(hit.path);
    };

    const onKeyDown = (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); setI((v) => Math.min(v + 1, hits.length - 1)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); setI((v) => Math.max(v - 1, 0)); }
        else if (e.key === "Enter") { e.preventDefault(); choose(hits[i]); }
        else if (e.key === "Escape") onClose();
    };

    return (
        <div className="jump-scrim" onClick={onClose}>
            <div className="jump" onClick={(e) => e.stopPropagation()}>
                <input
                    className="jump-input"
                    placeholder="Search all collections"
                    value={q}
                    onChange={(e) => { setQ(e.target.value); setI(0); }}
                    onKeyDown={onKeyDown}
                    autoFocus
                />
                <ul className="jump-hits">
                    {hits.map((h, n) => (
                        <li key={`${h.kind}:${h.id}`}>
                            <button
                                className={`jump-hit${n === i ? " on" : ""}`}
                                onMouseEnter={() => setI(n)}
                                onClick={() => choose(h)}
                            >
                                <span className={`jump-kind ${h.kind}`}>{h.kind === "coll" ? "set" : "doc"}</span>
                                <span className="jump-label">{h.label}</span>
                                {/* A snippet reads left-to-right; the right-aligned
                                    hint is for short facts like a path. */}
                                <span className={`jump-hint${h.kind === "text" ? " snip" : ""}`}>
                                    {h.kind === "text" && h.ns !== activeNs && <em>{h.ns} · </em>}
                                    {h.hint}
                                </span>
                            </button>
                        </li>
                    ))}
                    {hits.length === 0 && <li className="home-empty">Nothing matches “{q}”.</li>}
                </ul>
            </div>
        </div>
    );
}

// The two ways a collection reaches your sidebar. They live out here because
// there are two places you can reach for them — the collections view, where you
// go to start one, and the switcher, where you land when you're already writing
// — and the visibility warning has to read identically in both. Two call sites
// for the same irreversible choice is exactly the thing you don't want to
// maintain in two copies.
function NewCollectionForm({ onCreate, done }) {
    const [name, setName] = useState("");
    const [visibility, setVisibility] = useState("public");
    return (
        <form
            className="repo-form"
            onSubmit={(e) => {
                e.preventDefault();
                if (!name.trim()) return;
                onCreate(name.trim(), visibility);
                setName(""); setVisibility("public"); done();
            }}
        >
            <input className="repo-input" placeholder="Name it (e.g. My Recipes)" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <label className="repo-field">
                <span className="repo-bar-label">who can read it</span>
                <select className="repo-input" value={visibility} onChange={(e) => setVisibility(e.target.value)}>
                    <option value="public">Public — anyone can read</option>
                    <option value="private">Private — encrypted</option>
                </select>
            </label>
            {/* Visibility is fixed at creation and decides whether the network
                ever sees plaintext, so it says so up front rather than in a doc
                nobody opens. */}
            <p className="repo-hint">
                {visibility === "private"
                    ? "Notes are sealed with a key derived from your wallet. The server pins ciphertext it cannot read. This can't be changed later."
                    : "Notes publish as plaintext anyone can read and verify. This can't be changed later."}
            </p>
            <button className="btn small primary" type="submit">Create collection</button>
        </form>
    );
}

function SubscribeForm({ onFollow, done }) {
    const [ref, setRef] = useState("");
    return (
        <form
            className="repo-form"
            onSubmit={(e) => {
                e.preventDefault();
                if (!ref.trim()) return;
                onFollow(ref.trim());
                setRef(""); done();
            }}
        >
            <input className="repo-input" placeholder="Paste a share link, or owner/name" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus />
            <button className="btn small primary" type="submit">Subscribe</button>
        </form>
    );
}

// The collection switcher: create, subscribe, sync. Browsing what you have is
// the root of the main view now, so this menu is only for the actions. It shared the
// sidebar with the note tree before, and two unbounded lists in 240px is why
// neither one was navigable.
function CollectionMenu({ repos, active, nudges, onSwitch, onCreate, onFollow, onDiscover, onDelete, close }) {
    const [form, setForm] = useState(null); // "new" | "follow" | null

    return (
        <div className="repo-bar">
            <div className="repo-bar-head">
                <span className="repo-bar-label">your collections</span>
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
                            onClick={() => { onSwitch(r.namespace); close(); }}
                            title={`${r.namespace} · owner ${r.owner}`}
                        >
                            <span className="repo-name">{r.namespace}</span>
                            {nudges[r.namespace] && r.namespace !== active && <span className="repo-dot" title="on-chain update" />}
                            {r.visibility === "private" && <span className="repo-badge" title="private (encrypted)">🔒</span>}
                            {!r.writable && <span className="repo-badge" title="read-only subscription">👁</span>}
                            {/* Whether anything was ever settled decides what a
                                delete actually costs, so it's on the row. */}
                            <span className="repo-badge" title={r.head ? `published on-chain (head ${short(r.head)}) — deleting is local only` : "never published — local only, deleting is permanent"}>
                                {r.head ? "●" : "◦"}
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
            {/* These were three unlabelled icons in a corner. Creating a collection —
                and picking whether it's public or encrypted — is the most
                consequential choice in the app; it gets words. */}
            <div className="repo-acts">
                <button className="menu-item" onClick={() => setForm(form === "new" ? null : "new")}>
                    ＋ New collection…
                </button>
                <button className="menu-item" onClick={() => setForm(form === "follow" ? null : "follow")}>
                    ⌕ Subscribe to a collection…
                </button>
                <button className="menu-item" onClick={() => { onDiscover(); close(); }}>
                    ↻ Find my collections on-chain
                </button>
            </div>

            {form === "new" && <NewCollectionForm onCreate={onCreate} done={() => { setForm(null); close(); }} />}
            {form === "follow" && <SubscribeForm onFollow={onFollow} done={() => { setForm(null); close(); }} />}
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
// The default reaches every collection you have, so connecting an agent is something
// you do once rather than once per namespace. Pinning is offered for the token
// you hand to somebody else's agent, where one collection is the whole point.
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
                Agent tokens — an agent holding one can read and write your notes, and names which collection it
                means per request. Set it up once; new collections need no new token. It cannot publish: that
                needs your wallet.
            </label>
            <label className="collab-panel-label">
                <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />
                {" "}Limit this token to <b>{repo.namespace}</b> — for an agent that isn't yours
            </label>
            {/* Only private collections have anything sealed to hand a key for. The
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
                            {t.name} · {t.namespace ?? "all collections"} · {new Date(t.createdAt).toLocaleDateString()}
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
    // The space home takes over the main pane (the editor's state lives up here,
    // so leaving home lands back on the same note, unedited).
    const [home, setHome] = useState(false);
    const [jump, setJump] = useState(false);
    const [collForm, setCollForm] = useState(null); // "new" | "follow" | null — see CollectionList
    // Search hides while you scroll INTO a document and comes back the moment
    // you head back up. Only ever true on a phone (the collapse rule lives in a
    // media query); the flag is set unconditionally because it costs nothing and
    // a matchMedia listener up here would be a second source of truth for a
    // breakpoint the stylesheet already owns.
    const [scrollingDown, setScrollingDown] = useState(false);
    const lastScrollY = useRef(0);
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
        setHome(false);
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

    // Which way the pane is scrolling, for the search bar. The editor, the
    // rendered pane and the two browsing lists are four separate scroll
    // containers and scroll does NOT bubble, so this is one capture-phase
    // listener on the document rather than a handler wired into each of them.
    useEffect(() => {
        const onScroll = (e) => {
            const y = e.target?.scrollTop ?? 0;
            // Past 48px, so the bar can't flicker on the rubber-band at the top.
            setScrollingDown(y > 48 && y > lastScrollY.current);
            lastScrollY.current = y;
        };
        document.addEventListener("scroll", onScroll, true);
        return () => document.removeEventListener("scroll", onScroll, true);
    }, []);

    // ⌘K / Ctrl-K from anywhere, including with the caret inside the editor —
    // capture, so Slate doesn't get to swallow it first.
    useEffect(() => {
        const onKey = (e) => {
            if (e.key === "k" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); setJump((v) => !v); }
        };
        window.addEventListener("keydown", onKey, true);
        return () => window.removeEventListener("keydown", onKey, true);
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
        const message = window.prompt("Commit message", "update documents");
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
                if (!window.confirm(`${err.message}\n\nThey stay in history, but drop out of the current collection. Continue?`)) throw new Error("cancelled");
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

    // `parent` (optional) creates the note already nested under another one.
    const newNote = async (parent) => {
        // Looked up inline, not via titleOf: that's declared further down, and
        // a handler this one is passed to must not depend on the ordering.
        const under = parent ? ` under ${notes.find((n) => n.path === parent)?.title ?? parent}` : "";
        const name = window.prompt(`Document name${under} (e.g. ideas)`);
        if (!name) return;
        const path = name.endsWith(".md") ? name : `${name}.md`;
        try {
            await api.save(path, `# ${name.replace(/\.md$/, "")}\n\n`, undefined, parent);
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
        const to = window.prompt("Rename document to", path.replace(/\.md$/, ""));
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
        if (!window.confirm(`Delete ${what}? Removed from your working tree; published versions leave the collection on your next publish.`)) return;
        try {
            const { deleted } = await api.deleteNotes(paths);
            const list = await refreshNotes();
            if (deleted.includes(active)) {
                // Deleting from the home view must not fling you into an
                // editor — you're mid-cleanup. Just drop the open note.
                const first = home ? null : list.find((n) => n.path === "index.md") ?? list[0];
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
                ? `Delete "${target.namespace}"${here}?\n\nAlready published versions stay on-chain and readable — this app just stops tracking it. To empty the collection first, delete the notes and publish.`
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

    const titleOf = (path) => notes.find((n) => n.path === path)?.title ?? path?.replace(/\.md$/, "");
    const activeTitle = titleOf(active);
    const exportDoc = () => exportHtml(renderText, activeTitle ?? "note");
    // Where you are, spelled out. The old topbar showed a bare title, which in a
    // deep tree tells you nothing about which branch you're on.
    const crumbs = useMemo(
        () => (active ? [...(ancestorsOf(tree, active) ?? []), active] : []),
        [tree, active],
    );
    // Publishing settles ONE collection, so the button says which one — and how
    // much of it is pending. A collection that was never published counts as all
    // of it, because none of it exists off this disk yet.
    const pending = useMemo(() => {
        if (!repo?.isOwner) return 0;
        if (!repo.head) return notes.length;
        return notes.filter((n) => (n.updatedAt ?? 0) > (repo.syncedAt ?? 0)).length;
    }, [repo, notes]);

    const backlinks = useMemo(() => buildBacklinks(notes), [notes]);
    const activeBacklinks = (backlinks.get(active) ?? []).map((p) => ({
        path: p,
        title: notes.find((n) => n.path === p)?.title ?? p,
    }));
    const activeNudge = repo && nudges[repo.namespace];

    return (
        <div className="app">
            <aside className={`sidebar${navOpen ? " open" : ""}`}>
                {/* One hierarchy at a time. Collections and their documents are
                    both levels of the main view; what's left here is the short
                    list you actually move between while writing. */}
                <Popover
                    className="coll-pop"
                    panelClass="coll-panel"
                    title="Switch collection, create one, or subscribe to someone else's"
                    label={
                        <>
                            <span className="brand-mark">🌲</span>
                            <span className="coll-name">{repo?.namespace ?? "fangornmd"}</span>
                            {repo?.visibility === "private" && <span className="repo-badge" title="private (encrypted)">🔒</span>}
                            {repo && !repo.writable && <span className="repo-badge" title="read-only subscription">👁</span>}
                            <span className="pop-caret">▾</span>
                        </>
                    }
                >
                    {(close) => (
                        <CollectionMenu
                            repos={repos}
                            active={repo?.namespace}
                            nudges={nudges}
                            onSwitch={switchRepo}
                            onCreate={createRepo}
                            onFollow={followRepo}
                            onDiscover={discover}
                            onDelete={deleteRepo}
                            close={close}
                        />
                    )}
                </Popover>

                <nav className="rail">
                    {/* Not "All notes": this shows ONE namespace, and a label that
                        implied every namespace is why `second brain` looked missing. */}
                    <button className={`rail-item${home === "root" ? " active" : ""}`} onClick={() => setHome("root")}>
                        ⌂ All collections
                    </button>
                    <button className={`rail-item${home === "space" ? " active" : ""}`} onClick={() => setHome("space")}>
                        ☰ This collection
                    </button>
                    {repo?.writable && <button className="rail-item" onClick={() => newNote()}>＋ New document</button>}

                    {/* The open collection's structure, not a recents list: you
                        navigate by where a document sits far more than by when
                        you last touched it. */}
                    {repo && <div className="rail-label">{repo.namespace}</div>}
                    <SideTree tree={tree} notes={notes} active={!home ? active : null} onOpen={openNote} />
                </nav>

                <footer className="repo-info">
                    {repo && (
                        <>
                            <div>
                                {repo.visibility}
                                {repo.isOwner ? " · owner" : repo.writable ? " · collaborator" : " · read-only"}
                                {repo.isOwner && repo.collaborators?.length > 0 && ` · ${repo.collaborators.length} collaborator(s)`}
                            </div>
                            {/* A published collection has a head; an unpublished one
                                says so, because that's what decides whether any
                                of this exists outside your disk. */}
                            <div className="repo-head" title={repo.head ?? "nothing published yet"}>
                                {repo.head ? `● ${short(repo.head)}` : "◦ unpublished"}
                            </div>
                        </>
                    )}
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
                        <button className="btn ghost small" onClick={onLogout} title="Log out">Log out</button>
                    </div>
                </footer>
            </aside>
            {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

            <main className={`main${scrollingDown ? " scrolled-down" : ""}`}>
                {/* Search, at full width, in every view — it was a 13px box at
                    the bottom of a drawer, which on a phone made the fastest
                    path to anything the hardest one to find. A button dressed as
                    a field: the real input is the palette's, and two inputs that
                    both look like search but only one of which searches
                    everything is worse than one that clearly opens the other. */}
                <button className="search-bar" onClick={() => setJump(true)}>
                    <span className="search-glyph" aria-hidden="true">⌕</span>
                    <span className="search-hint">Search all collections…</span>
                    <kbd>⌘K</kbd>
                </button>
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
                    discovered collection, or an agent that publishes it from
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
                {/* `editing` marks the one state where this bar has more in it
                    than a phone can hold — document controls on top of the
                    collection's. The stylesheet uses it to shed the parts that
                    have somewhere else to live. */}
                <header className={`topbar${active && !home ? " editing" : ""}`}>
                    <button
                        className="btn ghost nav-toggle"
                        onClick={() => setNavOpen((v) => !v)}
                        aria-label="Navigation"
                        aria-expanded={navOpen}
                    >
                        ☰
                    </button>
                    {/* The crumb is the navigation, not a label: every segment
                        goes somewhere. It now starts one level higher than the
                        namespace, because the namespace list is a real place. */}
                    <nav className="crumbs" aria-label="Breadcrumb">
                        <button
                            className={`crumb root${home === "root" ? " here" : ""}`}
                            onClick={() => setHome("root")}
                            title="Every collection you track"
                        >
                            collections
                        </button>
                        {repo && (
                            <span className="crumb-seg">
                                <span className="crumb-sep" aria-hidden="true">/</span>
                                <button
                                    className={`crumb coll${home === "space" ? " here" : ""}`}
                                    onClick={() => setHome("space")}
                                    title={`Every document in ${repo.namespace}`}
                                >
                                    {repo.namespace}
                                </button>
                            </span>
                        )}
                        {!home && crumbs.map((p, n) => (
                            <span key={p} className="crumb-seg">
                                <span className="crumb-sep" aria-hidden="true">/</span>
                                <button
                                    className={`crumb${n === crumbs.length - 1 ? " here" : ""}`}
                                    onClick={() => openNote(p)}
                                    title={p}
                                >
                                    {titleOf(p)}
                                </button>
                            </span>
                        ))}
                    </nav>
                    <span className="spacer" />
                    {active && !home && (
                        <div className="view-switch" role="group" aria-label="View">
                            {["edit", "split", "read"].map((m) => (
                                <button
                                    key={m}
                                    /* `split` is hidden on a phone: there's no room for two
                                       panes, so it falls back to the source and does exactly
                                       what `edit` does. Offering a mode that changes nothing
                                       costs a third of the switch's width. */
                                    className={`view-btn ${m} ${view === m ? "active" : ""}`}
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
                    {/* Closing the document. Editing has no save step — the
                        crumb above already goes back — but leaving by clicking
                        the collection's name reads as navigation you happen to
                        be doing, not as finishing. This is the same move with
                        the intent on the label, and on a phone it's the one
                        control that gets you out of the editor without opening
                        the drawer. It says Done, not Save: the text is already
                        saved and promising otherwise would be a lie. */}
                    {active && !home && (
                        <button
                            className="btn small done-edit"
                            onClick={() => setHome("space")}
                            title={`Done — back to ${repo?.namespace ?? "the collection"}`}
                        >
                            <span aria-hidden="true">✓</span>
                            <span className="done-word">Done</span>
                        </button>
                    )}
                    {/* Public notes live in the shared room — the server persists
                        them, so there's no local save state to report. */}
                    {repo?.visibility !== "public" && !home && (
                        <span className={`save-state ${saveState}`}>{saveState}</span>
                    )}
                    {/* Publish settles ONE collection. At the root you are
                        looking at all of them, so a button naming whichever one
                        happens to be active is acting on something off screen —
                        and on a phone it was crowding out the only breadcrumb. */}
                    {repo?.isOwner && home !== "root" && (
                        <button
                            className={`btn primary publish${pending > 0 ? " pending" : ""}`}
                            onClick={publish}
                            disabled={status?.kind === "busy"}
                            title={
                                !repo.head
                                    ? `“${repo.namespace}” has never been published — this settles all ${notes.length} note(s) on-chain`
                                    : pending > 0
                                        ? `${pending} note(s) in “${repo.namespace}” changed since the last publish`
                                        : `“${repo.namespace}” matches its published head — nothing to settle`
                            }
                        >
                            <span className="publish-verb">Publish</span>
                            <span className="publish-ns">{repo.namespace}</span>
                            {pending > 0 && <span className="publish-dot" aria-hidden="true" />}
                        </button>
                    )}
                    {/* Everything that isn't "where am I" or "publish" lives
                        behind one control, so the bar fits a phone without
                        wrapping into three rows of buttons. */}
                    <Popover label="⋯" title="More actions" className="more-pop" panelClass="more-panel">
                        {(close) => (
                            <>
                                {repo && repo.visibility !== "private" && (
                                    <button className="menu-item" onClick={() => { shareLink(); close(); }}>
                                        🔗 Copy share link
                                    </button>
                                )}
                                {active && !home && (
                                    <>
                                        <button
                                            className="menu-item"
                                            onClick={() => { download(`${(activeTitle ?? active).replace(/[/\\?%*:|"<>]/g, "-")}.html`, exportDoc(), "text/html"); close(); }}
                                        >
                                            ⤓ Download as HTML
                                        </button>
                                        <button className="menu-item" onClick={() => { printDocument(exportDoc()); close(); }}>
                                            🖨 Print or save as PDF
                                        </button>
                                    </>
                                )}
                                {repo?.isOwner && repo.visibility !== "private" && (
                                    <button className="menu-item" onClick={() => { setShowCollabs((v) => !v); close(); }}>
                                        👥 Collaborators ({repo.collaborators?.length ?? 0})
                                    </button>
                                )}
                                {repo?.isOwner && (
                                    <button className="menu-item" onClick={() => { setShowAgents((v) => !v); close(); }}>
                                        🤖 Agent tokens
                                    </button>
                                )}
                                <button className="menu-item" onClick={() => { pull(); close(); }}>
                                    ↓ Pull from the network
                                </button>
                                {/* Publish's home is the bar. On a phone with a
                                    document open the bar has to give up 150px
                                    or the breadcrumb collapses to nothing, and
                                    this is the thing you're least likely to
                                    reach for mid-sentence — it settles a
                                    transaction. CSS shows this copy only in
                                    that one case. */}
                                {repo?.isOwner && (
                                    <button className="menu-item publish-in-menu" onClick={() => { publish(); close(); }}>
                                        ⛓ Publish {repo.namespace}
                                    </button>
                                )}
                            </>
                        )}
                    </Popover>
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
                {home === "root" ? (
                    <CollectionList
                        repos={repos}
                        active={repo?.namespace}
                        nudges={nudges}
                        address={address}
                        form={collForm}
                        setForm={setCollForm}
                        onOpen={(ns) => { switchRepo(ns); setHome("space"); }}
                        onDelete={deleteRepo}
                        onCreate={createRepo}
                        onFollow={followRepo}
                    />
                ) : home ? (
                    <CollectionHome
                        // Paths are per-namespace: `index.md` exists in most of
                        // them, so a pick carried across a switch would delete
                        // the wrong file. Remounting drops the selection.
                        key={repo?.namespace}
                        notes={notes}
                        tree={tree}
                        active={active}
                        writable={!!repo?.writable}
                        repo={repo}
                        onPull={pull}
                        onOpen={openNote}
                        onMove={moveNote}
                        onRename={renameNoteAt}
                        onDelete={deleteNotes}
                        onNew={newNote}
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
                    <div className="empty">
                        <p>Nothing open.</p>
                        <div className="empty-acts">
                            <button className="btn" onClick={() => setHome("space")}>Browse this namespace</button>
                            {repo?.writable && <button className="btn primary" onClick={() => newNote()}>Write a document</button>}
                        </div>
                    </div>
                )}

            </main>

            {/* ── Thumb bar ────────────────────────────────────────
                Phone only (styles.css hides it above 720px, and hides the top
                bar's copies of these actions below it). Every action here
                already exists at the top of the view; what it buys is reach —
                the top of a 6" screen is a two-handed stretch and these are the
                things you do most.

                A sibling of <main> rather than a child of it, and the app turns
                into a column at the same breakpoint: the bar is then the last
                row of a 100dvh box, so it can't be scrolled away without being
                `position: fixed` — nothing overlaps it, no scroll container
                needs bottom padding to clear it, and the software keyboard
                pushes it up on Android rather than floating it over the caret.

                It stays up while a document is open. `＋` and `⌕` are the two
                things you reach for from inside a note as often as from the
                list, and Done at the bottom-right is a shorter trip than Done in
                the top-right corner (the topbar's copy is hidden on phones). */}
            <nav className="thumbbar" aria-label="Actions">
                <button className="thumb-act" onClick={() => setJump(true)}>
                    <span className="thumb-glyph" aria-hidden="true">⌕</span>Search
                </button>
                {home === "root" ? (
                    <>
                        <button
                            className={`thumb-act${collForm === "follow" ? " on" : ""}`}
                            aria-expanded={collForm === "follow"}
                            onClick={() => setCollForm((f) => (f === "follow" ? null : "follow"))}
                        >
                            <span className="thumb-glyph" aria-hidden="true">⇩</span>Subscribe
                        </button>
                        <button
                            className={`thumb-act primary${collForm === "new" ? " on" : ""}`}
                            aria-expanded={collForm === "new"}
                            onClick={() => setCollForm((f) => (f === "new" ? null : "new"))}
                        >
                            <span className="thumb-glyph" aria-hidden="true">＋</span>Collection
                        </button>
                    </>
                ) : home ? (
                    <>
                        <button className="thumb-act" onClick={() => setHome("root")}>
                            <span className="thumb-glyph" aria-hidden="true">⌂</span>Collections
                        </button>
                        {active && (
                            <button className="thumb-act" onClick={() => setHome(false)}>
                                <span className="thumb-glyph" aria-hidden="true">✎</span>Resume
                            </button>
                        )}
                        {repo?.writable && (
                            <button className="thumb-act primary" onClick={() => newNote()}>
                                <span className="thumb-glyph" aria-hidden="true">＋</span>Document
                            </button>
                        )}
                    </>
                ) : (
                    <>
                        {/* Same move as the topbar's ✓, in the corner a thumb
                            already rests in. It says Done, not Save: the text is
                            saved as you type and promising otherwise would lie. */}
                        <button className="thumb-act" onClick={() => setHome("space")}>
                            <span className="thumb-glyph" aria-hidden="true">✓</span>Done
                        </button>
                        {repo?.writable && (
                            <button className="thumb-act primary" onClick={() => newNote()}>
                                <span className="thumb-glyph" aria-hidden="true">＋</span>Document
                            </button>
                        )}
                    </>
                )}
            </nav>

            {jump && (
                <JumpPalette
                    notes={notes}
                    repos={repos}
                    activeNs={repo?.namespace}
                    onOpen={openNote}
                    onSwitch={switchRepo}
                    onClose={() => setJump(false)}
                />
            )}
        </div>
    );
}

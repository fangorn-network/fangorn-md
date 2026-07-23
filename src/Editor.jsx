import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditor, Node, Text, Transforms } from "slate";
import { Slate, Editable, withReact, ReactEditor } from "slate-react";
import { withHistory } from "slate-history";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { withYjs, withYHistory, YjsEditor, slateNodesToInsertDelta } from "@slate-yjs/core";

// ── markdown ⇄ Slate ──────────────────────────────────────────────
// Markdown stays the source of truth: the Slate value is just the text, one
// paragraph per line. Decorations (below) style it in place without rewriting
// it, so what we serialize back is byte-for-byte what was typed.
const toSlate = (md) =>
    (md ?? "").split("\n").map((line) => ({ type: "paragraph", children: [{ text: line }] }));
const fromSlate = (nodes) => nodes.map((n) => Node.string(n)).join("\n");

// ── live preview decoration ───────────────────────────────────────
// Obsidian-style single pane: markdown renders in place as you type. Emphasis
// text is styled, and the syntax markers (**, #, [[ ]], `…`) are collapsed to
// zero width UNLESS the caret is on that line (`active`) — so it reads rendered
// but stays fully editable. Decorations are ephemeral ranges over the source
// text; serializing back (fromSlate) is byte-for-byte what was typed.
const buildDecorate = (activeBlock) => ([node, path]) => {
    const ranges = [];
    if (!Text.isText(node)) return ranges;
    const text = node.text;
    const onActive = path[0] === activeBlock;
    const push = (start, end, props) => ranges.push({ ...props, anchor: { path, offset: start }, focus: { path, offset: end } });
    const syn = (start, end) => push(start, end, { syntax: true, active: onActive });
    const scan = (re, fn) => { let m; while ((m = re.exec(text))) fn(m); };

    const h = text.match(/^(#{1,6})\s/);
    if (h) { push(0, text.length, { heading: h[1].length }); syn(0, h[0].length); }

    scan(/\*\*(.+?)\*\*/g, (m) => { const i = m.index, e = i + m[0].length; push(i, e, { bold: true }); syn(i, i + 2); syn(e - 2, e); });
    scan(/(?<![*\w])\*(?!\*)(.+?)(?<!\*)\*(?![*\w])/g, (m) => { const i = m.index, e = i + m[0].length; push(i, e, { italic: true }); syn(i, i + 1); syn(e - 1, e); });
    scan(/`([^`]+?)`/g, (m) => { const i = m.index, e = i + m[0].length; push(i, e, { code: true }); syn(i, i + 1); syn(e - 1, e); });
    scan(/~~(.+?)~~/g, (m) => { const i = m.index, e = i + m[0].length; push(i, e, { strike: true }); syn(i, i + 2); syn(e - 2, e); });
    // [[wikilink]] → foo.md ; keep the pipe/anchor tail inside the hidden marker
    scan(/\[\[([^\]|#]+?)(?:[|#][^\]]*)?\]\]/g, (m) => {
        const i = m.index, e = i + m[0].length;
        push(i, e, { link: true, href: `${m[1].trim()}.md` });
        syn(i, i + 2); syn(i + 2 + m[1].length, e);
    });
    // [text](url) → show text, hide "[" and "](url)"
    scan(/\[([^\]]+?)\]\(([^)\s]+?)\)/g, (m) => {
        const i = m.index, e = i + m[0].length, textEnd = i + 1 + m[1].length;
        push(i, e, { link: true, href: m[2] });
        syn(i, i + 1); syn(textEnd, e);
    });
    // list / quote markers stay visible but dimmed (a bullet needs to show)
    scan(/^\s*(?:[-*+]|\d+\.)\s/g, (m) => push(m.index, m.index + m[0].length, { listmark: true }));
    scan(/^>\s/g, (m) => push(m.index, m.index + m[0].length, { quote: true }));
    return ranges;
};

const HEADING_SIZE = { 1: "1.7em", 2: "1.45em", 3: "1.25em", 4: "1.1em", 5: "1em", 6: "1em" };

function Leaf({ attributes, children, leaf }) {
    if (leaf.syntax) {
        return <span {...attributes} className={leaf.active ? "md-syntax md-syntax-on" : "md-syntax"}>{children}</span>;
    }
    const style = {};
    if (leaf.heading) { style.fontWeight = 700; style.fontSize = HEADING_SIZE[leaf.heading]; }
    if (leaf.bold) style.fontWeight = 700;
    if (leaf.italic) style.fontStyle = "italic";
    if (leaf.strike) style.textDecoration = "line-through";
    if (leaf.code) { style.fontFamily = "ui-monospace, monospace"; style.background = "var(--bg-panel)"; style.borderRadius = "4px"; style.padding = "0 3px"; }
    if (leaf.listmark || leaf.quote) style.color = "var(--text-dim)";
    if (leaf.link) return <span {...attributes} className="md-link" data-href={leaf.href}>{children}</span>;
    return <span {...attributes} style={style}>{children}</span>;
}

// The single editing surface. Both editors below hand it a ready `editor`.
// Ctrl/⌘-click a rendered link to follow it (plain click just edits).
function MarkdownSlate({ editor, initialValue, onSlateChange, onNavigate }) {
    const [activeBlock, setActiveBlock] = useState(-1);
    const decorate = useCallback(buildDecorate(activeBlock), [activeBlock]);
    const handleChange = () => {
        setActiveBlock(editor.selection ? editor.selection.focus.path[0] : -1);
        onSlateChange();
    };
    const handleClick = (e) => {
        const el = e.target.closest?.("[data-href]");
        if (el && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onNavigate(el.getAttribute("data-href")); }
    };
    return (
        <div className="editor">
            <Slate editor={editor} initialValue={initialValue} onChange={handleChange}>
                <Editable
                    className="editor-input"
                    decorate={decorate}
                    renderLeaf={useCallback((props) => <Leaf {...props} />, [])}
                    onClick={handleClick}
                    spellCheck={false}
                    placeholder="Write here… markdown renders as you type"
                />
            </Slate>
        </div>
    );
}

// ── Solo editor (private repos / offline) ─────────────────────────
export default function Editor({ content, onChange, onNavigate, noteKey }) {
    // A fresh editor per note is the documented multi-document pattern: it
    // resets history and selection cleanly on switch.
    const editor = useMemo(() => withHistory(withReact(createEditor())), [noteKey]);
    const initialValue = useMemo(() => toSlate(content), [noteKey]);

    // External update to the *open* note (a pull while viewing): App only sends
    // one when the buffer isn't dirty, but guard on focus too so we never yank
    // the cursor mid-keystroke.
    useEffect(() => {
        if (ReactEditor.isFocused(editor)) return;
        if (content === fromSlate(editor.children)) return;
        Transforms.deselect(editor);
        editor.children = toSlate(content);
        editor.onChange();
    }, [content, editor]);

    const onSlateChange = () => {
        if (editor.operations.some((op) => op.type !== "set_selection")) onChange(fromSlate(editor.children));
    };

    return <MarkdownSlate editor={editor} initialValue={initialValue} onSlateChange={onSlateChange} onNavigate={onNavigate} />;
}

// ── Collaborative editor (public repos) ───────────────────────────
// Binds the Slate doc to a shared Yjs document relayed by the server, so a team
// co-edits the same note live. Each keystroke (local OR merged-in remote) fires
// Slate's onChange → the parent autosaves the markdown to disk, so Publish (the
// owner-signed on-chain layer) keeps reading a plain file exactly as before.

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/yjs`;
const PLACEHOLDER = [{ type: "paragraph", children: [{ text: "" }] }];

// Stable per-address colour for presence chips.
const colorFor = (addr) => `hsl(${[...(addr ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 60% 45%)`;
const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

export function CollabEditor({ owner, namespace, note, content, onChange, onNavigate, address, getToken, writable }) {
    const room = `${owner}:${namespace}:${note}`;
    const seedRef = useRef(content);
    seedRef.current = content; // latest file content, in case we're first to seed
    const [conn, setConn] = useState(null); // { provider, editor }
    const [peers, setPeers] = useState([]);

    // (Re)build the Yjs doc + socket + bound editor whenever the note changes.
    useEffect(() => {
        let provider, editor, cancelled = false;
        (async () => {
            const token = await getToken();
            if (cancelled) return;
            const doc = new Y.Doc();
            provider = new WebsocketProvider(WS_URL, encodeURIComponent(room), doc, { params: { token, address } });
            const sharedType = doc.get("content", Y.XmlText);
            editor = withYHistory(withYjs(withReact(createEditor()), sharedType));

            // First peer into an empty room seeds it from the file. Only a writer
            // (the owner) seeds, so a follower opening first can't clobber the
            // owner's content with an empty draft.
            // ponytail: two writers hitting an empty room at once could double-seed;
            // fine for a first slice, revisit if it ever bites.
            provider.once("sync", (isSynced) => {
                if (isSynced && writable && sharedType.length === 0) {
                    sharedType.applyDelta(slateNodesToInsertDelta(toSlate(seedRef.current)));
                }
            });

            // Presence: broadcast who we are, track who else is here.
            provider.awareness.setLocalStateField("user", { address });
            const onAwareness = () =>
                setPeers([...provider.awareness.getStates().values()].map((s) => s.user).filter(Boolean));
            provider.awareness.on("change", onAwareness);
            onAwareness();

            YjsEditor.connect(editor);
            if (!cancelled) setConn({ provider, editor });
        })();

        return () => {
            cancelled = true;
            if (editor) YjsEditor.disconnect(editor);
            if (provider) provider.destroy(); // closes socket + awareness
            setConn(null);
            setPeers([]);
        };
    }, [room]); // eslint-disable-line react-hooks/exhaustive-deps

    const onSlateChange = () => {
        if (!conn) return;
        if (conn.editor.operations.some((op) => op.type !== "set_selection")) {
            onChange(fromSlate(conn.editor.children)); // parent autosaves to disk (publishable working tree)
        }
    };

    return (
        <div className="collab">
            <div className="presence-bar">
                <span className="presence-label">live</span>
                {peers.map((p, i) => (
                    <span key={i} className="presence-chip" style={{ background: colorFor(p.address) }} title={p.address}>
                        {p.address?.toLowerCase() === address?.toLowerCase() ? "you" : short(p.address)}
                    </span>
                ))}
            </div>
            {conn ? (
                <MarkdownSlate editor={conn.editor} initialValue={PLACEHOLDER} onSlateChange={onSlateChange} onNavigate={onNavigate} />
            ) : (
                <div className="empty">connecting to the live session…</div>
            )}
        </div>
    );
}

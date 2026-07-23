import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { createEditor, Editor as SEditor, Node, Text, Transforms } from "slate";
import { Slate, Editable, withReact, ReactEditor } from "slate-react";
import { withHistory } from "slate-history";
import katex from "katex";
import "katex/dist/katex.min.css";
import { findMath } from "./mdmath.js";
import { fenceLines } from "./mdfence.js";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { withYjs, withYHistory, YjsEditor } from "@slate-yjs/core";

// ── markdown ⇄ Slate ──────────────────────────────────────────────
// Markdown stays the source of truth: the Slate value is just the text, one
// paragraph per line. Decorations (below) style it in place without rewriting
// it, so what we serialize back is byte-for-byte what was typed.
const toSlate = (md) =>
    (md ?? "").split("\n").map((line) => ({ type: "paragraph", children: [{ text: line }] }));
const fromSlate = (nodes) => nodes.map((n) => Node.string(n)).join("\n");

// ── fenced code blocks ────────────────────────────────────────────
// ``` fences span lines, but decorate/renderElement see one block at a time, so
// classify the whole doc once and look the line up. Slate replaces `children`
// (immer) on every change, so its identity is a free document version.
let fenceCache = { key: null, val: [] };
const fences = (children) => {
    if (fenceCache.key === children) return fenceCache.val;
    fenceCache = { key: children, val: fenceLines(children.map((n) => Node.string(n))) };
    return fenceCache.val;
};

// ── live preview decoration ───────────────────────────────────────
// Obsidian-style single pane: markdown renders in place as you type. Emphasis
// text is styled, and the syntax markers (**, #, [[ ]], `…`) are collapsed to
// zero width UNLESS the caret is on that line (`active`) — so it reads rendered
// but stays fully editable. Decorations are ephemeral ranges over the source
// text; serializing back (fromSlate) is byte-for-byte what was typed.
const buildDecorate = (editor, activeBlock) => ([node, path]) => {
    const ranges = [];
    if (!Text.isText(node)) return ranges;
    // Inside a fence everything is literal code — no markdown, no math.
    if (fences(editor.children)[path[0]]) return ranges;
    const text = node.text;
    const onActive = path[0] === activeBlock;
    const push = (start, end, props) => ranges.push({ ...props, anchor: { path, offset: start }, focus: { path, offset: end } });
    const syn = (start, end) => push(start, end, { syntax: true, active: onActive });
    // Anything inside a math span is LaTeX, not markdown — a stray * or ` in a
    // formula would otherwise split the range into fragments that each re-render
    // the whole equation.
    const mathSpans = findMath(text);
    const inMath = (i) => mathSpans.some((m) => i >= m.start && i < m.end);
    const scan = (re, fn) => { let m; while ((m = re.exec(text))) if (!inMath(m.index)) fn(m); };
    for (const m of mathSpans) push(m.start, m.end, { math: m.tex, display: m.display, active: onActive });

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

// decorate() re-runs on every keystroke, so memoise the KaTeX HTML by source.
// ponytail: crude clear-at-cap instead of an LRU — a note holds tens of formulas,
// not thousands; swap in the LRU pattern if that ever stops being true.
const mathCache = new Map();
const renderMath = (tex, display) => {
    const key = `${display ? "d" : "i"}:${tex}`;
    let html = mathCache.get(key);
    if (html === undefined) {
        // throwOnError:false → KaTeX renders bad input as red source, never throws.
        html = katex.renderToString(tex, { throwOnError: false, displayMode: !!display });
        if (mathCache.size > 500) mathCache.clear();
        mathCache.set(key, html);
    }
    return html;
};

function Leaf({ attributes, children, leaf }) {
    // Math renders as KaTeX when the caret is on another line, and falls back to
    // the raw $…$ source when you're editing that line. The source text always
    // stays in the DOM (zero-width while rendered) so Slate can still map
    // selections onto it — same trick as the syntax markers below.
    if (leaf.math !== undefined) {
        if (leaf.active) return <span {...attributes} className="md-math-src">{children}</span>;
        return (
            <span {...attributes} className="md-math">
                <span
                    className={leaf.display ? "md-math-render display" : "md-math-render"}
                    contentEditable={false}
                    dangerouslySetInnerHTML={{ __html: renderMath(leaf.math, leaf.display) }}
                />
                <span className="md-syntax">{children}</span>
            </span>
        );
    }
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

// Full-width code-block chrome belongs on the block, not the leaves — a leaf
// background only paints as wide as its text. The ``` lines themselves collapse
// to zero height (md-cb-on when the caret is on them), same trick as .md-syntax:
// the text stays in the DOM so Slate can resolve selections onto it.
const buildRenderElement = (editor, activeBlock) => ({ attributes, children, element }) => {
    const block = ReactEditor.findPath(editor, element)[0];
    const fence = fences(editor.children)[block];
    const cls = fence
        ? `md-cb md-cb-${fence}${fence !== "body" && block === activeBlock ? " md-cb-on" : ""}`
        : undefined;
    return <div {...attributes} className={cls}>{children}</div>;
};

// ── formatting toolbar ────────────────────────────────────────────
// The buttons edit the *markdown source* — wrap the selection in **, $, `… or
// prefix the line with #, -, > — rather than toggling Slate marks. The document
// stays plain markdown, so the decorations above render the result and Publish
// keeps reading the same bytes.
const wrapSelection = (editor, before, after = before) => {
    if (!editor.selection) return;
    const text = SEditor.string(editor, editor.selection);
    Transforms.insertText(editor, `${before}${text}${after}`);
    // Nothing was selected: drop the caret between the markers so you can type.
    if (!text) Transforms.move(editor, { distance: after.length, unit: "character", reverse: true });
};

// Add/remove a line prefix ("# ", "- ", "> ") on the block holding the caret.
const togglePrefix = (editor, prefix) => {
    if (!editor.selection) return;
    const block = editor.selection.focus.path[0];
    const path = [block, 0];
    const start = { path, offset: 0 };
    if (SEditor.string(editor, [block]).startsWith(prefix)) {
        Transforms.delete(editor, { at: { anchor: start, focus: { path, offset: prefix.length } } });
    } else {
        Transforms.insertText(editor, prefix, { at: start });
    }
};

// ``` fence around the selection. Each selected line becomes its own block, so
// the one-paragraph-per-line invariant (and fromSlate) still holds.
const insertFence = (editor) => {
    if (!editor.selection) return;
    const body = SEditor.string(editor, editor.selection).split("\n");
    Transforms.insertText(editor, "```"); // replaces the selection
    body.forEach((line) => { SEditor.insertBreak(editor); Transforms.insertText(editor, line); });
    SEditor.insertBreak(editor);
    Transforms.insertText(editor, "```");
    Transforms.select(editor, SEditor.end(editor, [editor.selection.focus.path[0] - 1]));
};

const TOOLS = [
    ["H1", "Heading 1", (e) => togglePrefix(e, "# ")],
    ["H2", "Heading 2", (e) => togglePrefix(e, "## ")],
    ["B", "Bold  (⌘/Ctrl+B)", (e) => wrapSelection(e, "**")],
    ["I", "Italic  (⌘/Ctrl+I)", (e) => wrapSelection(e, "*")],
    ["S", "Strikethrough", (e) => wrapSelection(e, "~~")],
    ["‹›", "Inline code", (e) => wrapSelection(e, "`")],
    ["{ }", "Code block  (``` fence)", insertFence],
    ["•", "Bullet list", (e) => togglePrefix(e, "- ")],
    ["❝", "Quote", (e) => togglePrefix(e, "> ")],
    ["🔗", "Link", (e) => wrapSelection(e, "[", "](url)")],
    ["∑", "Math — LaTeX between $…$", (e) => wrapSelection(e, "$")],
];

function FormatBar({ editor }) {
    return (
        <div className="fmt-bar">
            {TOOLS.map(([label, title, fn], i) => (
                <Fragment key={title}>
                    <button
                        type="button"
                        className="fmt-btn"
                        title={title}
                        // mousedown (not click) + preventDefault: keeps focus and
                        // the live selection in the editor, so the transform has
                        // a target.
                        onMouseDown={(ev) => { ev.preventDefault(); fn(editor); ReactEditor.focus(editor); }}
                    >
                        {label}
                    </button>
                    {(i === 1 || i === 6 || i === 8) && <span className="fmt-sep" />}
                </Fragment>
            ))}
        </div>
    );
}

// The single editing surface. Both editors below hand it a ready `editor`.
// Ctrl/⌘-click a rendered link to follow it (plain click just edits).
function MarkdownSlate({ editor, initialValue, onSlateChange, onNavigate, readOnly }) {
    const [activeBlock, setActiveBlock] = useState(-1);
    const decorate = useCallback(buildDecorate(editor, activeBlock), [editor, activeBlock]);
    const renderElement = useCallback(buildRenderElement(editor, activeBlock), [editor, activeBlock]);
    const handleChange = () => {
        setActiveBlock(editor.selection ? editor.selection.focus.path[0] : -1);
        onSlateChange?.();
    };
    const handleClick = (e) => {
        const el = e.target.closest?.("[data-href]");
        if (el && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onNavigate(el.getAttribute("data-href")); }
    };
    const handleKeyDown = (e) => {
        // Enter on an unterminated ``` opens the block instead of turning the
        // rest of the note into code: caret lands in the body, closer below.
        if (e.key === "Enter" && !e.shiftKey && editor.selection) {
            const block = editor.selection.focus.path[0];
            const marks = fences(editor.children);
            if (marks[block] === "open" && !marks.includes("close", block)) {
                e.preventDefault();
                SEditor.insertBreak(editor);
                Transforms.insertNodes(editor, { type: "paragraph", children: [{ text: "```" }] }, { at: [block + 2] });
            }
            return;
        }
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = e.key.toLowerCase();
        if (k === "b") { e.preventDefault(); wrapSelection(editor, "**"); }
        else if (k === "i") { e.preventDefault(); wrapSelection(editor, "*"); }
    };
    return (
        <Slate editor={editor} initialValue={initialValue} onChange={handleChange}>
            {!readOnly && <FormatBar editor={editor} />}
            <div className="editor">
                <Editable
                    className="editor-input"
                    readOnly={readOnly}
                    decorate={decorate}
                    renderElement={renderElement}
                    renderLeaf={useCallback((props) => <Leaf {...props} />, [])}
                    onClick={handleClick}
                    onKeyDown={handleKeyDown}
                    spellCheck={false}
                    placeholder="Write here… markdown renders as you type"
                />
            </div>
        </Slate>
    );
}

// ── Solo editor (private repos / offline) ─────────────────────────
export default function Editor({ content, onChange, onNavigate, noteKey, readOnly }) {
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

    return (
        <MarkdownSlate
            editor={editor}
            initialValue={initialValue}
            onSlateChange={onSlateChange}
            onNavigate={onNavigate}
            readOnly={readOnly}
        />
    );
}

// ── Collaborative editor (public repos) ───────────────────────────
// Binds the Slate doc to a shared Yjs document held by the server, so everyone
// looking at a note sees the same text change under their cursor. Read-only
// viewers join the same room — they just can't type into it (the server drops
// their writes; `readOnly` here only makes that visible rather than surprising).
//
// Nothing is saved from here. The server seeds the room from the owner's file
// and writes the merged text back on a debounce, so a note stays current
// whether or not its owner happens to be connected. See server/index.js.

const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/yjs`;
const PLACEHOLDER = [{ type: "paragraph", children: [{ text: "" }] }];

// Stable per-address colour for presence chips.
const colorFor = (addr) => `hsl(${[...(addr ?? "")].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 60% 45%)`;
const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");

export function CollabEditor({ owner, namespace, note, onNavigate, address, getToken, readOnly }) {
    const room = `${owner}:${namespace}:${note}`;
    const [conn, setConn] = useState(null); // { provider, editor }
    const [peers, setPeers] = useState([]);
    const [wsStatus, setWsStatus] = useState("connecting");

    // (Re)build the Yjs doc + socket + bound editor whenever the note changes.
    useEffect(() => {
        let provider, cancelled = false;
        setWsStatus("connecting");
        (async () => {
            const token = await getToken();
            if (cancelled) return;
            const doc = new Y.Doc();
            provider = new WebsocketProvider(WS_URL, encodeURIComponent(room), doc, { params: { token, address } });
            const sharedType = doc.get("content", Y.XmlText);
            const editor = withYHistory(withYjs(withReact(createEditor()), sharedType));

            provider.on("status", ({ status }) => setWsStatus(status));
            // Presence: broadcast who we are, track who else is here.
            provider.awareness.setLocalStateField("user", { address });
            const onAwareness = () =>
                setPeers([...provider.awareness.getStates().values()].map((s) => s.user).filter(Boolean));
            provider.awareness.on("change", onAwareness);
            onAwareness();

            if (!cancelled) setConn({ provider, editor });
        })();

        return () => {
            cancelled = true;
            if (provider) provider.destroy(); // closes socket + awareness
            setConn(null);
            setPeers([]);
        };
    }, [room]); // eslint-disable-line react-hooks/exhaustive-deps

    // Connect only AFTER <Slate> has mounted. Slate assigns
    // `editor.children = initialValue` on its first render, so connecting any
    // earlier means the room's real content gets loaded into the editor and then
    // overwritten by PLACEHOLDER — a blank page over a non-empty document.
    useEffect(() => {
        if (!conn) return;
        YjsEditor.connect(conn.editor);
        return () => YjsEditor.disconnect(conn.editor);
    }, [conn]);

    return (
        <div className="collab">
            <div className="presence-bar">
                <span className={`presence-label ${wsStatus}`}>
                    {wsStatus === "connected" ? "live" : wsStatus}
                </span>
                {peers.map((p, i) => (
                    <span key={i} className="presence-chip" style={{ background: colorFor(p.address) }} title={p.address}>
                        {p.address?.toLowerCase() === address?.toLowerCase() ? "you" : short(p.address)}
                    </span>
                ))}
                {readOnly && <span className="presence-note">read-only — following along</span>}
            </div>
            {conn ? (
                <MarkdownSlate
                    editor={conn.editor}
                    initialValue={PLACEHOLDER}
                    onNavigate={onNavigate}
                    readOnly={readOnly}
                />
            ) : (
                <div className="empty">connecting to the live session…</div>
            )}
        </div>
    );
}

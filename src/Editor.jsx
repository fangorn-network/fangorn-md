import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditor, Editor as SEditor, Node, Text, Transforms } from "slate";
import { Slate, Editable, withReact, ReactEditor } from "slate-react";
import { withHistory } from "slate-history";
import "katex/dist/katex.min.css";
import { findMath } from "./mdmath.js";
import { fenceLines } from "./mdfence.js";
import { renderMarkdown, renderMath } from "./render.js";
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
    // ![alt](src) → the image itself, source collapsed (same trick as math)
    scan(/!\[([^\]]*)\]\(([^)\s]+?)\)/g, (m) => {
        const i = m.index, e = i + m[0].length;
        push(i, e, { image: m[2], alt: m[1], active: onActive });
    });
    // [text](url) → show text, hide "[" and "](url)"  (not the image form above)
    scan(/(?<!!)\[([^\]]+?)\]\(([^)\s]+?)\)/g, (m) => {
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
    if (leaf.image !== undefined) {
        if (leaf.active) return <span {...attributes} className="md-math-src">{children}</span>;
        return (
            <span {...attributes} className="md-img">
                <img className="md-img-render" src={leaf.image} alt={leaf.alt} contentEditable={false} />
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

// Stable by construction — nothing to close over, so no hook and no chance of
// it being called from inside a conditional branch of the JSX.
const renderLeaf = (props) => <Leaf {...props} />;

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

// Pasted/dropped images go in as data-URI markdown. No upload endpoint, no
// blob store, no extra file to publish: the note stays one self-contained .md,
// so it survives publish → pull → CRDT sync unchanged.
// ponytail: base64 inflates by 4/3 and lives in the note's text (and its Yjs
// doc), so it's capped small — swap in an asset endpoint if people start
// pasting photos rather than screenshots.
const MAX_IMAGE_BYTES = 1_000_000;
const insertImage = (editor, file) => {
    if (file.size > MAX_IMAGE_BYTES) {
        alert(`That image is ${Math.round(file.size / 1e5) / 10} MB — images have to be under 1 MB.`);
        return;
    }
    const reader = new FileReader();
    reader.onload = () => Transforms.insertText(editor, `![](${reader.result})`);
    reader.readAsDataURL(file);
};
const imageFrom = (dataTransfer) =>
    [...(dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/"));

// ── read pane ─────────────────────────────────────────────────────
// The rendered half of the split. In the editor a link is always source under
// the caret, so this is where one is finally just a link: a plain click on a
// note link navigates, external links open in a tab. Same markdown, no caret.
function DocView({ md, onNavigate, paneRef, onScroll }) {
    const html = useMemo(() => renderMarkdown(md), [md]);
    const handleClick = (e) => {
        const a = e.target.closest?.("a[data-note]");
        if (!a) return;
        e.preventDefault();
        onNavigate(a.getAttribute("data-note"));
    };
    return (
        <div className="doc-view" ref={paneRef} onScroll={onScroll}>
            {/* The HTML is built by render.js, which escapes every byte of the
                note — the only tags here are the ones it writes itself. */}
            <article className="doc-render" onClick={handleClick} dangerouslySetInnerHTML={{ __html: html }} />
        </div>
    );
}

// The single editing surface. Both editors below hand it a ready `editor`.
// Ctrl/⌘-click a rendered link to follow it (plain click just edits).
// `view` is "edit" | "split" | "read"; the read pane renders `previewText`,
// which the owner of that state keeps current from onText below.
// A collapsed pane leaves a rail behind rather than vanishing, so the way back
// is where the pane was — no hunting for the control that hid it.
const Rail = ({ side, label, onExpand }) => (
    <button className={`pane-rail ${side}`} onClick={onExpand} title={`Show the ${label}`}>
        <span className="pane-rail-chev">{side === "left" ? "›" : "‹"}</span>
        <span className="pane-rail-label">{label}</span>
    </button>
);

function MarkdownSlate({
    editor, initialValue, onSlateChange, onNavigate, readOnly,
    view = "edit", onViewChange, previewText = "",
}) {
    const [activeBlock, setActiveBlock] = useState(-1);
    const editPane = useRef(null);
    const readPane = useRef(null);
    const locked = useRef(false);

    // Proportional scroll sync for the split. The panes have different heights
    // (rendered markdown is shorter than its source), so match the fraction
    // scrolled rather than the pixels, and lock for a frame so the pane we just
    // moved doesn't echo the scroll back.
    const syncScroll = (fromRef, toRef) => () => {
        const from = fromRef.current, to = toRef.current;
        if (view !== "split" || !from || !to || locked.current) return;
        locked.current = true;
        const room = from.scrollHeight - from.clientHeight;
        to.scrollTop = room > 0 ? (from.scrollTop / room) * (to.scrollHeight - to.clientHeight) : 0;
        requestAnimationFrame(() => { locked.current = false; });
    };

    // renderLeaf lives at module scope (below): it closes over nothing, so it's
    // already stable, and a hook inside the `view !== "read"` branch of the JSX
    // was a hook that stopped being called when you switched to Read — fewer
    // hooks than the previous render, which React throws on. Blank screen.
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
    const handleImage = (e) => {
        const file = imageFrom(e.clipboardData ?? e.dataTransfer);
        if (!file || readOnly) return; // let Slate handle text as usual
        e.preventDefault();
        insertImage(editor, file);
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
            {!readOnly && view !== "read" && <FormatBar editor={editor} />}
            <div className={`panes ${view}`}>
                {view === "read" && onViewChange && (
                    <Rail side="left" label="markdown" onExpand={() => onViewChange("split")} />
                )}
                {view !== "read" && (
                    <div className="editor" ref={editPane} onScroll={syncScroll(editPane, readPane)}>
                        <Editable
                            className="editor-input"
                            readOnly={readOnly}
                            decorate={decorate}
                            renderElement={renderElement}
                            renderLeaf={renderLeaf}
                            onClick={handleClick}
                            onKeyDown={handleKeyDown}
                            // preventDefault is how Slate is told the event is handled.
                            onPaste={handleImage}
                            onDrop={handleImage}
                            spellCheck={false}
                            placeholder="Write here… markdown renders as you type"
                        />
                    </div>
                )}
                {view === "split" && onViewChange && (
                    <div className="pane-divider">
                        <button className="pane-collapse" title="Hide the markdown" onClick={() => onViewChange("read")}>‹</button>
                        <button className="pane-collapse" title="Hide the document" onClick={() => onViewChange("edit")}>›</button>
                    </div>
                )}
                {view !== "edit" && (
                    <DocView
                        md={previewText}
                        onNavigate={onNavigate}
                        paneRef={readPane}
                        onScroll={syncScroll(readPane, editPane)}
                    />
                )}
                {view === "edit" && onViewChange && (
                    <Rail side="right" label="document" onExpand={() => onViewChange("split")} />
                )}
            </div>
        </Slate>
    );
}

// ── Solo editor (private repos / offline) ─────────────────────────
export default function Editor({ content, onChange, onNavigate, noteKey, readOnly, view, onViewChange }) {
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
            view={view}
            onViewChange={onViewChange}
            // Solo notes already lift every keystroke to App (that's the
            // autosave), so `content` is the live text — no second channel.
            previewText={content}
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

export function CollabEditor({
    owner, namespace, note, onNavigate, address, getToken, readOnly,
    view, onViewChange, onText, previewText,
}) {
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
        // Nothing is typed yet, but the room's text just landed — hand it up so
        // the read pane and Export start from the document, not from blank.
        onText?.(fromSlate(conn.editor.children));
        return () => YjsEditor.disconnect(conn.editor);
    }, [conn]); // eslint-disable-line react-hooks/exhaustive-deps

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
                    // Collab notes are never saved from here (the server owns
                    // the room), so this reports text purely so the read pane
                    // and Export can see what everyone is typing.
                    onSlateChange={() => onText?.(fromSlate(conn.editor.children))}
                    onNavigate={onNavigate}
                    readOnly={readOnly}
                    view={view}
                    onViewChange={onViewChange}
                    previewText={previewText}
                />
            ) : (
                <div className="empty">connecting to the live session…</div>
            )}
        </div>
    );
}

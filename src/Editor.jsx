import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditor, Node, Text, Transforms } from "slate";
import { Slate, Editable, withReact, ReactEditor } from "slate-react";
import { withHistory } from "slate-history";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { withYjs, withYHistory, YjsEditor, slateNodesToInsertDelta } from "@slate-yjs/core";
import { marked } from "marked";
import DOMPurify from "dompurify";

// ── markdown ⇄ Slate ──────────────────────────────────────────────
// Markdown stays the source of truth: the Slate value is just the text, one
// paragraph per line. Decorations (below) style it in place without rewriting
// it, so what we serialize back is byte-for-byte what was typed.
const toSlate = (md) =>
    (md ?? "").split("\n").map((line) => ({ type: "paragraph", children: [{ text: line }] }));
const fromSlate = (nodes) => nodes.map((n) => Node.string(n)).join("\n");

// ── live syntax decoration ────────────────────────────────────────
// A few regexes cover the wiki's markdown. Decorations are ephemeral ranges,
// not stored nodes — overlaps are fine, Slate merges the marks.
const decorate = ([node, path]) => {
    const ranges = [];
    if (!Text.isText(node)) return ranges;
    const text = node.text;

    const h = text.match(/^(#{1,6})\s/);
    if (h) ranges.push({ heading: h[1].length, anchor: { path, offset: 0 }, focus: { path, offset: text.length } });

    const add = (re, mark) => {
        let m;
        while ((m = re.exec(text))) {
            ranges.push({ [mark]: true, anchor: { path, offset: m.index }, focus: { path, offset: m.index + m[0].length } });
        }
    };
    add(/\*\*.+?\*\*/g, "bold");
    add(/(?<![*\w])\*(?!\*).+?(?<!\*)\*(?![*\w])/g, "italic");
    add(/`[^`]+?`/g, "code");
    add(/~~.+?~~/g, "strike");
    add(/\[\[[^\]]+?\]\]/g, "link");
    add(/\[[^\]]+?\]\([^)]+?\)/g, "link");
    add(/^\s*(?:[-*+]|\d+\.)\s/g, "listmark");
    add(/^>\s/g, "quote");
    return ranges;
};

const HEADING_SIZE = { 1: "1.6em", 2: "1.4em", 3: "1.2em", 4: "1.05em", 5: "1em", 6: "1em" };

function Leaf({ attributes, children, leaf }) {
    const style = {};
    if (leaf.heading) { style.fontWeight = 700; style.fontSize = HEADING_SIZE[leaf.heading]; }
    if (leaf.bold) style.fontWeight = 700;
    if (leaf.italic) style.fontStyle = "italic";
    if (leaf.strike) style.textDecoration = "line-through";
    if (leaf.code) { style.fontFamily = "ui-monospace, monospace"; style.background = "var(--bg-panel)"; style.borderRadius = "4px"; style.padding = "0 3px"; }
    if (leaf.link) style.color = "#539bf5";
    if (leaf.listmark) style.color = "var(--text-dim)";
    if (leaf.quote) style.color = "var(--text-dim)";
    return <span {...attributes} style={style}>{children}</span>;
}

// ── rendered preview (unchanged behaviour) ────────────────────────
// A cloned wiki is someone else's content and this app runs on your machine —
// never let a note inject script. `[[wikilink]]` → a real markdown link.
function render(markdown) {
    const withWikiLinks = (markdown ?? "").replace(/\[\[([\w .-]+?)\]\]/g, (_, name) => `[${name}](${name}.md)`);
    return DOMPurify.sanitize(marked.parse(withWikiLinks));
}

// The shared editing surface: decorated Slate source on the left, rendered
// preview on the right. Both editors below hand it a ready `editor` + value.
function MarkdownSlate({ editor, initialValue, onSlateChange, onNavigate, markdown }) {
    const html = useMemo(() => render(markdown), [markdown]);
    const handlePreviewClick = (e) => {
        const link = e.target.closest("a");
        if (!link) return;
        const href = link.getAttribute("href") ?? "";
        if (href.endsWith(".md") && !href.includes("://")) {
            e.preventDefault();
            onNavigate(href);
        }
    };
    return (
        <div className="editor">
            <Slate editor={editor} initialValue={initialValue} onChange={onSlateChange}>
                <Editable
                    className="editor-input"
                    decorate={decorate}
                    renderLeaf={useCallback((props) => <Leaf {...props} />, [])}
                    spellCheck={false}
                    placeholder="Write markdown…"
                />
            </Slate>
            <div className="editor-preview" onClick={handlePreviewClick} dangerouslySetInnerHTML={{ __html: html }} />
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

    return <MarkdownSlate editor={editor} initialValue={initialValue} onSlateChange={onSlateChange} onNavigate={onNavigate} markdown={content} />;
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
    const [md, setMd] = useState(content);
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
            const next = fromSlate(conn.editor.children);
            setMd(next);
            onChange(next); // parent autosaves to disk (publishable working tree)
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
                <MarkdownSlate editor={conn.editor} initialValue={PLACEHOLDER} onSlateChange={onSlateChange} onNavigate={onNavigate} markdown={md} />
            ) : (
                <div className="empty">connecting to the live session…</div>
            )}
        </div>
    );
}

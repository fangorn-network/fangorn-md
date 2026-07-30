// ── markdown → rendered HTML ──────────────────────────────────────
//
// The editor keeps markdown as the source of truth and styles it in place, so
// there is never a moment where a link is just a link: every [text](url) is
// still editable source under the caret. This is the other half — a read view
// where the syntax is gone, the links are clickable and the document can leave
// the app.
//
// It shares mdmath.js / mdfence.js with the editor's decorations, so the two
// panes can't drift on what counts as bold, a fence or a formula.
//
// Output is an HTML string rather than React elements because Export needs
// exactly that: one renderer, two destinations (a pane and a .html file).
// Nothing from the note reaches the output unescaped — a public namespace is
// someone else's text rendering in your browser, so the only tags in the result
// are the ones written here.

import katex from "katex";
import { findMath } from "./mdmath.js";
import { fenceLines } from "./mdfence.js";

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

// Schemes a note has any business linking to. Everything else — javascript:,
// vbscript:, data:text/html — becomes a dead link instead of something that
// runs when a subscriber opens the note. A URL with no scheme at all is a
// relative path (another note, an image beside it) and is fine.
const safeUrl = (u) => (/^(https?:|mailto:|data:image\/)/i.test(u) || !u.includes(":") ? u : "#");

// decorate() and the read pane both re-render on every keystroke, so memoise the
// KaTeX HTML by source. Shared with Editor.jsx — same formulas, same strings.
// ponytail: crude clear-at-cap instead of an LRU — a note holds tens of
// formulas, not thousands; swap in the LRU pattern if that stops being true.
const mathCache = new Map();
export const renderMath = (tex, display) => {
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

// A link to a note stays inside the app (the pane turns it into navigation);
// anything else opens in a new tab so a click never loses unsaved work.
//
// The note's href is the bare `name.md`, left relative on purpose. In the app
// it's never followed — DocView intercepts `a[data-note]` and preventDefaults —
// but on a published page at /r/:owner/:ns/:note.md there is no click handler,
// and a relative href resolves against that path to exactly the right sibling
// note. Same markup, working links in both places, no second renderer.
const anchor = (href, inner) => {
    const url = safeUrl(href);
    return /^[^:]*\.md$/.test(url)
        ? `<a class="wikilink" href="${esc(url)}" data-note="${esc(url)}">${inner}</a>`
        : `<a href="${esc(url)}" target="_blank" rel="noreferrer noopener">${inner}</a>`;
};

// One pass over a line for every inline construct. Ordered: math first (a stray
// * or _ inside a formula is LaTeX, not emphasis), then code (its contents are
// literal), then the bracket forms, then emphasis. The math patterns are the
// same ones mdmath.js documents.
const INLINE = new RegExp([
    String.raw`(?<dmath>\$\$[^$\n]+?\$\$)`,
    String.raw`(?<imath>(?<![$\w])\$(?!\s)[^$\n]+?(?<!\s)\$(?![$\w]))`,
    String.raw`(?<code>\`[^\`]+?\`)`,
    String.raw`!\[(?<alt>[^\]]*)\]\((?<src>[^)\s]+?)\)`,
    String.raw`\[\[(?<wiki>[^\]|#]+?)(?:[|#][^\]]*)?\]\]`,
    String.raw`\[(?<ltext>[^\]]+?)\]\((?<href>[^)\s]+?)\)`,
    String.raw`\*\*(?<bold>.+?)\*\*`,
    String.raw`~~(?<strike>.+?)~~`,
    String.raw`(?<![*\w])\*(?!\*)(?<em>.+?)(?<!\*)\*(?![*\w])`,
].join("|"), "g");

// matchAll rather than exec: emphasis recurses into its own contents, and a
// shared /g regex would have the inner call move the outer call's cursor.
function inline(text) {
    let out = "";
    let last = 0;
    for (const m of text.matchAll(INLINE)) {
        const g = m.groups;
        out += esc(text.slice(last, m.index));
        if (g.dmath) out += renderMath(g.dmath.slice(2, -2), true);
        else if (g.imath) out += renderMath(g.imath.slice(1, -1), false);
        else if (g.code) out += `<code>${esc(g.code.slice(1, -1))}</code>`;
        else if (g.src !== undefined) out += `<img src="${esc(safeUrl(g.src))}" alt="${esc(g.alt)}">`;
        else if (g.wiki) out += anchor(`${g.wiki.trim()}.md`, esc(g.wiki.trim()));
        else if (g.href !== undefined) out += anchor(g.href, inline(g.ltext));
        else if (g.bold) out += `<strong>${inline(g.bold)}</strong>`;
        else if (g.strike) out += `<s>${inline(g.strike)}</s>`;
        else if (g.em) out += `<em>${inline(g.em)}</em>`;
        last = m.index + m[0].length;
    }
    return out + esc(text.slice(last));
}

const isRule = (line) => /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
// Lines that start a block of their own, so a paragraph must stop before them.
const BLOCK = /^(#{1,6}\s|>|\s*(?:[-*+]|\d+\.)\s)/;

/**
 * Render a whole note. Blocks are line-based, matching the editor's
 * one-paragraph-per-line value: consecutive plain lines become one paragraph
 * with the line breaks kept, so what you read is laid out like what you typed.
 */
export function renderMarkdown(md) {
    const lines = (md ?? "").split("\n");
    const fence = fenceLines(lines);
    const out = [];
    const lists = []; // open <ul>/<ol>, innermost last
    const closeLists = (toIndent = -1) => {
        while (lists.length && lists[lists.length - 1].indent > toIndent) out.push(`</li></${lists.pop().tag}>`);
    };

    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Fenced code: verbatim through to the closer, no markdown inside.
        if (fence[i] === "open") {
            const lang = line.slice(3).trim();
            const body = [];
            i++;
            while (i < lines.length && fence[i] === "body") body.push(lines[i++]);
            if (fence[i] === "close") i++;
            closeLists();
            out.push(`<pre${lang ? ` data-lang="${esc(lang)}"` : ""}><code>${esc(body.join("\n"))}</code></pre>`);
            continue;
        }

        if (!line.trim()) { closeLists(); i++; continue; } // blank line ends any block

        if (isRule(line)) { closeLists(); out.push("<hr>"); i++; continue; }

        // List item. Leading spaces nest, so `lists` is a stack keyed by indent.
        const li = line.match(/^(\s*)(?:[-*+]|(\d+)\.)\s+(.*)$/);
        if (li) {
            const indent = li[1].length;
            const tag = li[2] ? "ol" : "ul";
            closeLists(indent);
            const top = lists[lists.length - 1];
            if (top && top.indent === indent && top.tag !== tag) { out.push(`</li></${lists.pop().tag}>`); }
            if (lists.length && lists[lists.length - 1].indent === indent) out.push("</li><li>");
            else { out.push(`<${tag}><li>`); lists.push({ tag, indent }); }
            out.push(inline(li[3]));
            i++;
            continue;
        }

        closeLists();

        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }

        if (line.startsWith(">")) {
            const body = [];
            while (i < lines.length && lines[i].startsWith(">") && !fence[i]) body.push(lines[i++].replace(/^>\s?/, ""));
            out.push(`<blockquote>${body.map(inline).join("<br>")}</blockquote>`);
            continue;
        }

        const para = [];
        while (i < lines.length && lines[i].trim() && !fence[i] && !BLOCK.test(lines[i]) && !isRule(lines[i])) {
            para.push(lines[i++]);
        }
        out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    closeLists();
    return out.join("");
}

// KaTeX's stylesheet pulls in its own font files, so inlining it would mean
// base64-ing a dozen woff2s into every export. A note with no math (the common
// case) stays genuinely self-contained; one with math links the stylesheet and
// needs the network the first time it's opened.
const KATEX_CSS = "https://cdn.jsdelivr.net/npm/katex@0.18.1/dist/katex.min.css";

// Deliberately light and plain: an export is read outside the app, printed, or
// mailed on, and it should look like a document rather than like this editor.
const EXPORT_CSS = `
:root { color-scheme: light; }
body { margin: 0; background: #fff; color: #1a1d21; }
.doc-render {
    max-width: 46rem;
    margin: 0 auto;
    padding: 3rem 1.5rem 6rem;
    font: 17px/1.7 -apple-system, system-ui, "Segoe UI", sans-serif;
}
.doc-render h1, .doc-render h2, .doc-render h3 { line-height: 1.25; margin: 1.6em 0 0.5em; }
.doc-render h1 { font-size: 2em; }
.doc-render h2 { font-size: 1.5em; }
.doc-render h3 { font-size: 1.22em; }
.doc-render h4, .doc-render h5, .doc-render h6 { font-size: 1.05em; margin: 1.4em 0 0.4em; }
.doc-render > :first-child { margin-top: 0; }
.doc-render p { margin: 0 0 1em; }
.doc-render a { color: #0b62d0; }
.doc-render blockquote {
    margin: 1em 0; padding: 0.1em 0 0.1em 1em;
    border-left: 3px solid #d4d9e0; color: #4b5563; font-style: italic;
}
.doc-render ul, .doc-render ol { margin: 0 0 1em; padding-left: 1.6em; }
.doc-render li { margin: 0.2em 0; }
.doc-render code { font: 0.88em ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1f3f5; border-radius: 4px; padding: 0.1em 0.34em; }
.doc-render pre { background: #f6f8fa; border: 1px solid #e5e9ef; border-radius: 8px; padding: 0.9em 1em; overflow-x: auto; }
.doc-render pre code { background: none; padding: 0; font-size: 0.85em; }
.doc-render hr { border: 0; border-top: 1px solid #e0e4ea; margin: 2em 0; }
.doc-render img { max-width: 100%; border-radius: 6px; }
@media print {
    .doc-render { max-width: none; padding: 0; font-size: 12pt; }
    .doc-render a { color: inherit; text-decoration: underline; }
    .doc-render pre, .doc-render blockquote { break-inside: avoid; }
}`;

/**
 * A standalone document: what Export downloads, what Print renders, and — with
 * `extra` — what a published note serves to the open web.
 */
export function exportHtml(md, title, extra = "") {
    const body = renderMarkdown(md);
    return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
${body.includes("katex") ? `<link rel="stylesheet" href="${KATEX_CSS}">\n` : ""}<style>${EXPORT_CSS}</style>
</head><body><article class="doc-render">${body}${extra}</article></body></html>`;
}

const FOOT_CSS = "margin-top:3em;padding-top:1em;border-top:1px solid #e0e4ea;font-size:0.82em;color:#6b7280";

/**
 * A published note as a stranger (or an agent) sees it: no app, no login, no
 * JavaScript. The provenance block is the point — a reader can see who signed
 * this, when, and the exact content hash they're reading, which is the one
 * thing a link to a Google Doc can never tell them.
 */
export function publicPage(md, { title, owner, ns, note, cid, updatedAt }) {
    const when = updatedAt ? new Date(updatedAt).toISOString().slice(0, 10) : null;
    const subscribe = `/?owner=${encodeURIComponent(owner)}&ns=${encodeURIComponent(ns)}&note=${encodeURIComponent(note)}`;
    const foot = `<footer style="${FOOT_CSS}">` +
        `<div>Published by <code>${esc(owner)}</code>${when ? ` · ${esc(when)}` : ""} · <b>${esc(ns)}</b></div>` +
        `<div>Content hash <code>${esc(cid ?? "—")}</code> — this page is addressed by its bytes, so any edit is a different hash.</div>` +
        `<div style="margin-top:0.6em"><a href="${esc(subscribe)}">Subscribe to this wiki →</a></div>` +
        `</footer>`;
    return exportHtml(md, title, foot);
}

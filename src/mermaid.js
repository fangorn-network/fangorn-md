// ── mermaid in the read pane ──────────────────────────────────────
//
// render.js is shared with the server (it builds published pages), so it can't
// import a browser-only drawing library. It leaves `<pre class="mermaid">` with
// the diagram's source in it; this turns those into SVG, in the browser only.
//
// The read pane re-renders on every keystroke, so drawing on each pass would
// make a diagram flash while you type a sentence under it. Instead every SVG is
// cached by its source and substituted straight into the HTML string: a
// keystroke that doesn't touch the diagram is a cache hit and the SVG is simply
// still there.

import { MERMAID_URL } from "./render.js";

const MERMAID_RE = /<pre class="mermaid">([\s\S]*?)<\/pre>/g;
const UNESC = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"' };
const unesc = (s) => s.replace(/&(amp|lt|gt|quot);/g, (c) => UNESC[c]);

const svgs = new Map(); // diagram source → rendered SVG (or null while drawing)
let lib; // the promise, so the ~1MB library is fetched once and only if used

/** Swap in every diagram already drawn; the rest stay as their source. */
export const withMermaid = (html) =>
    html.replace(MERMAID_RE, (whole, src) => svgs.get(unesc(src)) || whole);

/**
 * Draw any diagram in `html` that isn't cached yet, calling `onDone` once they
 * have all settled so the caller can re-render through withMermaid(). Returns
 * true if anything was actually queued.
 */
export function drawMermaid(html, onDone) {
    const pending = [...html.matchAll(MERMAID_RE)]
        .map((m) => unesc(m[1]))
        .filter((src) => !svgs.has(src));
    if (!pending.length) return false;

    for (const src of pending) svgs.set(src, null); // claim it, so a re-render doesn't redraw
    // ponytail: unbounded cache — a note holds a handful of diagrams and it dies
    // with the tab. Clear-at-cap like render.js's mathCache if that changes.
    lib ??= import(/* @vite-ignore */ MERMAID_URL).then(({ default: m }) => {
        m.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark" });
        return m;
    });

    lib.then(async (m) => {
        for (const src of pending) {
            // A diagram is half-typed most of the time it's being written, and
            // mermaid throws on that — leave the source showing until it parses.
            try {
                const { svg } = await m.render(`mmd-${Math.random().toString(36).slice(2)}`, src);
                svgs.set(src, svg);
            } catch {
                svgs.delete(src);
            }
        }
        onDone();
    }).catch(() => { for (const src of pending) svgs.delete(src); });
    return true;
}

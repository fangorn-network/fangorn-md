// The published page is the one render nobody proofreads before a stranger
// sees it — no app around it to catch a broken link and no author watching.
// node --test src/render.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown, publicPage } from "./render.js";

const meta = {
    title: "Karaage", owner: "0xabc", ns: "recipes", note: "karaage.md",
    cid: "bafyTEST", updatedAt: Date.UTC(2026, 6, 30),
};

test("note links stay relative, so they resolve on a published page", () => {
    const html = renderMarkdown("see [[chicken]] and [text](other.md)");
    // Relative — NOT "#" and NOT rooted at "/", or a sibling note 404s once the
    // page is served from /r/:owner/:ns/:note.md.
    assert.match(html, /href="chicken\.md"/);
    assert.match(html, /href="other\.md"/);
    // The app still finds them: DocView navigates on data-note.
    assert.match(html, /data-note="chicken\.md"/);
});

test("external links keep their scheme and open out", () => {
    const html = renderMarkdown("[site](https://example.com)");
    assert.match(html, /href="https:\/\/example\.com" target="_blank"/);
});

test("provenance is on the page", () => {
    const html = publicPage("# Karaage\n\nfry it twice", meta);
    assert.match(html, /0xabc/);
    assert.match(html, /bafyTEST/);
    assert.match(html, /2026-07-30/);
    assert.match(html, /owner=0xabc&amp;ns=recipes/); // subscribe link back into the app
    assert.match(html, /<h1>Karaage<\/h1>/);
});

test("pipe tables: alignment, inline markdown, ragged rows", () => {
    const html = renderMarkdown([
        "| a | b | c |",
        "|:--|:-:|--:|",
        "| 1 | **two** | 3 |",
        "| only one",
    ].join("\n"));
    assert.match(html, /<thead><tr><th style="text-align:left">a<\/th>/);
    assert.match(html, /<th style="text-align:center">b<\/th><th style="text-align:right">c<\/th>/);
    assert.match(html, /<td style="text-align:center"><strong>two<\/strong><\/td>/);
    // A short row is padded to the header's width instead of dropping the table.
    assert.match(html, /<tr><td style="text-align:left">only one<\/td><td[^>]*><\/td><td[^>]*><\/td><\/tr>/);
});

test("a paragraph over a rule is not a one-row table", () => {
    // Same shape as a table (a line with a pipe, then dashes) but the column
    // counts disagree, so it stays prose plus an <hr>.
    const html = renderMarkdown("cats | dogs\n---");
    assert.match(html, /<p>cats \| dogs<\/p><hr>/);
    assert.ok(!html.includes("<table>"), "no table");
});

test("mermaid fences stay source in the HTML and bring their own script", () => {
    const html = renderMarkdown("```mermaid\ngraph TD; A-->B;\n```");
    assert.equal(html, `<pre class="mermaid">graph TD; A--&gt;B;</pre>`);
    // Only a note with a diagram pays for the library.
    assert.match(publicPage("```mermaid\ngraph TD; A-->B;\n```", meta), /mermaid\.esm\.min\.mjs/);
    assert.ok(!publicPage("plain note", meta).includes("<script"), "no diagram, no script");
});

test("task list items render as checkboxes", () => {
    const html = renderMarkdown("- [ ] todo\n- [x] done\n- plain");
    assert.match(html, /<input type="checkbox" disabled> todo/);
    assert.match(html, /<input type="checkbox" disabled checked> done/);
    assert.match(html, /<li>plain<\/li>/);
});

test("a hostile note can't write markup into the page it's served from", () => {
    const html = publicPage("<script>alert(1)</script>\n\n[x](javascript:alert(1))", {
        ...meta, title: "</title><script>alert(1)</script>",
    });
    assert.ok(!html.includes("<script>"), "no script tag survives, in body or title");
    assert.ok(!html.includes("javascript:"), "javascript: URLs are defused");
});

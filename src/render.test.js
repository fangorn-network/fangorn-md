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

test("a hostile note can't write markup into the page it's served from", () => {
    const html = publicPage("<script>alert(1)</script>\n\n[x](javascript:alert(1))", {
        ...meta, title: "</title><script>alert(1)</script>",
    });
    assert.ok(!html.includes("<script>"), "no script tag survives, in body or title");
    assert.ok(!html.includes("javascript:"), "javascript: URLs are defused");
});

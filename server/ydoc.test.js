// node server/ydoc.test.js
//
// The property that has to hold for multiplayer: two people editing the same
// note at the same time both keep their work, and what lands back on disk is
// still plain markdown the publisher can read.

import assert from "node:assert/strict";
import * as Y from "yjs";
import { docMarkdown, seedFromMarkdown, isReadFrame } from "./ydoc.js";

const room = (md) => {
    const doc = new Y.Doc();
    const xml = doc.get("content", Y.XmlText);
    if (md !== undefined) seedFromMarkdown(xml, md);
    return { doc, xml };
};
// Each paragraph is a YXmlText embedded in the root — that's where text goes.
const line = (xml, i) => xml.toDelta()[i].insert;
const sync = (from, to) => Y.applyUpdate(to.doc, Y.encodeStateAsUpdate(from.doc));

// ── round trip: what we seed is what we get back, byte for byte ──
for (const md of [
    "",
    "# Title\n\nA paragraph.\n",
    "one\ntwo\nthree",
    "```js\nconst x = 1;\n```\n\ntrailing\n\n",
    "$$\n\\int_0^1 x\\,dx\n$$",
]) {
    assert.equal(docMarkdown(room(md).xml), md, `round trip failed for ${JSON.stringify(md)}`);
}

// ── concurrent edits on different lines both survive ──
{
    const file = "# Notes\n\nalpha\nbeta\n";
    const server = room(file);
    const alice = room();
    const bob = room();
    sync(server, alice); // clients receive the seeded room, they don't re-seed
    sync(server, bob);

    line(alice.xml, 2).insert(5, " (from Alice)");
    line(bob.xml, 3).insert(4, " (from Bob)");

    sync(alice, bob);
    sync(bob, alice);
    sync(alice, server);

    const merged = "# Notes\n\nalpha (from Alice)\nbeta (from Bob)\n";
    assert.equal(docMarkdown(alice.xml), merged, "Alice lost an edit");
    assert.equal(docMarkdown(bob.xml), merged, "Bob lost an edit");
    assert.equal(docMarkdown(server.xml), merged, "the file would not have both edits");
}

// ── concurrent edits on the SAME line interleave rather than clobber ──
{
    const server = room("hello");
    const alice = room();
    const bob = room();
    sync(server, alice);
    sync(server, bob);

    line(alice.xml, 0).insert(5, " Alice");
    line(bob.xml, 0).insert(5, " Bob");
    sync(alice, bob);
    sync(bob, alice);

    const merged = docMarkdown(alice.xml);
    assert.equal(merged, docMarkdown(bob.xml), "peers disagree — not convergent");
    assert.ok(merged.includes("Alice") && merged.includes("Bob"), `an edit was dropped: ${merged}`);
}

// ── read-only peers: presence and "send me the state" pass, writes don't ──
assert.equal(isReadFrame([1, 0]), true, "awareness must reach the room");
assert.equal(isReadFrame([0, 0]), true, "syncStep1 must reach the room");
assert.equal(isReadFrame([0, 1]), false, "syncStep2 would write to the owner's file");
assert.equal(isReadFrame([0, 2]), false, "an update would write to the owner's file");

console.log("ydoc: ok");

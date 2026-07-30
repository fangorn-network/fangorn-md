// node server/ydoc.test.js
//
// The property that has to hold for multiplayer: two people editing the same
// note at the same time both keep their work, and what lands back on disk is
// still plain markdown the publisher can read.

import assert from "node:assert/strict";
import * as Y from "yjs";
import {
    docMarkdown, seedFromMarkdown, replaceMarkdown, isReadFrame, encodeRoomState, applyRoomState,
} from "./ydoc.js";

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

// ── a room outlives being evicted, and a returning peer doesn't double it ──
//
// Rooms are dropped when the last peer leaves and die with the process, but a
// browser that loses its socket keeps its copy and re-sends it on reconnect.
// This is the bug that made a note come back with its whole body twice.
{
    const file = "example\nabc";

    // A peer joins a fresh room and just reads it — never types.
    const first = room(file);
    const saved = { md: docMarkdown(first.xml), update: encodeRoomState(first.doc) };
    const peer = room();
    sync(first, peer);

    // Everyone leaves: the room is written to disk and evicted. Now the peer
    // comes back and the room is rebuilt from what was persisted.
    const resumed = { doc: new Y.Doc() };
    resumed.xml = resumed.doc.get("content", Y.XmlText);
    assert.equal(saved.md, file, "the snapshot has to describe the file it came from");
    applyRoomState(resumed.doc, saved.update);

    sync(peer, resumed); // the reconnecting browser pushes its copy back up
    sync(resumed, peer);
    assert.equal(docMarkdown(resumed.xml), file, "the note came back duplicated");
    assert.equal(docMarkdown(peer.xml), file, "the peer is showing the note twice");

    // …and the control: re-seeding from the same markdown is what used to
    // happen, and is exactly why the state has to be persisted.
    const reseeded = room(file);
    sync(peer, reseeded);
    assert.equal(docMarkdown(reseeded.xml), `${file}\n${file}`,
        "re-seeding is supposed to duplicate — if it stopped, this test is no longer testing the fix");
}

// ── read-only peers: presence and "send me the state" pass, writes don't ──
assert.equal(isReadFrame([1, 0]), true, "awareness must reach the room");
assert.equal(isReadFrame([0, 0]), true, "syncStep1 must reach the room");
assert.equal(isReadFrame([0, 1]), false, "syncStep2 would write to the owner's file");
assert.equal(isReadFrame([0, 2]), false, "an update would write to the owner's file");

// ── an agent writing into a note somebody has open ──
// The API can't writeFileSync under a live room (the room flushes back over
// it), so the write goes through the doc — and every peer has to see it.
{
    const owner = room("# Notes\n\ndraft");
    const peer = room();
    sync(owner, peer);

    replaceMarkdown(owner.doc, owner.xml, "# Notes\n\nrewritten by an agent\n");
    sync(owner, peer);
    assert.equal(docMarkdown(peer.xml), "# Notes\n\nrewritten by an agent\n",
        "the agent's write never reached the person with the note open");
    assert.equal(docMarkdown(owner.xml), docMarkdown(peer.xml), "the room disagrees with itself");
}

console.log("ydoc: ok");

// Markdown ⇄ Yjs for the live co-editing rooms (see server/index.js).
//
// This mirrors src/Editor.jsx's toSlate/fromSlate exactly — one paragraph per
// line, markdown stays the source of truth — because the two have to agree: the
// server seeds a room from a .md file and writes the merged result back to the
// same file, and the browser has to see the text it would have typed. A drift
// between them corrupts notes quietly, which is why it lives here with a test.

import { yTextToSlateElement, slateNodesToInsertDelta } from "@slate-yjs/core";
import * as Y from "yjs";

export const toSlateNodes = (md) =>
    (md ?? "").split("\n").map((line) => ({ type: "paragraph", children: [{ text: line }] }));

const nodeText = (n) => n.text ?? (n.children ?? []).map(nodeText).join("");

/** The room's current text, as the markdown that belongs in the working tree. */
export const docMarkdown = (xml) => yTextToSlateElement(xml).children.map(nodeText).join("\n");

/** Fill an empty room from a file. Only ever called when `xml.length === 0`. */
export const seedFromMarkdown = (xml, md) =>
    xml.applyDelta(slateNodesToInsertDelta(toSlateNodes(md)));

// ── surviving an eviction ─────────────────────────────────────────
// A room only lives as long as someone is in it, but a browser that loses its
// socket keeps its copy of the document and re-sends it when it reconnects.
// That is fine as long as both sides are talking about the SAME document:
// merging is by CRDT identity, not by text.
//
// Re-seeding a fresh room from the markdown mints brand new identities for the
// very same words, so the returning peer's paragraph and the new room's
// paragraph are, as far as Yjs can tell, two unrelated paragraphs that both
// belong in the note — and the note comes back with its whole body twice.
//
// So the room's state, not just its text, is what gets persisted: snapshot it
// when it's created and when it's flushed, restore it on the next visit, and
// the identities hold across the gap. Markdown is still the seed of record —
// the caller only trusts a snapshot whose text still matches the file.
export const encodeRoomState = (doc) => Buffer.from(Y.encodeStateAsUpdate(doc)).toString("base64");
export const applyRoomState = (doc, b64) => Y.applyUpdate(doc, Buffer.from(b64, "base64"));

// y-sync frames are self-describing: byte 0 is the message type (0 sync,
// 1 awareness) and, for sync, byte 1 is the step (0 ask for state, 1 send
// state, 2 update). A read-only peer may ask for state and publish awareness;
// the two frames that mutate the document are dropped.
export const isReadFrame = (b) => b[0] !== 0 || b[1] === 0;

// Markdown ⇄ Yjs for the live co-editing rooms (see server/index.js).
//
// This mirrors src/Editor.jsx's toSlate/fromSlate exactly — one paragraph per
// line, markdown stays the source of truth — because the two have to agree: the
// server seeds a room from a .md file and writes the merged result back to the
// same file, and the browser has to see the text it would have typed. A drift
// between them corrupts notes quietly, which is why it lives here with a test.

import { yTextToSlateElement, slateNodesToInsertDelta } from "@slate-yjs/core";

export const toSlateNodes = (md) =>
    (md ?? "").split("\n").map((line) => ({ type: "paragraph", children: [{ text: line }] }));

const nodeText = (n) => n.text ?? (n.children ?? []).map(nodeText).join("");

/** The room's current text, as the markdown that belongs in the working tree. */
export const docMarkdown = (xml) => yTextToSlateElement(xml).children.map(nodeText).join("\n");

/** Fill an empty room from a file. Only ever called when `xml.length === 0`. */
export const seedFromMarkdown = (xml, md) =>
    xml.applyDelta(slateNodesToInsertDelta(toSlateNodes(md)));

// y-sync frames are self-describing: byte 0 is the message type (0 sync,
// 1 awareness) and, for sync, byte 1 is the step (0 ask for state, 1 send
// state, 2 update). A read-only peer may ask for state and publish awareness;
// the two frames that mutate the document are dropped.
export const isReadFrame = (b) => b[0] !== 0 || b[1] === 0;

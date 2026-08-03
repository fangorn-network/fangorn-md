// The Files view's selection is the one place a stray click deletes notes in
// bulk, so the two pure functions under it get a check.
// node --test src/structure.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { flattenTree, moveInTree, pathsBetween } from "./structure.js";

const node = (path, children = []) => ({ path, children });
const tree = [
    node("index.md", [node("auth.md", [node("tokens.md")]), node("api.md")]),
    node("scratch.md"),
];

test("flattenTree yields display order with depth", () => {
    assert.deepEqual(flattenTree(tree), [
        { path: "index.md", depth: 0 },
        { path: "auth.md", depth: 1 },
        { path: "tokens.md", depth: 2 },
        { path: "api.md", depth: 1 },
        { path: "scratch.md", depth: 0 },
    ]);
});

test("pathsBetween spans rows in either direction, inclusive", () => {
    const rows = flattenTree(tree);
    assert.deepEqual(pathsBetween(rows, "auth.md", "api.md"), ["auth.md", "tokens.md", "api.md"]);
    assert.deepEqual(pathsBetween(rows, "api.md", "auth.md"), ["auth.md", "tokens.md", "api.md"]);
    assert.deepEqual(pathsBetween(rows, "scratch.md", "scratch.md"), ["scratch.md"]);
});

// The server nests an agent's note with this same call (placeUnder in
// server/index.js), and turns the no-op below into a 409 — so the guard is
// what stops `parent` from silently detaching a subtree.
test("moveInTree inside: nesting under a descendant is refused", () => {
    assert.equal(moveInTree(tree, "index.md", "tokens.md", "inside"), tree);
    assert.equal(moveInTree(tree, "index.md", "index.md", "inside"), tree);
});

test("moveInTree inside: a note moves with its subtree", () => {
    const next = moveInTree(tree, "auth.md", "scratch.md", "inside");
    assert.deepEqual(flattenTree(next), [
        { path: "index.md", depth: 0 },
        { path: "api.md", depth: 1 },
        { path: "scratch.md", depth: 0 },
        { path: "auth.md", depth: 1 },
        { path: "tokens.md", depth: 2 },
    ]);
});

test("pathsBetween ignores an anchor the filter hid", () => {
    const rows = flattenTree(tree).filter((r) => r.path !== "auth.md");
    assert.deepEqual(pathsBetween(rows, "auth.md", "api.md"), ["api.md"]);
});

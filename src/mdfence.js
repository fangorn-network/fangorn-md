// Classifying ``` fences across lines. Split out of Editor.jsx (same reason as
// mdmath.js) so the state machine is runnable under Node.

/**
 * Label each line of a document: "open" / "body" / "close" for fenced code,
 * undefined for ordinary markdown. An unterminated fence runs to the end.
 */
export function fenceLines(lines) {
    let open = false;
    return lines.map((line) => {
        if (line.startsWith("```")) { open = !open; return open ? "open" : "close"; }
        return open ? "body" : undefined;
    });
}

// node src/mdfence.js — self-check the state machine.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
    const assert = (await import("node:assert")).default;

    assert.deepEqual(fenceLines(["a", "```js", "code", "```", "b"]),
        [undefined, "open", "body", "close", undefined], "one block");
    assert.deepEqual(fenceLines(["```", "x", "```", "```", "y", "```"]),
        ["open", "body", "close", "open", "body", "close"], "two blocks");
    // Unterminated: everything after the fence is still code, not markdown.
    assert.deepEqual(fenceLines(["```", "# not a heading"]), ["open", "body"], "unterminated fence");
    assert.deepEqual(fenceLines(["`inline`", "text"]), [undefined, undefined], "inline code is not a fence");

    console.log("mdfence.js self-check ok");
}

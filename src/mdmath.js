// Finding LaTeX spans in a line of markdown. Split out of Editor.jsx purely so
// the regexes are runnable under Node — they're the fiddly part (telling `$x$`
// from a dollar amount), and the editor can't be imported outside a browser.

/**
 * Locate `$$display$$` and `$inline$` math in one line of markdown.
 * Returns [{ start, end, tex, display }] with offsets into `text`.
 */
export function findMath(text) {
    const out = [];
    const scan = (re, display) => {
        let m;
        while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length, tex: m[1], display });
    };
    scan(/\$\$([^$\n]+?)\$\$/g, true);
    // Inline needs guards or prose eats it: no `$` or word char on either
    // outside edge, and no whitespace just inside the delimiters — which is what
    // keeps "$5 and $10" from reading as one formula.
    scan(/(?<![$\w])\$(?!\s)([^$\n]+?)(?<!\s)\$(?![$\w])/g, false);
    return out;
}

// node src/mdmath.js — self-check the delimiter rules.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
    const assert = (await import("node:assert")).default;
    const tex = (s) => findMath(s).map((m) => `${m.display ? "$$" : "$"}${m.tex}`);

    assert.deepEqual(tex("$$E = mc^2$$"), ["$$E = mc^2"], "display math");
    assert.deepEqual(tex("energy is $e^{i\\pi}$ here"), ["$e^{i\\pi}"], "inline math");
    assert.deepEqual(tex("$a$ and $b$"), ["$a", "$b"], "two inline spans");
    // A display span must not also be picked up by the inline pass.
    assert.equal(findMath("$$x$$").length, 1, "display counted once");
    // Prose that merely contains dollar signs stays prose.
    assert.deepEqual(tex("it cost $5 and $10 total"), [], "dollar amounts are not math");
    assert.deepEqual(tex("$ x $"), [], "space inside delimiters is not math");
    assert.deepEqual(tex("a$b$c"), [], "word chars outside delimiters are not math");
    // Offsets must line up, or decorations land on the wrong characters.
    const [m] = findMath("ab $x^2$ cd");
    assert.equal("ab $x^2$ cd".slice(m.start, m.end), "$x^2$", "span offsets");

    console.log("mdmath.js self-check ok");
}

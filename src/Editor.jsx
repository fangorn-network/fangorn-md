import { useMemo } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";

// Sanitize rendered HTML: a cloned wiki is someone else's content, and this app
// runs on your machine — never let a note inject script into it.
function render(markdown) {
    // `[[wikilink]]` → a normal markdown link so it renders (and navigates)
    // the same way `[wikilink](wikilink.md)` does.
    const withWikiLinks = markdown.replace(
        /\[\[([\w .-]+?)\]\]/g,
        (_, name) => `[${name}](${name}.md)`,
    );
    return DOMPurify.sanitize(marked.parse(withWikiLinks));
}

export default function Editor({ content, onChange, onNavigate }) {
    const html = useMemo(() => render(content), [content]);

    // Intercept clicks on relative .md links and open them in-app.
    const handleClick = (e) => {
        const link = e.target.closest("a");
        if (!link) return;
        const href = link.getAttribute("href") ?? "";
        if (href.endsWith(".md") && !href.includes("://")) {
            e.preventDefault();
            onNavigate(href);
        }
    };

    return (
        <div className="editor">
            <textarea
                className="editor-input"
                value={content}
                onChange={(e) => onChange(e.target.value)}
                spellCheck={false}
                placeholder="Write markdown…"
            />
            <div
                className="editor-preview"
                onClick={handleClick}
                dangerouslySetInnerHTML={{ __html: html }}
            />
        </div>
    );
}

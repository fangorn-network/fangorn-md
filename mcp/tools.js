// The tools an agent gets over MCP, defined once for both transports:
// stdio (mcp/fangornmd.js, for local dev) and HTTP (POST /mcp on the server
// itself, which is how anyone else uses it). Same tools, same behaviour, one
// place to change them.
//
// Everything here goes through the HTTP API in server/index.js — `call` is
// injected rather than imported so the hosted transport can use the caller's
// own bearer token. There is deliberately no logic in this file beyond shaping
// text for a model: a rule here is a rule an agent skips by calling the API
// directly, so rules live in the server.
//
// Note what is NOT here: publish. A fangornmd publish is settled by a
// transaction signed with the owner's wallet, in their browser. The server
// cannot sign it and neither can an agent. So an agent drafts freely and a
// human decides what becomes public — enforced by a key, not by a confirmation
// dialog an agent could be talked past.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const text = (s) => ({ content: [{ type: "text", text: s }] });

// Every note tool takes an optional `namespace`, because one token reaches all
// of its owner's wikis (server/index.js, agent tokens). Omitting it means "the
// one open in the browser", which is what a person means by "my wiki" when they
// only have one. A token pinned to a namespace rejects any other.
const nsArg = z.string().optional().describe(
    "which wiki — omit for the one currently open in the browser. list_wikis has the names.",
);
const nsQuery = (ns) => (ns ? `?ns=${encodeURIComponent(ns)}` : "");

/**
 * @param call  (method, path, body?) → parsed JSON, throwing on a non-2xx
 * @param base  origin used for public `/r/` reads and for citing a source URL
 */
export function createFangornmdServer({ call, base }) {
    const server = new McpServer({ name: "fangornmd", version: "1.0.0" });

    server.registerTool(
        "list_wikis",
        {
            title: "List wikis",
            description:
                "Every wiki this token can reach, and which one is currently open in the browser. " +
                "Call it when a request names a wiki you have not seen, or is ambiguous about which one it means.",
            inputSchema: {},
        },
        async () => {
            const { repos, active } = await call("GET", "/api/repos");
            if (!repos.length) return text("This token reaches no wikis yet.");
            const lines = repos.map((r) =>
                `- ${r.namespace}${r.namespace === active ? " (open in the browser)" : ""} — ` +
                `${r.visibility}, ${r.isOwner ? "yours" : r.writable ? "you can edit" : "read-only"}`);
            return text(`${repos.length} wiki/wikis:\n${lines.join("\n")}`);
        },
    );

    server.registerTool(
        "list_notes",
        {
            title: "List notes",
            description:
                "Every note in one wiki, with its title and the [[wikilinks]] it makes to other notes, " +
                "plus the sidebar hierarchy. Cheap — call it first to orient rather than reading notes at random.",
            inputSchema: { namespace: nsArg },
        },
        async ({ namespace }) => {
            const { notes, tree } = await call("GET", `/api/notes${nsQuery(namespace)}`);
            if (!notes.length) return text("This wiki has no notes yet.");
            const lines = notes.map((n) => `- ${n.path} — ${n.title}${n.links.length ? ` → ${n.links.join(", ")}` : ""}`);
            return text(`${notes.length} note(s):\n${lines.join("\n")}\n\nhierarchy:\n${JSON.stringify(tree, null, 2)}`);
        },
    );

    server.registerTool(
        "read_note",
        {
            title: "Read a note",
            description:
                "The current markdown of one note. If someone has the note open in the editor right now this " +
                "returns what is on their screen, including edits they have not finished — the live document, " +
                "not the last saved file.",
            inputSchema: { path: z.string().describe("note filename, e.g. index.md"), namespace: nsArg },
        },
        async ({ path, namespace }) => {
            const note = await call("GET", `/api/notes/${encodeURIComponent(path)}${nsQuery(namespace)}`);
            return text(note.live ? `(someone has this note open — live text)\n\n${note.content}` : note.content);
        },
    );

    server.registerTool(
        "write_note",
        {
            title: "Write a note",
            description:
                "Replace a note's entire contents (creates it if new). If someone has the note open, the text " +
                "appears in their editor as you write it — so read_note immediately before, and send back the " +
                "whole document, not a fragment. This is a draft: it is not published until a human signs it.",
            inputSchema: {
                path: z.string().describe("note filename, e.g. index.md — created if it does not exist"),
                content: z.string().describe("the complete new markdown for the note"),
                namespace: nsArg,
            },
        },
        async ({ path, content, namespace }) => {
            const r = await call("PUT", `/api/notes/${encodeURIComponent(path)}${nsQuery(namespace)}`, { content });
            return text(r.live ? `Wrote ${path} — it is open in someone's editor, so they just saw it change.` : `Wrote ${path}.`);
        },
    );

    server.registerTool(
        "repo_info",
        {
            title: "Wiki info",
            description: "One wiki in detail: owner address, namespace, visibility, collaborators, and whether it has ever been published.",
            inputSchema: { namespace: nsArg },
        },
        async ({ namespace }) => {
            const r = await call("GET", `/api/repo${nsQuery(namespace)}`);
            if (!r) return text("No wiki is open in the browser — name one, or use list_wikis.");
            return text(
                `namespace: ${r.namespace}\nowner: ${r.owner}\nvisibility: ${r.visibility}\n` +
                `published: ${r.head ? `yes (head ${r.head})` : "never"}\n` +
                `collaborators: ${r.collaborators?.length ? r.collaborators.join(", ") : "none"}`,
            );
        },
    );

    server.registerTool(
        "read_published",
        {
            title: "Read a published note",
            description:
                "Read any PUBLIC published note — from this wiki or anyone else's on this server — with no " +
                "credentials. Returns the markdown and the content hash (CID) it was served under. Quote that " +
                "CID when you cite the note: it identifies the exact bytes you read, so someone else can " +
                "verify the claim independently of this server.",
            inputSchema: {
                owner: z.string().describe("the publisher's wallet address, 0x…"),
                namespace: z.string().describe("the wiki name"),
                note: z.string().default("index.md").describe("note filename"),
            },
        },
        async ({ owner, namespace, note }) => {
            const url = `${base}/r/${owner}/${encodeURIComponent(namespace)}/${encodeURIComponent(note)}`;
            const res = await fetch(url, { headers: { Accept: "text/markdown" } });
            if (!res.ok) throw new Error(`${res.status} — not published, or the namespace is private`);
            const cid = (res.headers.get("etag") ?? "").replace(/"/g, "");
            return text(`${await res.text()}\n\n---\nsource: ${url}\ncid: ${cid || "unknown"}\npublisher: ${owner}`);
        },
    );

    return server;
}

/** An API caller bound to one origin and one agent token. */
export const httpCall = (base, token) => async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
    });
    const raw = await res.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = { error: raw }; }
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    return data;
};

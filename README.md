# fangornmd

A self-hosted, collaborative markdown wiki whose storage layer is the
[Fangorn network](https://github.com/fangorn-network/fangorn). Notes are plain
markdown files on disk; publishing snapshots them into a versioned,
content-addressed graph settled on-chain (Arbitrum Sepolia), with blocks pinned
to IPFS. Anyone can then follow your wiki by address + namespace, read it, and
live-sync as you push updates.

Three properties are the whole point, and they're why this isn't a worse Google
Drive:

- **Self-custodial.** The server holds no user keys. Every on-chain settlement
  is signed by the user's own wallet in their browser. Private namespaces are
  encrypted client-side — the server pins ciphertext it cannot read.
- **Published, not shared.** A publish is a signed, content-addressed snapshot
  that exists independently of this server. A reader can see who signed a page
  and the exact hash of what they're reading, which is something a link to a
  hosted doc can never tell them.
- **Agents can write here, and cannot publish.** An agent gets a scoped token
  and full run of the working tree — it even types into notes you have open,
  live. It can never make anything public, because publishing is a transaction
  signed by a wallet in your browser. The human in the loop is a key, not a
  confirmation dialog (§11).

This README doubles as the **dev guide**: it builds the app up from a single
graph-building function, and explains each design decision in terms of what the
Fangorn SDK actually does. Deployment lives in [DEPLOY.md](DEPLOY.md).

```
┌──────────────────────── one Node process ─────────────────────────┐
│                                                                    │
│  docs/<owner>/<ns>/*.md      server/index.js         dist/ (SPA)   │
│  (working trees)      ◄──►   relay + API      ──►    React editor  │
│                                │      ▲  ▲                         │
│                                │      │  └── /yjs/*  live co-edit  │
│                       @fangorn-network/sdk (keyless service key)   │
└────────────────────────────────┼──────┼────────────────────────────┘
                       prepare/read   subscribe (StateCommitted)
                                 ▼      │
                    Arbitrum Sepolia (DataRegistry)
                                 │            ▲
                     IPFS / Pinata (blocks)   └── settlement tx, signed
                                                  by the USER's wallet
```

| Piece | File(s) | Job |
|---|---|---|
| Working trees | `docs/<owner>/<ns>/*.md` | The notes. Plain files — edit them with anything. |
| Relay + API | [server/index.js](server/index.js), [server/graph.js](server/graph.js), [server/ydoc.js](server/ydoc.js) | Files, publish prep, pull, live rooms, change feed, public read. |
| Editor | [src/](src/) | Slate-based markdown editor talking to the server over HTTP, SSE and WebSocket. |
| Agent bridge | [mcp/tools.js](mcp/tools.js) | Five MCP tools, served at `POST /mcp` and over stdio. |

The browser never touches the SDK directly — it needs Node (block cache, LMDB,
gateway access) — so all Fangorn work happens server-side and the frontend
stays a replaceable client. The one thing the server deliberately *cannot* do
is sign for a user.

---

## Quickstart

**Run it.** Needs Node ≥ 20.19, [pnpm](https://pnpm.io), a
[Privy](https://dashboard.privy.io) app id, a throwaway EVM key (no funds), and
a [Pinata](https://pinata.cloud) gateway domain. Details and why in §2.

```sh
pnpm install
cp .env.example .env      # ETH_PRIVATE_KEY, PINATA_GATEWAY, VITE_PRIVY_APP_ID
pnpm dev                  # API server (:8787) + Vite (:5173)
```

Open http://localhost:5173 → log in → **+ New** a namespace → write. Notes are
plain files at `docs/<your address>/<namespace>/*.md`; nothing is on-chain yet.

**Publish.** Hit **Publish** and sign in your wallet. Now `🔗 Share` gives a
link anyone can open — no account — and the page carries your signing address
and the content hash of exactly what they're reading.

**Point an agent at it.** Click **🤖** in the header, mint a token — the panel
prints the exact command with the token already in it. In Claude Code that is:

```sh
claude mcp add --transport http fangornmd http://drive.fangorn.network/mcp --header "Authorization: Bearer fmd_0x…"
```

Or the equivalent JSON for Claude Desktop / any other MCP client:

```json
{ "mcpServers": { "fangornmd": {
    "type": "http", "url": "http://localhost:8787/mcp",
    "headers": { "Authorization": "Bearer fmd_0x…" } } } }
```

The MCP server **is** the fangornmd server — nothing separate to install, host,
or keep in version step. Swap in your own origin once it's deployed and it works
from anywhere, including clients that can't run Node. (A stdio server at
[mcp/fangornmd.js](mcp/fangornmd.js) remains for hacking on a checkout; §11.)

Ask it to *"read my wiki and write a summary note"*. Six tools: `list_wikis`,
`list_notes`, `read_note`, `write_note`, `repo_info`, `read_published`.

You do this **once**. The token reaches every wiki you have, including ones you
create later — the agent names which it means per call, and defaults to the one
open in your browser.

**Then leave a note open in the browser and ask the agent to rewrite it.** You
will watch it type into your editor. That is the part worth seeing — §11 for
why it works that way, and what it still gets wrong.

**Two things the agent cannot do:** publish, and mint itself more tokens. Both
are refused by the server, and publishing is unreachable regardless — it needs
your wallet.

Running tests:

```sh
node --test server/ydoc.test.js src/render.test.js
```

---

## 0. Fangorn in five minutes

**One publisher, one root.** Every wallet address owns exactly one on-chain
state root in the `DataRegistry` contract. Namespaces are key prefixes inside
that root's [Pail](https://github.com/web3-storage/pail) tree, and they're
hierarchical: `app:publisher:namespace`. fangornmd owns the `fangornmd` app
prefix, so every wiki this server serves lives under it — which is what lets
one subscription see the whole instance instead of a per-publisher fan-out.
A "repo" is `(owner address, namespace)`, and following one needs both.

**Vertices and edges, content-addressed.** A vertex is `{ tag, payload }`,
stored as a dag-cbor block whose CID is the hash of its content. An edge is a
`(source cid, relation, target cid)` triple. Identical payload ⇒ identical CID
⇒ identical key: re-staging unchanged data is a free no-op. We lean on this
constantly.

**Git-native flow.** `commit()` seals staged data into a commit object locally —
no transaction. Settling fast-forwards the on-chain root to that commit — one
cheap transaction regardless of commit size. There is no local object store to
sync: blocks live in content-addressed storage, with a local disk cache.

**The store is append-only.** There is no "update vertex" — keys are content
hashes, so editing a note *adds a new version* and the old one stays. This is
the single most important constraint for app design, and §1 is about designing
with it rather than against it.

**Subscribe is a light client.** `fangorn.subscribe()` watches `StateCommitted`
events and diffs the old root against the new one itself — no indexer. It
yields exactly what changed: added/removed vertices and edges, plus a block
number to resume from.

## 1. The data model: notes as versioned vertices

A naive mapping — payload = `{ content }` — breaks on the first edit. The id
you stage with isn't stored (it only resolves edges within that `commit()`
call), and editing appends, so after two edits of `index.md` the namespace
holds three `doc` vertices with nothing saying which is current.

So the payload carries identity and order itself:

```js
{ path: "index.md", content: "# My Wiki…", updatedAt: 1770000000000 }
```

Reading the wiki is then a reduce — [server/graph.js](server/graph.js)
`latestByPath()`: group every vertex by `payload.path`, keep the highest
`updatedAt` (CID as a deterministic tie-break). Older versions aren't garbage,
they're the revision history, for free.

Three subtleties, all load-bearing:

**Publish the whole graph every time.** Edges can only reference vertices
staged in the same `commit()` call, so a link from an edited note to an
untouched one requires staging the untouched note too. That's fine — its
payload is byte-identical, so its CID and key are identical, and staging it
costs nothing. Full-graph publishes stay trivial *because* of content
addressing.

**Only stamp `updatedAt` when content changed.** Stamping every file at publish
time would make every payload differ every time, appending a full set of new
versions on every publish. `buildWikiGraph()` compares each file against the
latest remote version and reuses the remote payload verbatim when it matches.

**The hierarchy is a vertex too.** `.tree.json` rides along as a `meta` vertex,
so followers reconstruct the exact sidebar order rather than guessing (§6).

## 2. Setup

Prerequisites:

- Node ≥ 20.19, [pnpm](https://pnpm.io)
- A [Privy](https://dashboard.privy.io) app id — this is how users log in and
  how each gets an embedded wallet
- A throwaway EVM key for the **service** wallet. It builds graphs, reads, and
  pins; it never signs a user's settlement, and **it needs no funds**
- A [Pinata](https://pinata.cloud) gateway domain for reads

```sh
pnpm install
cp .env.example .env      # ETH_PRIVATE_KEY, PINATA_GATEWAY, VITE_PRIVY_APP_ID
pnpm dev                  # API server (:8787) + Vite (:5173)
```

Open http://localhost:5173, log in, create a namespace, write, hit **Publish**.

The `fangornmd` app prefix must be claimed on-chain once before anyone can
publish under it; the server checks at boot and prints the exact `cast send` to
run if it isn't. Individual wallets also need to be registered as publishers to
write at all — that's a Fangorn-level step, separate from this app.

## 3. Files → graph

`buildAssetGraph(dir, { processors })` walks a directory and turns each file
into a vertex plus outgoing links. The whole "compiler" is
[server/graph.js](server/graph.js): `.md` files become `doc` vertices, and
`.tree.json` becomes a `meta` vertex with no edges. It returns
`{ vertices, edges }` — exactly what `commit()` accepts.

```sh
pnpm graph docs/<owner>/<namespace>    # the graph a publish would stage, as JSON
```

The argument is a single working tree. `docs/` itself holds one subdirectory
per owner, each holding one per namespace.

**Edges come from the stored page hierarchy** — `childrenByPath` maps each note
to its children, and those parent → child pairs are the only edges published.
`[[wikilinks]]` are navigation, and don't affect the graph. See §6.

## 4. The relay

[server/index.js](server/index.js) is a plain `node:http` server, no framework.

Auth is a Privy access token (verified against Privy's JWKS) plus an asserted
wallet address, **or** an agent token (§11) — one `authenticate()` returning
`{ address, agentNs }`, so every route below is reachable by both and the
difference is a namespace scope rather than a parallel API. The assertion is
safe because it's the *settlement transaction* that authenticates a publish
on-chain: you can stage under any address, but you can only settle from the
wallet you hold.

State is one file per user at `.fangorn/users/<address>.json` — no shared
mutable state between users.

| Route | What it does |
|---|---|
| `GET /api/repos` · `GET /api/repo` | Every tracked namespace / the active one |
| `POST /api/repos` | Create a namespace (`public` or `private`) |
| `POST /api/repos/follow` | Track someone else's namespace, read-only |
| `POST /api/repos/active` | Switch namespace — **browser only** |
| `PUT /api/collaborators` | Owner-only: who else may edit the working tree |
| `GET`/`POST /api/tokens` · `POST /api/tokens/revoke` | Agent tokens — **browser only** (§11) |
| `POST /mcp` | MCP over HTTP, agent token as Bearer (§11) |
| `GET /api/notes` | List notes + the stored tree |
| `GET`/`PUT`/`DELETE /api/notes/:path` | Read / write / delete one note — through the live room if one is open (§7) |
| *(any note route)* `?ns=` | Act on a named wiki instead of the active one (§11) |
| `POST /api/notes/:path/rename` | Move a note, rewriting it through the tree |
| `PUT /api/tree` | Persist the drag-and-drop hierarchy |
| `GET /api/remote` | Latest published version of every note, plus edges |
| `POST /api/pull` | Materialize published versions into the working tree |
| `POST /api/repos/discover` | Rebuild the repo list from the chain (§12) |
| `POST /api/repos/delete` | Stop tracking a namespace, delete its tree — **browser only** (§12) |
| `POST /api/notes/delete` | Delete many notes in one call (multi-select) |
| `POST /api/publish/prepare` | Build + pin the commit, return an **unsigned** tx — **browser only** |
| `POST /api/settle` | Record the head after the browser's tx confirms — **browser only** |
| `GET /api/history` | Walk commits from the current head |
| `GET /api/events` | SSE: `local-change` + `remote-change` |
| `GET /r/:owner/:ns/:note.md` | **Public read — no auth** (§10) |

Which repo a request acts on comes from `repoFor()`: a pinned token gets its
namespace and nothing else, anyone else gets `?ns=` if they sent one and the
active repo otherwise. **The browser sends `?ns=` for any write that spans an
await the user can interrupt** — a wallet prompt above all. Falling back to the
active pointer means the space they switch to while waiting receives the write:
one namespace's notes land in another's tree. One helper, so the rule holds on every note route by
construction rather than by remembering.

**Collaborators work in the owner's directory** — same files, same
`.tree.json`. The alternative, giving each collaborator their own copy, means a
friend's edits never reach the tree the owner publishes. One shared tree makes
"the owner publishes what we all wrote" true by construction. Someone who only
follows a namespace (§12) gets their own copy instead, since they never write
to it.

Note paths are validated against `^[\w][\w .-]*\.md$`. A namespace is a display
name people type, but it also becomes a directory name and part of a
collaboration room's key (§7), so it's validated as a blacklist of what would
break those rather than a whitelist of safe characters.

## 5. The editor

[src/Editor.jsx](src/Editor.jsx) is a [Slate](https://docs.slatejs.org) editor
where **markdown is the source of truth and is styled in place**. The Slate
value is just the text, one paragraph per line; decorations style it without
rewriting it, so what serializes back is byte-for-byte what was typed. Syntax
markers (`**`, `#`, `[[ ]]`) collapse to zero width unless the caret is on that
line, so a document reads rendered while staying fully editable — no separate
source pane to keep in sync.

- **Three view modes** — edit, split, read.
- **Math** — `$inline$` and `$$display$$` via KaTeX, rendered when the caret is
  elsewhere and falling back to source when you're editing that line
  ([src/mdmath.js](src/mdmath.js)).
- **Images** — pasted or dropped, inlined as data-URIs, capped at 1 MB. No
  upload endpoint and no blob store, so a note stays one self-contained `.md`
  that survives publish → pull → sync unchanged. This is the main thing
  blocking "real" documents; see §14.
- **Rendering** — [src/render.js](src/render.js) is a small hand-written
  markdown → HTML renderer shared by the read pane, Export, and the public page.
  Nothing from a note reaches the output unescaped, and only `http(s):`,
  `mailto:` and `data:image/` URLs survive — a followed namespace is someone
  else's text rendering in your browser.

## 6. The page hierarchy

The sidebar's shape is data, kept in `.tree.json` inside the repo: an ordered,
nested `[{path, children}]` structure. Drag-and-drop rewrites it, publish
derives the graph's edges from it (parent → child), and it rides the directory
scan like any other file, so it publishes and pulls for free — a follower gets
the author's exact hierarchy, order included.

The alternative is inferring structure from markdown links, which is what a
link-graph wiki does. Storing it means moving a page is a drag rather than a
link-wrangling exercise, and it means the published edges say what the author
meant rather than what their prose happened to reference.

The tree is reconciled against what's on disk on every read: nodes whose file
vanished are dropped, new files are appended as unfiled roots. So an external
editor, a pull, or a crash can never leave the sidebar pointing at nothing.

Dragging works with a mouse anywhere on a row; on touch it starts from the
row's grip, because the grip is the only element that gives up `touch-action`
and the rest of the row has to stay free for scrolling.

`[[wikilinks]]` are for cross-references: ⌘/Ctrl-click one to jump, and the
backlinks strip under the editor shows which notes point at the open one
([src/structure.js](src/structure.js)).

## 7. Live collaboration

Public namespaces get one Yjs room per note, named `owner:namespace:note`
([server/ydoc.js](server/ydoc.js)). Everyone viewing a note joins and sees
keystrokes live; only the owner and named collaborators may type.

The server owns the room lifecycle rather than relaying blindly:

- **Seed** — the room is filled from the owner's file when created, so whoever
  arrives first sees the document instead of a blank page.
- **Persist** — merged text is written back to the owner's working tree on a
  debounce. This is what makes collaboration real: a friend's edits land in the
  tree the owner publishes even when the owner isn't connected.
- **Survive eviction** — a room lives only while someone is in it, but a
  browser that loses its socket keeps its copy and re-sends on reconnect.
  Re-seeding from markdown would mint new CRDT identities for the same words,
  and the note would come back with its whole body twice. So the room's *state*
  is snapshotted, not just its text, and restored only while it still decodes
  to what's on disk.
- **Enforce read-only server-side** — a viewer may request state and publish
  awareness; the two frame types that mutate the document are dropped. Because
  rooms persist to the owner's tree, this is a file-integrity boundary rather
  than a UI nicety, so it's enforced here instead of trusted to the client.

Renaming or deleting a note closes its room before touching the file. A room
outlives the file it mirrors: its debounced flush, and the write triggered when
the last peer leaves, would both re-create the note at the old path — leaving a
rename with a copy under each name.

**The room, not the file, is the current text.** This is the rule the API has to
respect too. While a room exists the file lags it by up to `FLUSH_MS`, so
reading the file returns stale text, and writing the file is erased by the next
flush. `openRoom()` sends `GET`/`PUT /api/notes/:path` through the doc instead
whenever one is open — which is what lets an agent write into a note you are
looking at (§11) rather than into a file that is about to be overwritten.

Private namespaces never open a room: their content is ciphertext the server
can't read, and a live plaintext room would defeat that.

## 8. Publishing, self-custodially

Publish is a three-step handshake, because the server must never hold the key
that moves your on-chain root:

1. `POST /api/publish/prepare` — flush open rooms to disk, read remote state,
   reconcile and persist the tree, build the graph, seal it if private, then
   `prepareCommit()`: the commit is built and pinned, and an **unsigned**
   settlement tx comes back with gas and fees already quoted.
2. The browser sends that tx from the user's Privy wallet.
3. `POST /api/settle` records the new head once it confirms.

The commit is parented on the **on-chain tip**, not the local head. A
publisher's root spans all of its namespaces, so a commit built on a stale
parent would silently roll back whatever another namespace pushed in the
meantime. If a settlement would revert, `prepare` surfaces it as a 409 rather
than letting it fail in the wallet.

Only the owner's wallet can settle. Collaborators can write and co-edit the
working tree; publishing is the owner's act.

**A publish is a snapshot** (`replace: true`), and that is what makes deleting
mean anything: staging only the files that exist would leave a deleted note's
last version in the namespace, and the next pull writes it straight back. The
same property in reverse is the hazard — a working tree missing notes it never
had would drop them — so `prepare` computes the drop set (published paths with
no local file), refuses with a 409 naming them, and the browser asks before
retrying with `confirmDrop`. The state that makes this real rather than
theoretical: a *discovered* private namespace, whose sealed bodies the relay
cannot materialize into files (§12). Dropped versions stay in history —
`fangorn.log()` still walks to them.

## 9. Private namespaces

A private repo's notes are sealed in the browser
([src/crypto.js](src/crypto.js)) with a key derived from a deterministic wallet
signature — Privy never exposes the raw private key, so the secret is derived,
not stored. The signed message names the namespace, so one wiki's key opens that
wiki and nothing else. At publish, `content` is swapped for `enc` before the
commit; the server pins ciphertext it cannot read.

That key can be handed to an agent: tick *"also hand over the decryption key"*
when minting an agent token and it is derived in the tab, shown once, and never
sent to the server — which is what keeps the relay unable to read what it pins.
It decrypts and nothing else (it cannot spend, publish, or sign), but unlike a
token it **cannot be revoked**: re-keying means re-sealing every note.

`path` and `updatedAt` stay clear because they carry identity and ordering, so
**filenames leak and bodies don't**. Server-side, any encrypted payload is
replaced with a placeholder before it can reach a response — the server can't
decrypt, and won't pretend to.

**Reading one back.** The working tree is plaintext (that's what the editor,
the renderer and the live rooms all read), and sealing happens on the way out.
So a private space published from another instance arrives here as ciphertext
the relay cannot write to disk — an empty sidebar, notes that look lost. `pull`
therefore returns those payloads *sealed*, the browser opens them with the
wallet key and saves the plaintext working copy (`restoreSealed` in
[src/App.jsx](src/App.jsx)). It runs automatically only when a private space
has an on-chain head and no local files — the one case with nothing to lose —
and otherwise waits for an explicit Pull, because writing published content
over a working tree is how you eat unpublished edits. Only notes with no local
file are ever handed back sealed.

Keys are tried newest-first: `v2:<namespace>`, then the original global `v1`
message. Anything a v1 key opens is re-sealed under v2 by the next publish, so
the migration is just "publish once". A note neither key opens was sealed by a
different wallet; it's reported by name and left alone, never stubbed — a
placeholder saved into the tree would be published over the real note.

## 10. Public read (and agents)

`GET /r/:owner/:namespace/:note.md` serves the last **published** snapshot to
anyone — no token, no wallet, no SPA shell. The HTML arrives rendered, which is
what makes it work for a stranger's browser, a link preview, a crawler and an
agent's fetch all at once; those are the same requirement, so they get one
route.

- `Accept: text/markdown` returns the source instead. Markdown is what's
  stored, so there's no lossy conversion step — the format an agent wants is
  the format on disk.
- Every page carries provenance: signing address, date, and content hash.
- `ETag` is the CID. A published note is immutable, so a cache hit is always
  valid.
- Only namespaces this server knows *and* that are marked public are served —
  otherwise this server becomes an open gateway for the whole network.
- Working-tree drafts are never served. Publishing is deliberate.

## 11. Agents: tokens and MCP

§10 lets an agent *read* what's published. Writing needs a credential, and a
Privy JWT proves a live browser session an agent can't have. So an owner mints
an **agent token** (🤖 in the header):

```
fmd_<owner address>_<random>
```

- The address is in the token, so resolving it is one file read — no index, no
  scan across users. Only its sha256 is stored; it's shown once at mint.
- **One token, every wiki.** A token reaches each namespace its owner tracks,
  and the caller names the target per request (`?ns=`, or the `namespace`
  argument on the MCP tools). Connecting an agent is therefore a one-time step:
  make a new wiki and the existing token already reaches it. A per-namespace
  credential would mean re-configuring every MCP client each time someone
  creates a wiki, which nobody does.
- **Pinning is opt-in.** A token may be fixed to one namespace at mint, and then
  `?ns=` cannot move it. That's the right default for a token you hand to
  *someone else's* agent, and the wrong one for your own — so the 🤖 panel
  offers both and defaults to unpinned.
- **`?ns=` is never the human's problem.** The browser doesn't send it, so a
  person keeps following their own tabs, and `POST /api/repos/active` is
  browser-only: an agent has no reason to switch the active repo when it can
  name its target per call, and so it can't yank an editor to another wiki
  mid-sentence.
- **Cannot publish, cannot mint.** `assertHuman()` refuses both, keyed on an
  `agent` flag rather than on the presence of a namespace scope — an unpinned
  token has no namespace, and testing the scope would let it pass as a browser
  session. The publish refusal is only the polite error: settling is a
  transaction signed by the owner's wallet, in their browser. The server has no
  key to sign it with and neither does the agent. **The human in the loop is a
  key, not a dialog** — there is nothing an agent can be talked into clicking.

Six tools — `list_wikis`, `list_notes`, `read_note`, `write_note`, `repo_info`,
`read_published` — defined once in [mcp/tools.js](mcp/tools.js) and served over
two transports:

| Transport | Where | For |
|---|---|---|
| **HTTP** | `POST /mcp` on this server | Everyone. Nothing to install — an agent needs a URL and a token, not a checkout, Node, or a copy of this repo. |
| stdio | [mcp/fangornmd.js](mcp/fangornmd.js) | Hacking on a checkout. |

`write_note` takes an optional **`parent`** — the filename of an existing note to
nest the new one under — so an agent can build structure instead of dropping
everything at the root (`reconcileTree` files an unfiled note as a root, and
before this an agent had no way to move it). It is a *parent*, not a directory:
one namespace is one Fangorn subspace, notes are flat on disk, and a vertex's
identity is its filename, so `research/notes.md` is not a path this accepts.
Nesting lands in `.tree.json`, which is what the sidebar renders and what
publish turns into the graph's edges — so an agent's hierarchy publishes.

Hosting the MCP server separately would be a second deployment to run, secure
and keep in version step with an API it is a strict subset of. It's a route
instead, so every user of an instance gets exactly what that instance is
running. Wiring it up: [Quickstart](#quickstart).

`/mcp` is **stateless** — one MCP server and transport per request, no session
ids. The agent token already identifies the caller on every call, so a session
would be a second, weaker identity to keep in step with the first.

The tools reach the API the way any outside client would, over a loopback HTTP
request carrying the caller's own token, rather than calling route handlers
directly. That costs one local request per tool call — nothing at this scale —
and buys the guarantee that MCP can never become a way around a rule the HTTP
API enforces. Same reason the tool file holds no logic of its own: a rule there
is a rule an agent skips by calling the API directly.

**A hosted token crosses the network on every call, so serve `/mcp` over TLS.**
Namespace scoping already bounds what a leaked one reaches, and Revoke is in the
🤖 panel; token expiry is the next thing worth adding, and only then.

**Reads and writes go through the live room, not the file.** While anyone has a
note open, the Yjs doc is the current text and the file lags it by up to
`FLUSH_MS` — so `writeFileSync` under an open room is erased by the next flush,
and reading the file returns stale text. `openRoom()` catches both: an agent
writing a note you have open appears in your editor as it types
(`replaceMarkdown`), and `read_note` returns what's on your screen including
your unsaved edits. That's the beginning of the interesting thing — agent and
human in one buffer rather than trading files.

`read_published` returns the markdown **and the CID it was served under**. An
agent citing that CID is making a claim a second agent can check against the
chain, independently of this server. Nothing else in an agent's toolbox does
that.

What this does *not* do yet: an agent write replaces the whole note, and its
edits arrive unattributed — see the first two bullets of §14. Both matter the
moment a human and an agent are in the same paragraph at the same time, which
is the case worth designing for.

## 12. Following and sharing

A wiki is fully identified by `(owner address, namespace)`. **Share** copies a
link carrying both; opening it offers to subscribe, pull, and open the note.
Following is read-only and needs no permission from anyone — reading and
subscribing are unpermissioned by construction.

**Sync (↻)** recovers the list itself. Which repos you track is per-relay state
(a JSON file under `DATA_DIR`); the namespaces are on-chain. So the same wallet
on a second instance — a local dev server, a fresh volume — logs in to an empty
sidebar with its wikis sitting right there on-chain. `POST /api/repos/discover`
asks the registry: one `getLogs` filtered to `(app, publisher)` returns every
subspace this address has committed under, and since the event carries only
`keccak256(name)`, the name comes from each commit's own root map
(`engine.namespaceOf`). Each recovered namespace is then pulled into a working
tree, and `visibility` comes from whether its payloads carry `enc` — guessing
"public" there would publish a private wiki in the clear on its next publish.

**Deleting.** ☑ in the sidebar header turns the tree into a picker: tap rows to
select (no hover, no long-press — the same gesture on a phone and a laptop),
then Delete once for the whole set. One request, one tree rewrite, so the
sidebar can't render a half-finished selection. Rows aren't draggable while
picking; a drag and a tap on the same element can't both win.

Deleting notes is local until you publish — the snapshot in §8 is what removes
them from the wiki. Deleting a *namespace* ("Delete this space") is local,
full stop: it forgets the repo and removes the working tree, and the on-chain
head keeps pointing where it pointed. The relay records it as `forgotten`, or
the next Sync would helpfully hand it straight back. Following someone else's
namespace resolves your `dir` to *their* tree, so leaving one deletes nothing.

Live sync: the browser holds one `EventSource` on `/api/events`. Remote changes
come off a single app-wide subscription (fangornmd owns the app prefix, so one
topic filter covers every wiki on the instance) and each connection picks out
the namespaces it tracks. The UI shows a banner; **Pull is explicit**, because
auto-applying remote changes to a directory a human also edits is how you eat
someone's work.

## 13. Performance

Publish logs its phases. Expect the first operation after boot to be slow — a
cold namespace walk is one sequential gateway fetch per block — and everything
after to be bounded by "new blocks uploaded + one transaction". The walk is
keyed by the on-chain tip, so one cheap RPC read answers "is my cached walk
current?", and after your own publish the re-walk is nearly free because every
block the commit staged is already in memory.

If publish is consistently slow, the log says which phase: a slow read means
the tip cache isn't being hit; a slow commit+flush means many new blocks or a
struggling uplink; a slow settle is the RPC endpoint or consensus.

## 14. Limitations & where to take it

Roughly in the order they're worth fixing:

- **No blob storage.** Images are data-URIs capped at 1 MB, which rules out
  real documents and means any future "import from Google Docs / Dropbox"
  arrives with broken images. This is the next structural piece.
- **Agent writes replace the whole note.** `replaceMarkdown` clears the doc and
  re-seeds it, so an agent writing while you type costs you your cursor and
  resolves overlapping edits last-writer-wins. Fine for "rewrite this note",
  wrong for "you two work on this paragraph together" — that needs a diff and a
  minimal patch. Marked in [server/ydoc.js](server/ydoc.js).
- **Agent edits are unattributed.** Yjs already knows which client inserted
  which characters; nothing renders it. An agent whose edits arrive visibly
  marked and provisional is a different tool than one that silently rewrites
  your paragraph, and the data to do it is already in the room.
- **Deleting is per-namespace, not global.** A publish replaces the namespace's
  contents (§8), so a deleted note leaves the wiki — but its blocks are
  content-addressed and still in storage, still referenced by the commit that
  staged them. Anyone holding the CID keeps reading it. That's the model, not a
  bug: history is the point. What's missing is the loud version of it — the app
  says "removed from the wiki", never "unpublished".
- **Private notes re-seal every publish.** A fresh nonce means a new CID even
  for unchanged content, so the identical-payload saving from §1 never applies —
  the server can't decrypt remote state to detect what actually changed.
- **Address is asserted, not bound.** The token proves a live Privy session and
  the settlement tx proves wallet control, but binding address → DID
  server-side needs the Privy app secret. Tracked as hardening.
- **Single instance by design.** Rooms and subscriptions live in one process's
  memory. See [DEPLOY.md](DEPLOY.md) before scaling out.
- **No browser tests.** The pure logic has unit tests; view switching, drag and
  drop, and the editor have none, and those are exactly the places where a
  broken change reaches a user before it reaches a test.

## Layout and tests

```
docs/<owner>/<ns>/     working trees (the data)
  .tree.json           the stored sidebar hierarchy, published as a vertex
.fangorn/users/*.json  per-user repo store: { active, repos, tokens }
.fangorn/rooms/        Yjs room snapshots, so a room survives eviction
server/graph.js        files → versioned graph, latest-version reduce
server/index.js        API, auth, publish prep, live rooms, public read
server/ydoc.js         markdown ⇄ Yjs, and the read-only frame filter
mcp/tools.js           the five MCP tools, shared by both transports
mcp/fangornmd.js       stdio MCP entry point (HTTP lives at POST /mcp)
src/render.js          markdown → HTML (read pane, Export, public page)
src/structure.js       pure tree transforms + backlinks
src/crypto.js          browser-side sealing for private namespaces
```

```sh
node --test server/ydoc.test.js src/render.test.js
```

`ydoc.test.js` exists because the server's markdown ⇄ Slate conversion has to
agree with the browser's exactly — a drift between them corrupts notes quietly.
`render.test.js` covers the renderer that produces pages nobody proofreads
before a stranger sees them.

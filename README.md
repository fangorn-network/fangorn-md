# fangornmd

A self-hosted, collaborative markdown wiki whose storage layer is the
[Fangorn network](https://github.com/fangorn-network/fangorn). Notes are plain
markdown files on disk; publishing snapshots them into a versioned,
content-addressed graph settled on-chain (Arbitrum Sepolia), with blocks pinned
to IPFS. Anyone can then follow your wiki by address + namespace, read it, and
live-sync as you push updates.

Two properties are the whole point, and they're why this isn't a worse Google
Drive:

- **Self-custodial.** The server holds no user keys. Every on-chain settlement
  is signed by the user's own wallet in their browser. Private namespaces are
  encrypted client-side — the server pins ciphertext it cannot read.
- **Published, not shared.** A publish is a signed, content-addressed snapshot
  that exists independently of this server. A reader can see who signed a page
  and the exact hash of what they're reading, which is something a link to a
  hosted doc can never tell them.

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

The browser never touches the SDK directly — it needs Node (block cache, LMDB,
gateway access) — so all Fangorn work happens server-side and the frontend
stays a replaceable client. The one thing the server deliberately *cannot* do
is sign for a user.

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
wallet address. The assertion is safe because it's the *settlement transaction*
that authenticates a publish on-chain: you can stage under any address, but you
can only settle from the wallet you hold.

State is one file per user at `.fangorn/users/<address>.json` — no shared
mutable state between users.

| Route | What it does |
|---|---|
| `GET /api/repos` · `GET /api/repo` | Every tracked namespace / the active one |
| `POST /api/repos` | Create a namespace (`public` or `private`) |
| `POST /api/repos/follow` | Track someone else's namespace, read-only |
| `POST /api/repos/active` | Switch namespace |
| `PUT /api/collaborators` | Owner-only: who else may edit the working tree |
| `GET /api/notes` | List notes + the stored tree |
| `GET`/`PUT`/`DELETE /api/notes/:path` | Read / write / delete one note |
| `POST /api/notes/:path/rename` | Move a note, rewriting it through the tree |
| `PUT /api/tree` | Persist the drag-and-drop hierarchy |
| `GET /api/remote` | Latest published version of every note, plus edges |
| `POST /api/pull` | Materialize published versions into the working tree |
| `POST /api/publish/prepare` | Build + pin the commit, return an **unsigned** tx |
| `POST /api/settle` | Record the head after the browser's tx confirms |
| `GET /api/history` | Walk commits from the current head |
| `GET /api/events` | SSE: `local-change` + `remote-change` |
| `GET /r/:owner/:ns/:note.md` | **Public read — no auth** (§10) |

**Collaborators work in the owner's directory** — same files, same
`.tree.json`. The alternative, giving each collaborator their own copy, means a
friend's edits never reach the tree the owner publishes. One shared tree makes
"the owner publishes what we all wrote" true by construction. Someone who only
follows a namespace (§11) gets their own copy instead, since they never write
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
  blocking "real" documents; see §13.
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

## 9. Private namespaces

A private repo's notes are sealed in the browser
([src/crypto.js](src/crypto.js)) with a key derived from a deterministic wallet
signature — Privy never exposes the raw private key, so the secret is derived,
not stored. At publish, `content` is swapped for `enc` before the commit; the
server pins ciphertext it cannot read.

`path` and `updatedAt` stay clear because they carry identity and ordering, so
**filenames leak and bodies don't**. Server-side, any encrypted payload is
replaced with a placeholder before it can reach a response — the server can't
decrypt, and won't pretend to.

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

## 11. Following and sharing

A wiki is fully identified by `(owner address, namespace)`. **Share** copies a
link carrying both; opening it offers to subscribe, pull, and open the note.
Following is read-only and needs no permission from anyone — reading and
subscribing are unpermissioned by construction.

Live sync: the browser holds one `EventSource` on `/api/events`. Remote changes
come off a single app-wide subscription (fangornmd owns the app prefix, so one
topic filter covers every wiki on the instance) and each connection picks out
the namespaces it tracks. The UI shows a banner; **Pull is explicit**, because
auto-applying remote changes to a directory a human also edits is how you eat
someone's work.

## 12. Performance

Publish logs its phases. Expect the first operation after boot to be slow — a
cold namespace walk is one sequential gateway fetch per block — and everything
after to be bounded by "new blocks uploaded + one transaction". The walk is
keyed by the on-chain tip, so one cheap RPC read answers "is my cached walk
current?", and after your own publish the re-walk is nearly free because every
block the commit staged is already in memory.

If publish is consistently slow, the log says which phase: a slow read means
the tip cache isn't being hit; a slow commit+flush means many new blocks or a
struggling uplink; a slow settle is the RPC endpoint or consensus.

## 13. Limitations & where to take it

Roughly in the order they're worth fixing:

- **No blob storage.** Images are data-URIs capped at 1 MB, which rules out
  real documents and means any future "import from Google Docs / Dropbox"
  arrives with broken images. This is the next structural piece.
- **No deletes on-chain.** Removing a file drops it from future edges, but its
  latest version still wins the `latestByPath` reduce, so a pull can resurrect
  it. The fix is a tombstone version respected by the reduce.
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
.fangorn/users/*.json  per-user repo store: { active, repos }
.fangorn/rooms/        Yjs room snapshots, so a room survives eviction
server/graph.js        files → versioned graph, latest-version reduce
server/index.js        API, auth, publish prep, live rooms, public read
server/ydoc.js         markdown ⇄ Yjs, and the read-only frame filter
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

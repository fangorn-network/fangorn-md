# fangornmd

A personal, self-hosted HackMD-style wiki whose storage layer is the
[Fangorn network](https://github.com/fangorn-network/fangorn). Your notes are
plain markdown files on disk; publishing snapshots them into a versioned,
content-addressed graph settled on-chain (Arbitrum Sepolia), with blocks pinned
to IPFS. Anyone can then *clone* your wiki by address + namespace, read it,
and live-sync as you push updates — no central server anywhere.

This README doubles as the **dev guide**: it builds the whole app up from a
15-line graph builder, and every design decision is explained in terms of what
the Fangorn SDK actually does. If you follow it top to bottom you'll understand
enough to build your own Fangorn-backed app.

```
┌─────────────────────────── your machine ───────────────────────────┐
│                                                                     │
│  docs/*.md          server/index.js                src/ (Vite)      │
│  (working tree) ◄──► local API server  ◄── /api ──► React editor    │
│                       │        ▲                                    │
│                 @fangorn-network/sdk                                │
└───────────────────────┼────────┼───────────────────────────────────┘
                 commit/push   subscribe (poll StateCommitted)
                        ▼        │
              Arbitrum Sepolia (DataRegistry contract)
                        │
                   IPFS / Pinata (commit + vertex blocks)
```

Three pieces, smallest possible surface each:

| Piece | File(s) | Job |
|---|---|---|
| Working tree | `docs/*.md` | Your notes. Plain files — edit them with anything. |
| Local server | [server/index.js](server/index.js), [server/graph.js](server/graph.js) | Wraps the SDK: read/write files, publish, pull, stream live changes. |
| Editor | [src/](src/) | HackMD-style split editor talking to the server over HTTP + SSE. |

The browser never touches the SDK directly — it needs Node (filesystem block
cache, wallet key, LMDB) — so all Fangorn work happens in the ~250-line local
server and the frontend stays a dumb, replaceable client. That is also what
will make a mobile client easy later: it's just another consumer of the same
tiny API.

---

## 0. Fangorn in five minutes

Concepts you need before any code makes sense:

**One publisher, one root.** Every wallet address owns exactly one on-chain
state root in the `DataRegistry` contract. *Namespaces* (like `fangornmd`) are
key prefixes inside that root's [Pail](https://github.com/web3-storage/pail)
tree — so "a repo" is `(owner address, namespace name)`, and cloning needs
both.

**Vertices and edges, content-addressed.** Data is a graph. A vertex is
`{ tag, payload }`, stored as a dag-cbor block whose CID is the hash of its
content, keyed at `<ns>/v/<cid>`. An edge is a `(source cid, relation, target
cid)` triple. Identical payload ⇒ identical CID ⇒ identical key: re-staging
unchanged data is a free no-op. We lean on this constantly.

**Git-native flow.** `fangorn.commit()` seals staged data into a commit object
(parents, timestamp, message, tree root) *locally* — no transaction.
`fangorn.push()` fast-forwards your on-chain root to a commit — one cheap
transaction regardless of commit size. `.fangorn/repo.json` is the analogue of
`.git/HEAD`: namespace, owner, local tip CID. There is no local object store
to sync — blocks live in content-addressed storage (Pinata/IPFS, with a local
disk cache).

**The store is append-only.** There is no "update vertex" — keys are content
hashes, so editing a note *adds a new version* and the old one stays. This is
the single most important constraint for app design, and the next section is
about designing with it rather than against it.

**Subscribe is a light client.** `fangorn.subscribe()` watches the contract's
`StateCommitted` events and diffs the old root against the new one itself —
no indexer, no backend. It yields exactly what changed in your namespace:
added/removed vertices and edges, plus the block number to use as a resume
cursor.

## 1. The data model: notes as versioned vertices

A naive mapping — vertex payload = `{ content }` — breaks on the first edit:

- the *id you staged with is not stored*. `commit()` takes `{ id, tag, payload }`
  but the id only resolves edges within that call; on read you get back
  `{ cid, schemaId, payload }`. If the payload doesn't say which note it is,
  that information is gone.
- editing appends. After two edits of `index.md` the namespace holds three
  `doc` vertices, and nothing says which is current.

So the payload itself must carry identity and order:

```js
{ path: "index.md", content: "# My Wiki…", updatedAt: 1770000000000 }
```

Reading the wiki is then a reduce, [server/graph.js](server/graph.js)
`latestByPath()`: group every `doc` vertex by `payload.path`, keep the highest
`updatedAt`. Older versions aren't garbage — they're the note's revision
history, for free.

Two subtleties, both load-bearing:

**Publish the whole graph every time.** Edges can only reference vertices
staged *in the same `commit()` call* (the SDK resolves edge endpoints from
that call's local-id map). A link from an edited note to an untouched one
therefore requires staging the untouched note too. That's fine — its payload
is byte-identical, so its CID and key are identical, and staging it costs
nothing. Full-graph publishes keep the code trivial *because* of content
addressing.

**Only stamp `updatedAt` when content changed.** If we stamped every file at
publish time, every payload would differ every time and every publish would
append a full set of new versions. Instead `buildWikiGraph()` compares each
file against the latest remote version and reuses the *remote payload
verbatim* when the content matches:

```js
const payload =
    remote && remote.payload.content === content
        ? remote.payload   // unchanged → identical CID → free no-op
        : { path: file.name, content, updatedAt: Date.now() };
```

## 2. Setup

Prerequisites:

- Node ≥ 20.19, [pnpm](https://pnpm.io)
- A throwaway EVM wallet private key, funded with a little
  [Arbitrum Sepolia ETH](https://www.alchemy.com/faucets/arbitrum-sepolia)
  (pushes are ~one cheap tx each)
- A free [Pinata](https://pinata.cloud) account (JWT + gateway domain) — this
  is where blocks are pinned

```sh
pnpm install
cp .env.example .env      # fill in ETH_PRIVATE_KEY, PINATA_JWT, PINATA_GATEWAY
```

One-time on-chain setup (the SDK ships the `fangorn` CLI):

```sh
pnpm exec fangorn register                  # register your wallet as a publisher
pnpm exec fangorn repo init fangornmd       # allocate the namespace, write .fangorn/repo.json
```

> Cloning someone else's wiki instead? Skip both and see [§8](#8-cloning-someone-elses-wiki).

Then run everything:

```sh
pnpm dev        # starts the API server (:8787) and Vite (:5173) together
```

Open http://localhost:5173, edit, hit **Publish**.

## 3. Part one — files → graph

Everything starts from one function. `buildAssetGraph(dir, { processors })`
(from the SDK's harness) walks a directory and lets you turn each file type
into a vertex + outgoing links; `extractMarkdownLinks` pulls both
`[text](page.md)` and `[[wikilink]]` targets out of markdown. Our whole
"compiler" is [server/graph.js](server/graph.js):

```js
buildAssetGraph(dir, {
    processors: {
        ".md": (file) => ({
            tag: "doc",
            payload: /* §1: path + content + conditional updatedAt */,
            links: extractMarkdownLinks(file.readText()),
        }),
    },
});
```

It returns `{ vertices, edges }` — exactly the shape `fangorn.commit()`
accepts. Links to files that don't exist are dropped, self-links are dropped,
and edges all get `rel: "links"`. Try it:

```sh
pnpm graph      # prints the graph a publish would stage, as JSON
```

You can drive the whole lifecycle from the CLI with nothing but that JSON —
useful to demystify what the server automates later:

```sh
pnpm graph > commit.json
pnpm exec fangorn repo commit commit.json -m "first snapshot"   # local commit
pnpm exec fangorn repo push                                     # settle on-chain
pnpm exec fangorn repo log                                      # walk history
pnpm exec fangorn repo read                                     # dump the namespace
```

## 4. Part two — the local server

[server/index.js](server/index.js) is a plain `node:http` server (no
framework) exposing the working tree and the SDK:

| Route | What it does |
|---|---|
| `GET /api/repo` | Repo pointer + your wallet address + `writable` (are you the owner?) |
| `GET /api/notes` | List `docs/*.md` (path + first-heading title) |
| `GET /api/notes/:path` | Read one note |
| `PUT /api/notes/:path` | Write one note (the editor's autosave) |
| `GET /api/remote` | Latest version of every note *on-chain*, plus the link graph |
| `POST /api/publish` | Snapshot `docs/` → `commit()` → `push()` |
| `POST /api/pull` | Materialize the on-chain latest versions into `docs/` |
| `GET /api/history` | `fangorn.log()` from the local tip |
| `GET /api/events` | SSE stream: `local-change` + `remote-change` |

The interesting handlers:

**Publish** is four lines of SDK against everything §1 set up: fetch remote
latest (so unchanged payloads are reused), build the graph, `commit()`,
`push()`. The parent chain is what makes `fangorn repo log` show real history.
One trap worth internalizing: the commit is parented on the **on-chain tip**,
not the local head. A publisher's root spans *all* of its namespaces, so a
commit built on a stale parent would — once settled — silently roll back
whatever your other namespaces pushed in the meantime. Ask this repo's author
how he knows. If a push still fails with a fast-forward error, another device
pushed while you were committing — just publish again.

**Reading a cloned repo** uses `fangorn.engine.listNamespace(namespace, owner)`
rather than `fangorn.inspectNamespace(namespace)`: the latter is a shorthand
hard-wired to *your own* address, and a clone's owner isn't you.

**Writable vs read-only.** A wallet can only push to its own root. The server
compares `repo.json`'s `owner` with its wallet and refuses `POST /api/publish`
on clones with a 403 — the UI hides the button entirely.

Note paths are validated against `^[\w][\w .-]*\.md$` — the note namespace is
flat, and nothing resembling a path traversal gets near `join(DOCS, path)`.

## 5. Part three — the editor

The Vite app ([src/](src/)) is deliberately boring React:

- [src/App.jsx](src/App.jsx) — sidebar (note list, repo identity), topbar
  (save state, Publish), and the remote-change banner. Autosave debounces
  600 ms of quiet, then `PUT`s the file. Saving and publishing are separate
  acts, exactly like git: the file is your working tree, publish is
  commit+push.
- [src/Editor.jsx](src/Editor.jsx) — the HackMD split: textarea left,
  rendered preview right. `marked` renders, `DOMPurify` sanitizes — a cloned
  wiki is *someone else's content running in your app*, so raw HTML is never
  trusted. `[[wikilinks]]` are rewritten to normal links, and clicks on
  relative `.md` links navigate in-app instead of reloading.
- [vite.config.js](vite.config.js) — proxies `/api` to `:8787` so the browser
  sees one origin and CORS never comes up.

### Structure is inferred from links

There are no folders. The sidebar's filesystem-like tree is *derived from the
link graph* — the same edges a publish stages on-chain — in
[src/structure.js](src/structure.js):

- `GET /api/notes` returns each note's outgoing links (via the SDK's
  `extractMarkdownLinks`, which catches both `[text](page.md)` and
  `[[wikilink]]`), **in document order**, deduped, dropping targets that don't
  exist.
- `buildTree()` takes the BFS spanning tree rooted at `index.md`: every note
  hangs under the *shallowest* note that links to it, and siblings keep the
  order they appear in the parent's text. The graph can have cycles and
  multiple in-links; BFS with a visited set collapses it to a tree
  deterministically.
- Notes nothing links to are grouped under **unlinked** — that's your prompt
  to weave them in.
- `buildBacklinks()` reverses the graph; the strip under the editor shows
  which notes link *to* the open one.

So "moving" a note is just editing markdown: add a link to it from a
different page and the tree reorganizes on the next autosave (the sidebar
refreshes on every `local-change` event). Because the structure lives in the
published edges rather than any local convention, someone who clones your
wiki sees exactly the same tree.

## 6. Part four — live sync

The flow, end to end:

1. The browser opens `EventSource("/api/events")`
   ([src/useEvents.js](src/useEvents.js)).
2. On the first SSE client, the server starts
   `fangorn.subscribe({ namespace, owner, signal })` and forwards every
   `NamespaceChange` as a `remote-change` event. When the last client
   disconnects, the `AbortController` stops the watch — no chain polling while
   nobody's looking.
3. A change carries `addedVertices`, `removedVertexCids`, `commitCid`, and
   `blockNumber`. The UI shows a banner: *"Remote updated — Pull"*.
4. **Pull** writes the on-chain latest versions into `docs/`, the server's
   `fs.watch` on `docs/` fires a `local-change` event, and every open editor
   reloads (unless it has unsaved edits, which are never clobbered).

Deliberate choices worth copying:

- **Pull is explicit.** Auto-applying remote changes to a directory the user
  also edits by hand is how you eat someone's work. The subscription only
  *notifies*; a human clicks Pull.
- **Your own publishes echo back** — `subscribe` watches the chain, and you
  committed to the chain. Pulling after your own publish is a no-op (contents
  already match), so the server doesn't bother filtering self-echoes.
- The CLI version of all this is `pnpm exec fangorn subscribe`, which also
  persists `blockNumber` as a resume cursor
  (`.fangorn/subscribe-*.json`) so a restarted watcher replays exactly what it
  missed. The server currently subscribes live-only and relies on Pull for
  catch-up, which is simpler and always correct — the cursor trick matters
  when you need *every intermediate* change, not just current state.

## 7. Performance: where publish time actually goes

A publish is three phases, and the server logs each one
(`[publish] read 0.2s · commit+flush 6.1s · push 3.4s`):

1. **Read remote state.** Walking the namespace from the on-chain root means
   fetching pail shard blocks and vertex/edge blocks from the IPFS gateway —
   *sequentially, one HTTP round-trip per block*. Cold, this dominates
   everything (tens of seconds). Two caches attack it:
   - The SDK keeps every block it sees in an in-process memory cache.
   - The server keys the whole walk by the owner's **on-chain tip**
     (`remoteState()` in [server/index.js](server/index.js)): one cheap RPC
     read per call answers "is my cached walk still current?", and the cache
     is warmed in the background at boot. After your own publish the re-walk
     is nearly free — every block the commit staged is already in memory.
2. **Commit + flush.** Sealing the commit is local and instant; the flush
   uploads each *new* block as its own Pinata pin (bounded concurrency,
   default 16 — tune with `PINATA_UPLOAD_CONCURRENCY`). An upload ledger at
   `~/.fangorn/upload-ledger/` remembers what the gateway already has, so
   re-publishing unchanged content uploads nothing.
3. **Push.** One transaction + receipt wait on Arbitrum Sepolia. A few
   seconds, and irreducible — that's consensus.

So the expected shape is: first operation after boot is slow (cold walk),
everything after is bounded by "new blocks uploaded + one transaction" — a
single-note edit publishes in seconds. If publish is consistently slow,
check the server log to see *which* phase it is: a slow `read` means the tip
cache isn't being hit (server restarted between every publish?); a slow
`commit+flush` means lots of new blocks or a struggling uplink to Pinata; a
slow `push` is the RPC endpoint.

## 8. Cloning someone else's wiki

A wiki is fully identified by `(owner address, namespace)`. To follow one:

```sh
mkdir their-wiki && cd their-wiki
pnpm exec fangorn clone 0x147c24c5Ea2f1EE1ac42AD16820De23bBba45Ef6 fangornmd
mkdir docs
pnpm dev            # server boots read-only; click Pull to materialize docs/
```

`clone` just resolves the owner's on-chain tip and writes
`.fangorn/repo.json` — remember, there are no objects to download until you
read them, and then they come from IPFS by CID. The app runs identically
except `writable: false`: no Publish button, but browsing and live sync work,
because reading and subscribing need no permission from anyone.

To *fork* instead of follow: pull, then `pnpm exec fangorn repo init <your-namespace>`
and publish under your own root.

## 9. Limitations & where to take it

Honest gaps in v1, roughly in the order they'd be worth fixing:

- **No deletes.** Removing a file drops it from future *edges*, but its latest
  version still wins the `latestByPath` reduce, so a Pull resurrects it. The
  fix is a tombstone version (`{ path, deleted: true, updatedAt }`) written on
  delete and respected by the reduce and the pull.
- **Last-writer-wins.** Two devices editing the same note race on
  `updatedAt`; nothing merges. Fangorn gives you both versions and the commit
  DAG, so three-way merge (or CRDTs in the payload) is buildable — it's app
  work, not protocol work.
- **Revision history UI.** Superseded versions are already in the namespace
  and `GET /api/history` already walks commits; a HackMD-style history drawer
  is pure frontend.
- **Mobile.** The frontend is a thin client over nine JSON routes — point a
  React Native / Capacitor shell at a server running on your LAN or a
  tailnet. Nothing in `src/` assumes a desktop except the split layout.
- **Private notes.** Everything published here is public. Fangorn's actual
  headline feature — zero-knowledge conditional access control — is the
  natural next chapter: encrypt payloads, gate decryption on a condition.

## Repository layout

```
docs/               your notes (the working tree — this is the data)
.fangorn/repo.json  repo pointer: namespace, owner, local tip (like .git/HEAD)
server/graph.js     files → versioned graph, and the latest-version reduce
server/index.js     local API: files, publish, pull, history, SSE live sync
src/                Vite + React editor (App, Editor, api client, SSE hook)
```

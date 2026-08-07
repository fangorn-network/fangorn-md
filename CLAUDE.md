# fangorn-md

## Read the wiki before scanning the codebase

There is a structured wiki for this repo in the `fangorn-md` fangornmd
namespace, reachable over the `fangornmd` MCP server.

**Start every session with `list_notes(namespace: "fangorn-md")`.** It returns
every page, its `[[wikilinks]]` and the hierarchy in one cheap call. Then
`read_note` only the pages you need.

It holds what the code cannot tell you: design decisions and the alternatives
they beat, invariants that span files, and bugs already paid for once. Read the
code for *what*; read the wiki for *why*.

Entry points:

- `index.md` — map and the three properties every decision serves
- `invariants.md` — rules that span files and break **silently**. Read this
  before changing anything they touch
- `gotchas.md` — bugs already hit, with root causes. Check before "fixing"
  something that looks redundant
- `file-map.md` — concern → file, so you can skip the orientation grep

## Keeping it current

Pages name the commit they were written against. If a page disagrees with the
code, **the code is right** — update the page with `write_note`.

When you make a non-obvious call, hit a bug whose cause was not local, or learn
something that isn't recoverable from the source: write it to the wiki. Prefer
*why* over *what* — descriptions of code go stale, rationale does not.

Do not mirror the codebase into the wiki. If one grep answers it, leave it out.

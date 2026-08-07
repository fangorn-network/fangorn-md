// node server/sweep.test.js
//
// The property: stale snapshots go, fresh ones and live rooms stay, and the
// sweep never reaches outside .fangorn/rooms.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepRoomSnapshots } from "./sweep.js";

const root = join(tmpdir(), `sweep-test-${process.pid}`);
const rooms = join(root, "rooms");
const snap = (owner, ns, note, ageMs) => {
    const dir = join(rooms, owner, ns);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${note}.json`);
    writeFileSync(file, "{}");
    const t = (Date.now() - ageMs) / 1000;
    utimesSync(file, t, t);
    return file;
};

rmSync(root, { recursive: true, force: true });
const DAY = 24 * 3600_000;
const owner = "0x" + "a".repeat(40);

const stale = snap(owner, "wiki", "old.md", 2 * DAY);
const fresh = snap(owner, "wiki", "new.md", 60_000);
const staleButOpen = snap(owner, "wiki", "open.md", 2 * DAY);
// A namespace whose every snapshot is stale — the directory should go too.
const abandoned = snap(owner, "gone", "index.md", 30 * DAY);

const removed = sweepRoomSnapshots(rooms, {
    isLive: (_o, _ns, note) => note === "open.md",
});

assert.deepEqual(removed.sort(), [`${owner}/gone/index.md`, `${owner}/wiki/old.md`]);
assert.ok(!existsSync(stale), "stale snapshot survived");
assert.ok(!existsSync(abandoned), "abandoned namespace survived");
assert.ok(existsSync(fresh), "fresh snapshot was purged");
assert.ok(existsSync(staleButOpen), "live room's snapshot was purged");
assert.ok(!existsSync(join(rooms, owner, "gone")), "empty namespace dir left behind");
assert.ok(existsSync(join(rooms, owner, "wiki")), "non-empty namespace dir removed");

// Nothing to do, no throw, no directories invented.
rmSync(root, { recursive: true, force: true });
assert.deepEqual(sweepRoomSnapshots(rooms), []);
assert.ok(!existsSync(rooms));

console.log("sweep.test.js ok");

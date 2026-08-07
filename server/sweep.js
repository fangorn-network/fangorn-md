// Janitor for the room snapshots under .fangorn/rooms.
//
// A snapshot is written whenever a room is seeded or flushed (server/index.js)
// and deleted only when its note is renamed or deleted. So a note somebody
// opened once leaves a base64 copy of its whole CRDT state on disk forever —
// the working tree in duplicate, plus tombstones, growing monotonically. On a
// box with a real disk that is invisible; on a Pi it is the file that eats the
// card.
//
// The snapshot is a CACHE, not a source of truth: the .md file is. Losing one
// costs exactly one thing — a peer that reconnects after the gap re-seeds from
// markdown with fresh identities and can duplicate its own text (see the note
// in ydoc.js). That only bites a peer holding a document older than the
// staleness window, which is not a session anyone has.
//
// Deliberately NOT swept: working trees under docs/. Those are the user's
// notes, including unpublished ones — an abandoned wiki is still their wiki.

import { readdirSync, statSync, rmSync, rmdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const subdirs = (dir) =>
    (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [])
        .filter((e) => e.isDirectory()).map((e) => e.name);

/**
 * Delete snapshots untouched for `maxAgeMs`, skipping rooms that are live right
 * now (their snapshot is about to be rewritten anyway).
 *
 * @param {string} roomsDir            .fangorn/rooms
 * @param {(owner:string, ns:string, note:string) => boolean} isLive
 * @returns {string[]} what was removed, for the log line
 */
export function sweepRoomSnapshots(roomsDir, { maxAgeMs = 24 * 3600_000, now = Date.now(), isLive = () => false } = {}) {
    const removed = [];
    for (const owner of subdirs(roomsDir)) {
        for (const ns of subdirs(join(roomsDir, owner))) {
            const nsDir = join(roomsDir, owner, ns);
            for (const e of readdirSync(nsDir, { withFileTypes: true })) {
                if (!e.isFile() || !e.name.endsWith(".json")) continue;
                const note = e.name.slice(0, -".json".length);
                if (isLive(owner, ns, note)) continue;
                const file = join(nsDir, e.name);
                if (now - statSync(file).mtimeMs < maxAgeMs) continue;
                rmSync(file, { force: true });
                removed.push(`${owner}/${ns}/${note}`);
            }
            try { rmdirSync(nsDir); } catch { /* still has snapshots */ }
        }
        try { rmdirSync(join(roomsDir, owner)); } catch { /* still has namespaces */ }
    }
    return removed;
}

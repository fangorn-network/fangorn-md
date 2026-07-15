import { sealSelf, unsealSelf } from "@fangorn-network/sdk";
import { keccak256, toHex, hexToBytes, stringToBytes } from "viem";

// ─── Private-repo encryption (self-HKDF, owner-only) ───────────────────────────
//
// A "private" repo seals each note's content with the SDK's `sealSelf`: the AES
// key is derived straight from our own 32-byte wallet secret, bound to a
// per-note `resourceId`. No access worker, no recipient, no settlement — only
// the holder of ETH_PRIVATE_KEY can re-derive the key and read the note. A
// follower cloning this namespace sees the ciphertext and nothing else.
//
// The sealed bytes ride INSIDE the vertex payload as `enc` (hex), replacing the
// plaintext `content`. `path` and `updatedAt` stay in the clear because the
// append-only reduce (latestByPath) needs them for identity + ordering — note
// FILENAMES leak, note BODIES do not. If you need filenames hidden too, that's
// a bigger design (opaque ids + an encrypted manifest); out of scope here.

const ownSecret = () => hexToBytes(process.env.ETH_PRIVATE_KEY);

// keccak256("<namespace>:<path>") — matches Fangorn's resourceId convention so
// the same binding could later gate a paid/worker read of the same field.
const resourceId = (namespace, path) =>
    keccak256(stringToBytes(`${namespace}:${path}`));

/** Plaintext content → hex ciphertext bound to (namespace, path). */
export function sealContent(namespace, path, content) {
    return toHex(sealSelf(stringToBytes(content), ownSecret(), resourceId(namespace, path)));
}

/** Hex ciphertext → plaintext content. Throws if the key/resourceId don't match. */
export function unsealContent(namespace, path, encHex) {
    return Buffer.from(
        unsealSelf(hexToBytes(encHex), ownSecret(), resourceId(namespace, path)),
    ).toString("utf-8");
}

// node server/crypto.js — self-check the seal/unseal roundtrip + resourceId binding.
if (import.meta.url === `file://${process.argv[1]}`) {
    const assert = (await import("node:assert")).default;
    process.env.ETH_PRIVATE_KEY ??=
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const enc = sealContent("images", "logo.md", "the eagles are coming");
    assert.equal(unsealContent("images", "logo.md", enc), "the eagles are coming");
    assert.throws(() => unsealContent("images", "other.md", enc), "wrong resourceId must reject");
    console.log("crypto.js self-check ok");
}

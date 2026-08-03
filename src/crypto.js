// ─── Browser-side note encryption (self-custodial) ───────────────────────────
//
// Under self-custody the ENCRYPTION KEY must live where the wallet lives — the
// browser — so the server (now a shared relay) can never read private notes.
// Privy never exposes the embedded wallet's raw private key, so we derive a
// stable 32-byte secret from a deterministic wallet signature over a fixed
// message (personal_sign is RFC-6979 deterministic → same signature every time
// → same key). That secret feeds the SDK's `sealSelf`, exactly as the old
// server-side path did — but the plaintext and key never leave this tab.
//
// We deep-import just the crypto module so Vite doesn't pull the Node-only
// engine (LMDB/fs) into the browser bundle.

import { sealSelf, unsealSelf } from "@fangorn-network/sdk/lib/crypto/encryption.js";
import { keccak256, toHex, hexToBytes, stringToBytes } from "viem";

// keccak256("<namespace>:<path>") — matches Fangorn's resourceId convention, so
// the same binding can later gate a worker/paid read of the same field.
const resourceId = (namespace, path) => keccak256(stringToBytes(`${namespace}:${path}`));

// The message is bound to the namespace (v2), so the key that opens one wiki
// opens ONLY that wiki. That matters the moment this secret is handed to an
// agent: a global key would make "limit this token to <namespace>" a lie, since
// the agent could decrypt every namespace the same wallet ever sealed.
//
// No migration path is needed on this side: the browser only ever seals, and
// every publish re-seals all notes (see server/index.js), so the next publish
// moves a namespace to v2 wholesale. An external reader holding a v1 secret
// needs it only for commits published before that.
export const keyMessage = (namespace) => `fangornmd encryption key v2:${namespace}`;
// v1 was one key for every namespace of a wallet. Notes sealed under it are
// still out there and still the user's, so reading tries v2 then v1; whatever
// opens gets re-sealed under v2 by the next publish.
const KEY_MESSAGE_V1 = "fangornmd encryption key v1";

const cache = new Map(); // namespace → secret, for this session

/**
 * Derive (and cache for the session) the 32-byte encryption secret for one
 * namespace. `signMessage` is an async fn returning the hex signature string.
 */
export async function deriveSecret(signMessage, namespace) {
    if (cache.has(namespace)) return cache.get(namespace);
    const sig = await signMessage(keyMessage(namespace));
    const secret = hexToBytes(keccak256(sig)); // 65-byte sig → 32-byte key
    cache.set(namespace, secret);
    return secret;
}

/** The same secret as hex — what you hand to an agent, and the only form that leaves the tab. */
export const deriveSecretHex = async (signMessage, namespace) =>
    toHex(await deriveSecret(signMessage, namespace));

/** Plaintext → hex ciphertext, bound to (namespace, path). */
export function sealContent(namespace, path, content, secret) {
    return toHex(sealSelf(stringToBytes(content), secret, resourceId(namespace, path)));
}

/** Hex ciphertext → plaintext. Throws if key/resourceId don't match. */
export function unsealContent(namespace, path, encHex, secret) {
    return new TextDecoder().decode(unsealSelf(hexToBytes(encHex), secret, resourceId(namespace, path)));
}

/**
 * Every secret this wallet could have sealed `namespace` with, newest first.
 * Two signatures, both cached for the session — one prompt each at most.
 */
export async function readSecrets(signMessage, namespace) {
    const v1 = async () => {
        if (!cache.has(KEY_MESSAGE_V1)) cache.set(KEY_MESSAGE_V1, hexToBytes(keccak256(await signMessage(KEY_MESSAGE_V1))));
        return cache.get(KEY_MESSAGE_V1);
    };
    return [await deriveSecret(signMessage, namespace), await v1()];
}

/** First secret that opens this note, or null — a note sealed by another wallet. */
export function unsealAny(namespace, path, encHex, secrets) {
    for (const s of secrets) {
        try { return unsealContent(namespace, path, encHex, s); } catch { /* next key */ }
    }
    return null;
}

// node src/crypto.js — self-check seal/unseal roundtrip + resourceId binding.
// Guard `process` so this whole block is inert (and never evaluated) in browsers.
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv?.[1]}`) {
    const assert = (await import("node:assert")).default;
    const secret = hexToBytes(keccak256(stringToBytes("test-secret")));
    const enc = sealContent("images", "logo.md", "the eagles are coming", secret);
    assert.equal(unsealContent("images", "logo.md", enc, secret), "the eagles are coming");
    assert.throws(() => unsealContent("images", "other.md", enc, secret), "wrong resourceId must reject");
    assert.throws(() => unsealContent("images", "logo.md", enc, hexToBytes(keccak256(stringToBytes("wrong")))), "wrong key must reject");
    // unsealAny: the right key second in the list is the v1-fallback case.
    const wrong = hexToBytes(keccak256(stringToBytes("wrong")));
    assert.equal(unsealAny("images", "logo.md", enc, [wrong, secret]), "the eagles are coming");
    assert.equal(unsealAny("images", "logo.md", enc, [wrong]), null, "no key must yield null, not throw");
    console.log("crypto.js self-check ok");
}

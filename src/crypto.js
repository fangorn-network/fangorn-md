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

let cachedSecret = null;

/**
 * Derive (and cache for the session) the 32-byte encryption secret from a wallet
 * signature. `signMessage` is an async fn returning the hex signature string.
 */
export async function deriveSecret(signMessage) {
    if (cachedSecret) return cachedSecret;
    const sig = await signMessage("fangornmd encryption key v1");
    cachedSecret = hexToBytes(keccak256(sig)); // 65-byte sig → 32-byte key
    return cachedSecret;
}
export const resetSecret = () => { cachedSecret = null; };

/** Plaintext → hex ciphertext, bound to (namespace, path). */
export function sealContent(namespace, path, content, secret) {
    return toHex(sealSelf(stringToBytes(content), secret, resourceId(namespace, path)));
}

/** Hex ciphertext → plaintext. Throws if key/resourceId don't match. */
export function unsealContent(namespace, path, encHex, secret) {
    return new TextDecoder().decode(unsealSelf(hexToBytes(encHex), secret, resourceId(namespace, path)));
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
    console.log("crypto.js self-check ok");
}

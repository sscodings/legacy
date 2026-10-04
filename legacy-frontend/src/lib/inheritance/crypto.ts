// Isomorphic crypto for the "sealed inheritance message" feature.
//
// Model: the heir derives an X25519 keypair from a deterministic wallet
// signature (personal_sign is RFC-6979 deterministic, so re-signing the same
// message always yields the same key). Only the heir can produce that
// signature, so only the heir can derive the private key and decrypt.
//
// The owner encrypts to the heir's derived PUBLIC key using an ephemeral
// X25519 keypair + XChaCha20-Poly1305 (an anonymous sealed box). The owner
// can write the message but can never read it back.

import { xchacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes, randomBytes, utf8ToBytes } from "@noble/hashes/utils";

export type KeyScheme = "wallet-signature" | "passkey-prf";

export interface SealedBundle {
  /** ephemeral X25519 public key (hex) */
  ephPub: string;
  /** XChaCha20 nonce (hex) */
  nonce: string;
  /** ciphertext incl. Poly1305 tag (hex) */
  ct: string;
}

/**
 * The canonical message the heir signs to derive their key. Deterministic in
 * (vault, heir) so the heir re-derives the same key on every unseal.
 * NOTE: This derivation is now CLIENT-SIDE ONLY. The signature must NEVER be sent to the server.
 */
export function buildDeriveMessage(vault: string, heir: string): string {
  return [
    "Legacy Protocol — Sealed Inheritance Key",
    `Vault: ${vault.toLowerCase()}`,
    `Heir: ${heir.toLowerCase()}`,
    "",
    "Sign to derive your private decryption key for this vault.",
    "This request is gasless and only proves control of your wallet.",
    "Signing the same request again always yields the same key.",
  ].join("\n");
}

/**
 * Signature binding message signed by the heir's wallet to authorize enrolling a public key.
 * Contains only the public key, scheme, vault, heir, and timestamp.
 */
export function buildEnrollProofMessage(params: {
  vault: string;
  heir: string;
  heirPublicKey: string;
  scheme: KeyScheme;
  issuedAt: number;
}): string {
  return [
    "Legacy Protocol — Enroll Heir Decryption Key",
    `Vault: ${params.vault.toLowerCase()}`,
    `Heir: ${params.heir.toLowerCase()}`,
    `Key Scheme: ${params.scheme}`,
    `Public Key: ${params.heirPublicKey.toLowerCase()}`,
    `Issued At: ${params.issuedAt}`,
    "",
    "Sign to bind this encryption key to your heir address.",
    "This does not expose your private key and requires no gas.",
  ].join("\n");
}

/**
 * Stable PRF salt for a given vault and heir pair.
 */
export function buildPrfSalt(vault: string, heir: string): Uint8Array {
  return sha256(utf8ToBytes(`legacy:v1:prf-salt:${vault.toLowerCase()}:${heir.toLowerCase()}`));
}

/**
 * Derive 32-byte X25519 private key from WebAuthn PRF output using HKDF-SHA256.
 */
export function derivePrivateKeyFromPrf(
  prfOutput: Uint8Array,
  vault: string,
  heir: string
): Uint8Array {
  const salt = buildPrfSalt(vault, heir);
  const info = utf8ToBytes("legacy:v1:passkey-encryption-key");
  return hkdf(sha256, prfOutput, salt, info, 32);
}

/**
 * Compute the hex-encoded X25519 public key corresponding to a private key.
 */
export function publicKeyFromPrivate(priv: Uint8Array): string {
  return bytesToHex(x25519.getPublicKey(priv));
}

/**
 * The message the owner signs to authenticate a seal. Binds the owner's
 * signature to this exact ciphertext via its digest.
 */
export function buildSealMessage(vault: string, heir: string, digest: string): string {
  return [
    "Legacy Protocol — Seal inheritance message",
    `Vault: ${vault.toLowerCase()}`,
    `Heir: ${heir.toLowerCase()}`,
    `Digest: ${digest}`,
  ].join("\n");
}

function signatureToBytes(signature: string): Uint8Array {
  const h = signature.startsWith("0x") ? signature.slice(2) : signature;
  return hexToBytes(h);
}

/**
 * Derive the 32-byte X25519 private key from a wallet signature.
 * NOTE: Client-side only! The signature must never be sent to the server.
 */
export function derivePrivateKey(signature: string): Uint8Array {
  return sha256(signatureToBytes(signature));
}

/**
 * Derive the heir's X25519 public key (hex) from their signature.
 * NOTE: Client-side only!
 */
export function publicKeyFromSignature(signature: string): string {
  return publicKeyFromPrivate(derivePrivateKey(signature));
}

/** Owner-side: encrypt arbitrary bytes to the heir's published public key. */
export function sealBytes(
  plaintext: Uint8Array,
  heirPublicKeyHex: string
): { ephPub: string; nonce: string; ciphertext: Uint8Array } {
  const heirPub = hexToBytes(heirPublicKeyHex);
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const shared = x25519.getSharedSecret(ephPriv, heirPub);
  const key = sha256(shared);
  const nonce = randomBytes(24);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return { ephPub: bytesToHex(ephPub), nonce: bytesToHex(nonce), ciphertext };
}

/** Heir-side: decrypt bytes sealed with {@link sealBytes} using the derived private key. */
export function unsealBytes(
  ephPubHex: string,
  nonceHex: string,
  ciphertext: Uint8Array,
  privKey: Uint8Array
): Uint8Array {
  const shared = x25519.getSharedSecret(privKey, hexToBytes(ephPubHex));
  const key = sha256(shared);
  return xchacha20poly1305(key, hexToBytes(nonceHex)).decrypt(ciphertext);
}

/** Owner-side: encrypt plaintext to the heir's published public key. */
export function sealMessage(plaintext: string, heirPublicKeyHex: string): SealedBundle {
  const { ephPub, nonce, ciphertext } = sealBytes(utf8ToBytes(plaintext), heirPublicKeyHex);
  return { ephPub, nonce, ct: bytesToHex(ciphertext) };
}

/** Heir-side: decrypt a sealed bundle with the derived private key. */
export function unsealMessage(bundle: SealedBundle, privKey: Uint8Array): string {
  const pt = unsealBytes(bundle.ephPub, bundle.nonce, hexToBytes(bundle.ct), privKey);
  return new TextDecoder().decode(pt);
}

/** Stable digest of a bundle, used to bind the owner's authenticating signature. */
export function digestBundle(bundle: SealedBundle): string {
  return bytesToHex(sha256(utf8ToBytes(`${bundle.ephPub}.${bundle.nonce}.${bundle.ct}`)));
}

/** Hex-encoded sha256 of arbitrary bytes (used to bind a signature to an off-chain blob). */
export function sha256Hex(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export interface SealedVideoMeta {
  /** ephemeral X25519 public key (hex) */
  ephPub: string;
  /** XChaCha20 nonce (hex) */
  nonce: string;
  /** URL of the encrypted video blob (ciphertext only; useless without the heir's key) */
  blobUrl: string;
  /** sha256 of the ciphertext bytes, hex — binds the owner's signature to this exact upload */
  ciphertextHash: string;
  mimeType: string;
  size: number;
}

/**
 * The message the owner signs to authenticate a sealed video. Binds the
 * signature to the specific blob (via its ciphertext hash) so the URL can't
 * be swapped after signing.
 */
export function buildSealVideoMessage(vault: string, heir: string, digest: string): string {
  return [
    "Legacy Protocol — Seal inheritance video",
    `Vault: ${vault.toLowerCase()}`,
    `Heir: ${heir.toLowerCase()}`,
    `Digest: ${digest}`,
  ].join("\n");
}

/** Stable digest of a sealed video's metadata, used to bind the owner's authenticating signature. */
export function digestVideoMeta(meta: Pick<SealedVideoMeta, "ephPub" | "nonce" | "blobUrl" | "ciphertextHash">): string {
  return bytesToHex(
    sha256(utf8ToBytes(`${meta.ephPub}.${meta.nonce}.${meta.blobUrl}.${meta.ciphertextHash}`))
  );
}

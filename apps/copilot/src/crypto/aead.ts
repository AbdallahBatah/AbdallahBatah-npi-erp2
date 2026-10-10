// AES-256-GCM authenticated encryption for small secrets (session tokens,
// redaction-map state) stored at rest in the copilot's own database.
//
// Token wire format: `v1.<iv>.<tag>.<ciphertext>`, every segment base64url
// (no padding), with a fresh random 12-byte IV on every call to encrypt().
// decrypt() throws on any tampering (of any of the three binary segments),
// a wrong key, or an unrecognized version tag — GCM's authentication tag
// covers the ciphertext, so a single flipped bit anywhere is rejected by
// Node's crypto module itself (`Unsupported state or unable to
// authenticate data`), not by any check written here.
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const KEY_LENGTH_BYTES = 32;
const VERSION = 'v1';

/**
 * Parse a hex-encoded 32-byte key. Throws a descriptive error that never
 * echoes the input value (the value is a secret key — logging it, even in
 * an error message, would defeat the point).
 */
export function parseKey(hex: string | undefined): Buffer {
  if (typeof hex !== 'string' || hex.length === 0) {
    throw new Error('AEAD key is missing or empty.');
  }
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(
      `AEAD key must be exactly 64 hex characters (32 bytes); got ${hex.length} characters.`,
    );
  }
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_LENGTH_BYTES) {
    // Unreachable given the regex above, but keep the invariant explicit.
    throw new Error('AEAD key did not decode to 32 bytes.');
  }
  return key;
}

function toBase64Url(buf: Buffer): string {
  return buf.toString('base64url');
}

function fromBase64Url(value: string): Buffer {
  return Buffer.from(value, 'base64url');
}

/** Encrypt `plaintext` with `key` (32 bytes). A fresh random IV is used every call. */
export function encrypt(plaintext: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`AEAD key must be 32 bytes; got ${key.length}.`);
  }
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, toBase64Url(iv), toBase64Url(tag), toBase64Url(ciphertext)].join('.');
}

/** Decrypt a token produced by encrypt(). Throws on tampering, wrong key, or a bad/unknown version. */
export function decrypt(token: string, key: Buffer): string {
  if (key.length !== KEY_LENGTH_BYTES) {
    throw new Error(`AEAD key must be 32 bytes; got ${key.length}.`);
  }
  const parts = token.split('.');
  if (parts.length !== 4) {
    throw new Error('Malformed AEAD token: expected 4 dot-separated segments.');
  }
  const [version, ivB64, tagB64, ciphertextB64] = parts;
  if (version !== VERSION) {
    throw new Error(`Unknown AEAD token version: "${version}".`);
  }

  let iv: Buffer;
  let tag: Buffer;
  let ciphertext: Buffer;
  try {
    iv = fromBase64Url(ivB64);
    tag = fromBase64Url(tagB64);
    ciphertext = fromBase64Url(ciphertextB64);
  } catch {
    throw new Error('Malformed AEAD token: could not decode base64url segment.');
  }

  if (iv.length !== IV_LENGTH_BYTES) {
    throw new Error('Malformed AEAD token: IV has the wrong length.');
  }

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  // Node's crypto module throws here on any tampering with ciphertext, tag,
  // IV, or a wrong key — GCM's authentication check is what actually
  // enforces "throws on tampering", not any logic in this file.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

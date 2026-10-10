import { parseKey, encrypt, decrypt } from '../src/crypto/aead';

const VALID_HEX = 'a'.repeat(64);

describe('parseKey', () => {
  it('parses a valid 64-hex-char key into a 32-byte buffer', () => {
    const key = parseKey(VALID_HEX);
    expect(key.length).toBe(32);
  });

  it('accepts uppercase hex', () => {
    const key = parseKey('A'.repeat(64));
    expect(key.length).toBe(32);
  });

  it('throws on undefined', () => {
    expect(() => parseKey(undefined)).toThrow();
  });

  it('throws on empty string', () => {
    expect(() => parseKey('')).toThrow();
  });

  it('throws on a key that is too short', () => {
    expect(() => parseKey('a'.repeat(63))).toThrow();
  });

  it('throws on a key that is too long', () => {
    expect(() => parseKey('a'.repeat(65))).toThrow();
  });

  it('throws on non-hex characters', () => {
    expect(() => parseKey('z'.repeat(64))).toThrow();
  });

  it('never echoes the invalid value in the thrown error message', () => {
    const secretLooking = 'deadbeef'.repeat(3); // too short, but distinctive
    try {
      parseKey(secretLooking);
      fail('expected parseKey to throw');
    } catch (err) {
      expect((err as Error).message).not.toContain(secretLooking);
    }
  });
});

describe('encrypt/decrypt round trip', () => {
  const key = parseKey(VALID_HEX);

  it('round-trips plain ASCII text', () => {
    const token = encrypt('hello world', key);
    expect(decrypt(token, key)).toBe('hello world');
  });

  it('round-trips Arabic text', () => {
    const plaintext = 'مرحباً بك في مَدار — هذا نص عربي كامل مع تشكيل وأرقام ١٢٣';
    const token = encrypt(plaintext, key);
    expect(decrypt(token, key)).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const token = encrypt('', key);
    expect(decrypt(token, key)).toBe('');
  });

  it('produces a token in the v1.<iv>.<tag>.<ciphertext> shape', () => {
    const token = encrypt('some secret', key);
    const parts = token.split('.');
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe('v1');
  });

  it('uses a different IV (and different token) on every call for the same plaintext', () => {
    const tokenA = encrypt('same plaintext', key);
    const tokenB = encrypt('same plaintext', key);
    expect(tokenA).not.toBe(tokenB);
    const ivA = tokenA.split('.')[1];
    const ivB = tokenB.split('.')[1];
    expect(ivA).not.toBe(ivB);
  });
});

describe('tamper detection', () => {
  const key = parseKey(VALID_HEX);

  function flipFirstChar(segment: string): string {
    // Flip the FIRST base64url character, not the last: the final character
    // of a base64url segment can encode trailing padding bits that
    // Buffer.from(..., 'base64url') ignores on decode, so a last-char flip
    // is not guaranteed to change the decoded bytes. The first character
    // always encodes real high-order bits of the first byte.
    const first = segment[0];
    const replacement = first === 'A' ? 'B' : 'A';
    return replacement + segment.slice(1);
  }

  it('rejects a tampered IV segment', () => {
    const token = encrypt('secret payload', key);
    const [version, iv, tag, ciphertext] = token.split('.');
    const tampered = [version, flipFirstChar(iv), tag, ciphertext].join('.');
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('rejects a tampered tag segment', () => {
    const token = encrypt('secret payload', key);
    const [version, iv, tag, ciphertext] = token.split('.');
    const tampered = [version, iv, flipFirstChar(tag), ciphertext].join('.');
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('rejects a tampered ciphertext segment', () => {
    const token = encrypt('secret payload', key);
    const [version, iv, tag, ciphertext] = token.split('.');
    const tampered = [version, iv, tag, flipFirstChar(ciphertext)].join('.');
    expect(() => decrypt(tampered, key)).toThrow();
  });

  it('rejects decryption with the wrong key', () => {
    const token = encrypt('secret payload', key);
    const wrongKey = parseKey('b'.repeat(64));
    expect(() => decrypt(token, wrongKey)).toThrow();
  });

  it('rejects an unknown version tag', () => {
    const token = encrypt('secret payload', key);
    const parts = token.split('.');
    parts[0] = 'v2';
    expect(() => decrypt(parts.join('.'), key)).toThrow();
  });

  it('rejects a malformed token (wrong number of segments)', () => {
    expect(() => decrypt('v1.onlytwo', key)).toThrow();
  });
});

describe('key length validation on encrypt/decrypt', () => {
  it('throws when encrypt is given a key that is not 32 bytes', () => {
    const badKey = Buffer.from('a'.repeat(31), 'hex').length === 0
      ? Buffer.alloc(16, 1)
      : Buffer.alloc(16, 1);
    expect(() => encrypt('x', badKey)).toThrow();
  });

  it('throws when decrypt is given a key that is not 32 bytes', () => {
    const key = parseKey(VALID_HEX);
    const token = encrypt('x', key);
    const badKey = Buffer.alloc(16, 1);
    expect(() => decrypt(token, badKey)).toThrow();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateToken, getTokenDisplayPrefix, hashToken, TOKEN_PREFIXES, TOKEN_SECRET_BYTES, verifyToken } from '../../apps/worker/auth/tokens';
import type { TokenKind } from '../../apps/worker/auth/tokens';

afterEach(() => vi.restoreAllMocks());

// Fixed independently calculated SHA-256 vectors over ASCII prefix + 43 'A's.
const vectors = [
  ['apiKey', 'e7738d8e3d28bce58ad716133015f26afcb8284e2856efb7a123868179d76f05'],
  ['session', '916a81e0032131e206a7a3a58815202fe9cf2dc7463963a11f7e4a2905cdf4ad'],
  ['invitation', '03c291bf375e1f34e3f98d023ac9185fbd0f6e427cb4e954f1583639233b6094'],
] as const;

describe('native Workers credential crypto', () => {
  it.each(vectors)('%s produces independently random 256-bit secrets', (kind) => {
    const tokens = Array.from({ length: 128 }, () => generateToken(kind));
    expect(new Set(tokens).size).toBe(tokens.length);
    const decoded = tokens.map((token) => {
      expect(token.startsWith(TOKEN_PREFIXES[kind])).toBe(true);
      const secret = token.slice(TOKEN_PREFIXES[kind].length);
      expect(secret).toHaveLength(43);
      const binary = atob(secret.replace(/-/g, '+').replace(/_/g, '/') + '=');
      expect(binary.length).toBe(32);
      return binary;
    });
    expect(TOKEN_SECRET_BYTES).toBe(32);
    // Detect fixed/padded byte regions, not a claim of cryptographic RNG certification.
    for (let index = 0; index < 32; index++) {
      expect(new Set(decoded.map((value) => value.charCodeAt(index))).size).toBeGreaterThan(1);
    }
  });

  it.each(vectors)('%s has stable, purpose-separated SHA-256 lookup hashes', async (kind, digest) => {
    const token = TOKEN_PREFIXES[kind] + 'A'.repeat(43);
    expect(await hashToken(kind, token)).toBe(digest);
    expect(await hashToken(kind, token)).toBe(digest);
    expect(await verifyToken(kind, token, digest)).toBe(true);
    expect(getTokenDisplayPrefix(kind, token)).toBe(TOKEN_PREFIXES[kind] + 'A'.repeat(8));
    expect(getTokenDisplayPrefix(kind, token)).not.toBe(token);
  });

  it('rejects another secret and digest mutations at either end', async () => {
    const token = generateToken('apiKey');
    const digest = await hashToken('apiKey', token);
    expect(await verifyToken('apiKey', generateToken('apiKey'), digest)).toBe(false);
    const flip = (char: string) => char === '0' ? '1' : '0';
    expect(await verifyToken('apiKey', token, flip(digest[0]!) + digest.slice(1))).toBe(false);
    expect(await verifyToken('apiKey', token, digest.slice(0, -1) + flip(digest.at(-1)!))).toBe(false);
  });

  it('rejects cross-purpose use even with the valid hash of that credential', async () => {
    const token = generateToken('session');
    const digest = await hashToken('session', token);
    expect(await verifyToken('apiKey', token, digest)).toBe(false);
    await expect(hashToken('invitation', token)).rejects.toThrow('Invalid token format');
  });

  const canonical = 's2a_key_' + 'A'.repeat(43);
  it.each([
    '', null, 42, {}, canonical + '=', canonical + '\n', ' ' + canonical,
    canonical.slice(0, -1), canonical + 'A', canonical.slice(0, -1) + 'B',
    canonical.slice(0, -1) + '/', canonical.slice(0, -1) + '+',
    canonical.slice(0, -1) + 'Ａ', 'S2A_key_' + 'A'.repeat(43),
  ])('fails closed on malformed token (%j)', async (token) => {
    expect(await verifyToken('apiKey', token, vectors[0][1])).toBe(false);
    await expect(hashToken('apiKey', token as string)).rejects.toThrow('Invalid token format');
    expect(() => getTokenDisplayPrefix('apiKey', token as string)).toThrow('Invalid token format');
  });

  it.each(['', null, {}, 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), vectors[0][1].toUpperCase(), vectors[0][1] + '\n'])(
    'rejects malformed stored digest (%j)', async (digest) => {
      expect(await verifyToken('apiKey', canonical, digest)).toBe(false);
    },
  );

  it.each(['', 'password', '__proto__', 'toString', null, 32])('rejects invalid purpose (%j)', async (kind) => {
    expect(() => generateToken(kind as TokenKind)).toThrow('Invalid token kind');
    await expect(hashToken(kind as TokenKind, canonical)).rejects.toThrow('Invalid token kind');
    await expect(verifyToken(kind as TokenKind, canonical, vectors[0][1])).rejects.toThrow('Invalid token kind');
  });

  it('never logs credentials during generation, lookup or failed verification', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'info'] as const)
      .map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
    const token = generateToken('invitation');
    const digest = await hashToken('invitation', token);
    await verifyToken('invitation', token, digest);
    await verifyToken('invitation', token + 'invalid', digest);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

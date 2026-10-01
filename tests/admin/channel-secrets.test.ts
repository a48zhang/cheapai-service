import { describe, expect, it } from 'vitest';
import { ChannelSecretError, decryptChannelSecret, encryptChannelSecret } from '../../apps/worker/admin/channel-secrets';

// Synthetic keys only; run in the Workers project using native WebCrypto.
const key = new Uint8Array(32).fill(17);
const olderKey = new Uint8Array(32).fill(29);
const keyring = new Map([['v2', key], ['v1', olderKey]]);
const channelId = 'channel-test-1';
const secret = 'test-only-upstream-key-示例';

describe('channel secret AES-256-GCM', () => {
  it('round trips with an explicit version and a fresh 96-bit nonce', async () => {
    const first = await encryptChannelSecret(secret, channelId, 'v2', key);
    const second = await encryptChannelSecret(secret, channelId, 'v2', key);
    const envelope = JSON.parse(first);
    expect(envelope).toEqual({
      algorithm: 'A256GCM', format_version: 1, key_version: 'v2',
      nonce: expect.stringMatching(/^[A-Za-z0-9_-]{16}$/), ciphertext: expect.any(String),
    });
    expect(first).not.toContain(secret);
    expect(JSON.parse(second).nonce).not.toBe(envelope.nonce);
    expect(JSON.parse(second).ciphertext).not.toBe(envelope.ciphertext);
    expect(await decryptChannelSecret(first, channelId, keyring)).toBe(secret);
  });

  it('decrypts retained old versions and rejects removed versions', async () => {
    const encrypted = await encryptChannelSecret(secret, channelId, 'v1', olderKey);
    expect(await decryptChannelSecret(encrypted, channelId, keyring)).toBe(secret);
    await expect(decryptChannelSecret(encrypted, channelId, new Map([['v2', key]]))).rejects.toThrow(ChannelSecretError);
  });

  it('preserves a leading Unicode BOM in the original plaintext', async () => {
    const plaintext = '\uFEFFtest-only-key';
    const encrypted = await encryptChannelSecret(plaintext, channelId, 'v2', key);
    expect(await decryptChannelSecret(encrypted, channelId, keyring)).toBe(plaintext);
  });

  it('rejects a different channel and a wrong key', async () => {
    const encrypted = await encryptChannelSecret(secret, channelId, 'v2', key);
    await expect(decryptChannelSecret(encrypted, 'channel-test-2', keyring)).rejects.toThrow(ChannelSecretError);
    await expect(decryptChannelSecret(encrypted, channelId, new Map([['v2', olderKey]]))).rejects.toThrow(ChannelSecretError);
  });

  it('authenticates the version even when both labels resolve to identical key bytes', async () => {
    const envelope = JSON.parse(await encryptChannelSecret(secret, channelId, 'v2', key));
    envelope.key_version = 'v3';
    await expect(decryptChannelSecret(JSON.stringify(envelope), channelId, new Map([['v3', key]])))
      .rejects.toThrow(ChannelSecretError);
  });

  it.each(['nonce', 'ciphertext'])('rejects tampered %s', async (field) => {
    const envelope = JSON.parse(await encryptChannelSecret(secret, channelId, 'v2', key));
    envelope[field] = (envelope[field][0] === 'A' ? 'B' : 'A') + envelope[field].slice(1);
    await expect(decryptChannelSecret(JSON.stringify(envelope), channelId, keyring)).rejects.toThrow(ChannelSecretError);
  });

  it.each([0, 16, 24, 31, 33])('rejects %i-byte encryption and decryption keys', async (length) => {
    const invalid = new Uint8Array(length);
    await expect(encryptChannelSecret(secret, channelId, 'v2', invalid)).rejects.toThrow(ChannelSecretError);
    const encrypted = await encryptChannelSecret(secret, channelId, 'v2', key);
    await expect(decryptChannelSecret(encrypted, channelId, new Map([['v2', invalid]]))).rejects.toThrow(ChannelSecretError);
  });

  it.each(['', ' ', 'v 1', '../v1', 'v1\n', 'v'.repeat(65)])('rejects illegal key version %j', async (version) => {
    await expect(encryptChannelSecret(secret, channelId, version, key)).rejects.toThrow(ChannelSecretError);
    const envelope = JSON.parse(await encryptChannelSecret(secret, channelId, 'v2', key));
    envelope.key_version = version;
    await expect(decryptChannelSecret(JSON.stringify(envelope), channelId, keyring)).rejects.toThrow(ChannelSecretError);
  });

  it.each(['', ' ', ' channel', 'channel\n'])('rejects invalid channel ID %j', async (id) => {
    await expect(encryptChannelSecret(secret, id, 'v2', key)).rejects.toThrow(ChannelSecretError);
  });

  it('rejects empty plaintext', async () => {
    await expect(encryptChannelSecret('', channelId, 'v2', key)).rejects.toThrow(ChannelSecretError);
  });

  it.each([
    { algorithm: 'AES-CBC' }, { format_version: 2 }, { nonce: 'abc' },
    { nonce: '!!!!!!!!!!!!!!!!' }, { ciphertext: 'AA' }, { ciphertext: 'abc=' },
    { plaintext: secret },
  ])('rejects malformed envelope %# without revealing details', async (changes) => {
    const envelope = JSON.parse(await encryptChannelSecret(secret, channelId, 'v2', key));
    Object.assign(envelope, changes);
    await expect(decryptChannelSecret(JSON.stringify(envelope), channelId, keyring))
      .rejects.toThrow('Channel secret operation failed.');
  });

  it.each(['not JSON', 'null', '[]', '{}', '"secret"'])('rejects invalid serialization %s', async (encrypted) => {
    await expect(decryptChannelSecret(encrypted, channelId, keyring)).rejects.toThrow(ChannelSecretError);
  });
});

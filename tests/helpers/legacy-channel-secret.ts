/** Historical migration fixtures need an envelope shape, not live encryption code. */
export function legacyChannelSecret(keyVersion = 'test-v1'): string {
  return JSON.stringify({
    algorithm: 'A256GCM',
    format_version: 1,
    key_version: keyVersion,
    nonce: 'legacy-test-nonce',
    ciphertext: 'legacy-test-ciphertext',
  });
}

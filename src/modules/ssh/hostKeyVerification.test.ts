import { describe, expect, it } from 'vitest';

import { extractUnknownHostFingerprint } from './hostKeyVerification';

describe('extractUnknownHostFingerprint', () => {
  it('extracts a SHA-256 fingerprint from a backend rejection', () => {
    expect(
      extractUnknownHostFingerprint('SSH_UNKNOWN_HOST_KEY:SHA256:abc+/123='),
    ).toBe('SHA256:abc+/123=');
  });

  it('ignores unrelated SSH errors', () => {
    expect(extractUnknownHostFingerprint('SSH 主机密钥已变更，拒绝连接')).toBeNull();
  });
});

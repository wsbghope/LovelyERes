import { describe, expect, it } from 'vitest';

import {
  isSafeLinuxUsername,
  isSafeEnvName,
  isSafeKernelModule,
  isSafeKubernetesIdentifier,
  isSafeNetworkAddress,
  isSafeNetworkCidr,
  isSafeNetworkLabel,
  isSafePackageName,
  isSafePid,
  isSafePort,
  isSafeSystemdUnit,
  shellQuote,
} from './shellSafety';

describe('shellSafety', () => {
  it('quotes POSIX shell arguments containing apostrophes', () => {
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });

  it('accepts ordinary Linux usernames and rejects shell syntax', () => {
    expect(isSafeLinuxUsername('www-data')).toBe(true);
    expect(isSafeLinuxUsername('ops.user')).toBe(true);
    expect(isSafeLinuxUsername('root;id')).toBe(false);
    expect(isSafeLinuxUsername('$(id)')).toBe(false);
  });

  it('accepts numeric network addresses and rejects command separators', () => {
    expect(isSafeNetworkAddress('192.168.1.10')).toBe(true);
    expect(isSafeNetworkAddress('fe80::1%eth0')).toBe(true);
    expect(isSafeNetworkAddress('127.0.0.1;id')).toBe(false);
    expect(isSafeNetworkCidr('10.0.0.0/8')).toBe(true);
    expect(isSafeNetworkCidr('::/0')).toBe(true);
    expect(isSafeNetworkCidr('10.0.0.1 $(id)')).toBe(false);
  });

  it('validates ports and protocol/state labels', () => {
    expect(isSafePort('22')).toBe(true);
    expect(isSafePort('65535')).toBe(true);
    expect(isSafePort('65536')).toBe(false);
    expect(isSafePort('22;id')).toBe(false);
    expect(isSafeNetworkLabel('ESTABLISHED')).toBe(true);
    expect(isSafeNetworkLabel('ESTABLISHED;id')).toBe(false);
  });

  it('validates remote identifiers used in command templates', () => {
    expect(isSafePid('1234')).toBe(true);
    expect(isSafePid('0;id')).toBe(false);
    expect(isSafeSystemdUnit('sshd@prod.service')).toBe(true);
    expect(isSafeSystemdUnit('sshd.service;id')).toBe(false);
    expect(isSafeKernelModule('nf_conntrack')).toBe(true);
    expect(isSafeKernelModule('x;id')).toBe(false);
    expect(isSafePackageName('libssl3:amd64')).toBe(true);
    expect(isSafePackageName('pkg$(id)')).toBe(false);
    expect(isSafeEnvName('LD_PRELOAD')).toBe(true);
    expect(isSafeEnvName('LD_PRELOAD;id')).toBe(false);
    expect(isSafeKubernetesIdentifier('nginx-deploy.v1')).toBe(true);
    expect(isSafeKubernetesIdentifier('nginx;id')).toBe(false);
  });
});

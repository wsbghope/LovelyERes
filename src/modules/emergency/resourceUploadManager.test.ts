import { describe, expect, it } from 'vitest';

import {
  filterResourceTools,
  summarizeResourceSelection,
  type ResourceTool,
} from './resourceUploadManager';

const tool = (overrides: Partial<ResourceTool>): ResourceTool => ({
  key: 'official:v2026.08.01:x86_64:tcpdump',
  name: 'tcpdump',
  provider: 'tcpdump',
  architecture: 'x86_64',
  source: 'official',
  version: 'v2026.08.01',
  category: '网络诊断',
  description: '捕获和分析网络数据包',
  size: 1,
  sha256: 'a'.repeat(64),
  verified: true,
  systemPath: null,
  deployedPaths: [],
  warning: null,
  ...overrides,
});

describe('resource upload selection policy', () => {
  it('finds BusyBox applets by logical name and provider', () => {
    const tools = [
      tool({ name: 'wget', provider: 'busybox', description: '下载文件' }),
      tool({ name: 'curl', provider: 'curl' }),
    ];

    expect(filterResourceTools(tools, 'wget').map(item => item.name)).toEqual(['wget']);
    expect(filterResourceTools(tools, 'BUSYBOX').map(item => item.name)).toEqual(['wget']);
  });

  it('reports existing commands and mismatched architectures without removing them', () => {
    const selected = [
      tool({ name: 'tcpdump', systemPath: '/usr/bin/tcpdump' }),
      tool({ name: 'curl', architecture: 'aarch64' }),
    ];

    expect(summarizeResourceSelection(selected, 'x86_64')).toEqual({
      existingCount: 1,
      mismatchCount: 1,
    });
    expect(selected).toHaveLength(2);
  });
});

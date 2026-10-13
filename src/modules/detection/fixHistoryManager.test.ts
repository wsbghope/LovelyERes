import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { fixHistoryManager } from './fixHistoryManager';
import { sshConnectionManager } from '../remote/sshConnectionManager';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('../remote/sshConnectionManager', () => ({
  sshConnectionManager: { getConnectionStatus: vi.fn() },
}));

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  });
  fixHistoryManager.clear();
  vi.mocked(invoke).mockReset();
  vi.mocked(sshConnectionManager.getConnectionStatus).mockReturnValue({
    host: 'other.test', port: 22, username: 'root', connected: true,
  });
});

describe('fix rollback', () => {
  it('never executes a restore command against another server', async () => {
    const entry = fixHistoryManager.addEntry({
      detectionItemId: 'ssh-audit', findingTitle: 'SSH', fixTitle: 'SSH', type: 'baseline',
      output: '', success: true, server: 'root@example.test:22',
      restoreCommand: 'cp backup original',
    });
    expect((await fixHistoryManager.rollback(entry.id)).success).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps the entry available when the remote rollback fails', async () => {
    vi.mocked(sshConnectionManager.getConnectionStatus).mockReturnValue({
      host: 'example.test', port: 22, username: 'root', connected: true,
    });
    vi.mocked(invoke).mockResolvedValue({ exit_code: 1, output: 'permission denied' });
    const entry = fixHistoryManager.addEntry({
      detectionItemId: 'ssh-audit', findingTitle: 'SSH', fixTitle: 'SSH', type: 'baseline',
      output: '', success: true, server: 'root@example.test:22',
      restoreCommand: 'cp backup original',
    });
    expect((await fixHistoryManager.rollback(entry.id)).success).toBe(false);
    expect(fixHistoryManager.getHistory()[0].rolledBack).toBe(false);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { forensicManager, type ForensicSnapshot } from './forensicManager';
import { executeEmergencyCommand } from './commandExecution';
import { sshConnectionManager } from '../remote/sshConnectionManager';

vi.mock('./commandExecution', () => ({
  executeEmergencyCommand: vi.fn(),
  formatCommandResult: vi.fn(() => 'failed'),
}));
vi.mock('../remote/sshConnectionManager', () => ({
  sshConnectionManager: { getConnectionStatus: vi.fn() },
}));

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
  forensicManager.clearSnapshots();
  vi.mocked(sshConnectionManager.getConnectionStatus).mockReturnValue({
    host: 'example.test', port: 22, username: 'root', connected: true,
  });
  vi.mocked(executeEmergencyCommand).mockReset();
});

describe('forensic snapshot', () => {
  it('aborts before mixing data from another server', async () => {
    vi.mocked(executeEmergencyCommand).mockImplementation(async () => {
      vi.mocked(sshConnectionManager.getConnectionStatus).mockReturnValue({
        host: 'other.test', port: 22, username: 'root', connected: true,
      });
      return { success: true, output: 'first' } as Awaited<ReturnType<typeof executeEmergencyCommand>>;
    });

    await expect(forensicManager.captureSnapshot('root@example.test:22'))
      .rejects.toThrow('服务器连接已切换');
    expect(executeEmergencyCommand).toHaveBeenCalledTimes(1);
    expect(forensicManager.getSnapshots()).toHaveLength(0);
  });

  it('does not save a snapshot if the server switches after the last command', async () => {
    let count = 0;
    vi.mocked(executeEmergencyCommand).mockImplementation(async () => {
      count++;
      if (count === 12) {
        vi.mocked(sshConnectionManager.getConnectionStatus).mockReturnValue({
          host: 'other.test', port: 22, username: 'root', connected: true,
        });
      }
      return { success: true, output: 'sample' } as Awaited<ReturnType<typeof executeEmergencyCommand>>;
    });

    await expect(forensicManager.captureSnapshot('root@example.test:22'))
      .rejects.toThrow('服务器连接已切换');
    expect(count).toBe(12);
    expect(forensicManager.getSnapshots()).toHaveLength(0);
  });

  it('compares and deletes snapshots', () => {
    const data = { processes: 'old\nsame', networkConnections: 'same' } as ForensicSnapshot['data'];
    const older = { id: 'old', timestamp: new Date(), server: 'root@example.test:22', data };
    const newer = { ...older, id: 'new', data: { ...data, processes: 'new\nsame' } };
    expect(forensicManager.diffSnapshots(older, newer).processes).toEqual({
      added: ['new'], removed: ['old'],
    });
    forensicManager.deleteSnapshot('old');
    expect(forensicManager.getSnapshots()).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { fixExecutor, type FixAction, type ResolvedBaselineItem } from './fixExecutor';
import { fixHistoryManager } from './fixHistoryManager';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('./fixHistoryManager', () => ({
  fixHistoryManager: { addEntry: vi.fn(), rollback: vi.fn() },
}));

beforeEach(() => {
  vi.mocked(invoke).mockReset();
  vi.mocked(fixHistoryManager.addEntry).mockReset();
  vi.mocked(invoke).mockResolvedValue({ exit_code: 0, output: 'ok' });
  fixExecutor.setServer('root@example.test:22');
});

describe('baseline fix', () => {
  it('backs up the edited file and records a real restore command', async () => {
    const action = {
      id: 'a', detectionItemId: 'ssh-audit', findingTitle: 'SSH', status: 'pending',
      def: { type: 'baseline', title: '禁用 root 登录', baselineItemId: 'ssh-root', priority: 1 },
    } as FixAction;
    const baseline: ResolvedBaselineItem = {
      id: 'ssh-root', filePath: '/etc/ssh/sshd_config', readCommand: 'read',
      writeCommand: () => 'write', parseRegex: '(ok)', backupCommand: 'old backup',
      recommendedValue: 'no', restartCommand: 'restart',
    };

    expect((await fixExecutor.executeFix(action, baseline)).success).toBe(true);
    const commands = vi.mocked(invoke).mock.calls.map(([, args]) => (args as { command: string }).command);
    expect(commands[1]).toContain('cp -p --');
    expect(commands[1]).toContain('/etc/ssh/sshd_config');
    const entry = vi.mocked(fixHistoryManager.addEntry).mock.calls[0][0];
    expect(entry.restoreCommand).toContain('cp -p --');
    expect(entry.restoreCommand).toContain('restart');
    expect(entry.restoreCommand).not.toContain('backup exists');
  });

  it('does not claim success when the remote write exits with an error', async () => {
    vi.mocked(invoke).mockImplementation(async (_command, args) =>
      (args as { command: string }).command === 'write'
        ? { exit_code: 1, output: 'permission denied' }
        : { exit_code: 0, output: 'ok' });
    const action = {
      id: 'a', detectionItemId: 'ssh-audit', findingTitle: 'SSH', status: 'pending',
      def: { type: 'baseline', title: '禁用 root 登录', baselineItemId: 'ssh-root', priority: 1 },
    } as FixAction;
    const baseline: ResolvedBaselineItem = {
      id: 'ssh-root', filePath: '/etc/ssh/sshd_config', readCommand: 'read',
      writeCommand: () => 'write', parseRegex: '(ok)', backupCommand: 'old backup',
      recommendedValue: 'no',
    };

    expect((await fixExecutor.executeFix(action, baseline)).success).toBe(false);
    expect(vi.mocked(fixHistoryManager.addEntry).mock.calls[0][0].restoreCommand).toContain('cp -p --');
  });
});

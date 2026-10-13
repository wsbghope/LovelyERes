import { describe, expect, it, vi } from 'vitest';
import { SftpManager, type SftpFileInfo } from './sftpManager';

describe('SftpManager displayed file indices', () => {
  it('resolves clicks and actions against the current sort order', async () => {
    const manager = new SftpManager();
    const files: SftpFileInfo[] = [
      { name: 'alpha', path: '/alpha', file_type: 'file', size: 1, permissions: '644' },
      { name: 'zulu', path: '/zulu', file_type: 'file', size: 2, permissions: '644' },
    ];
    (manager as unknown as { fileList: SftpFileInfo[] }).fileList = files;
    manager.setSortMode('name-desc');

    expect(manager.getFileByIndex(0)).toBe(files[1]);
    const click = vi.spyOn(manager as unknown as { handleFileClick: (file: SftpFileInfo) => Promise<void> }, 'handleFileClick')
      .mockResolvedValue();
    await manager.handleFileClickByIndex(0);
    expect(click).toHaveBeenCalledWith(files[1]);
  });
});

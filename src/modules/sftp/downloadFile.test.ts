import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { downloadSftpFile } from './downloadFile';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: vi.fn() }));

const file = { name: 'report.txt', path: '/var/log/report.txt', file_type: 'file' };

describe('downloadSftpFile', () => {
  const notify = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('downloads the selected file to the chosen local path', async () => {
    vi.mocked(save).mockResolvedValue('/tmp/report.txt');
    vi.mocked(invoke).mockResolvedValue(undefined);

    await downloadSftpFile(file, notify);

    expect(save).toHaveBeenCalledWith({ defaultPath: 'report.txt' });
    expect(invoke).toHaveBeenCalledWith('sftp_download', {
      remotePath: '/var/log/report.txt',
      localPath: '/tmp/report.txt',
    });
    expect(notify).toHaveBeenLastCalledWith('文件下载成功: report.txt', 'success');
  });

  it('does not download when the save dialog is cancelled', async () => {
    vi.mocked(save).mockResolvedValue(null);

    await downloadSftpFile(file, notify);

    expect(invoke).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it('rejects directories before opening the save dialog', async () => {
    await downloadSftpFile({ ...file, file_type: 'directory' }, notify);

    expect(save).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('不能下载目录，请选择文件', 'warning');
  });
});

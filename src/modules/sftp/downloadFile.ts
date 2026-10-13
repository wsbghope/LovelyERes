import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';

export interface DownloadableFile {
  name: string;
  path: string;
  file_type: string;
}

export type DownloadNotificationType = 'info' | 'success' | 'warning' | 'error';

export async function downloadSftpFile(
  file: DownloadableFile,
  notify: (message: string, type: DownloadNotificationType) => void,
): Promise<void> {
  if (file.file_type === 'directory') {
    notify('不能下载目录，请选择文件', 'warning');
    return;
  }

  try {
    const localPath = await save({ defaultPath: file.name });
    if (!localPath) return;

    notify(`开始下载: ${file.name}`, 'info');
    await invoke('sftp_download', { remotePath: file.path, localPath });
    notify(`文件下载成功: ${file.name}`, 'success');
  } catch (error) {
    console.error('下载文件失败:', error);
    notify(`下载文件失败: ${error}`, 'error');
  }
}

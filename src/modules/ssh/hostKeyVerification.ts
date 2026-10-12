import { invoke } from '@tauri-apps/api/core';

import { showConfirm } from '../ui/confirmDialog';

const UNKNOWN_HOST_KEY_PREFIX = 'SSH_UNKNOWN_HOST_KEY:';

export function extractUnknownHostFingerprint(error: unknown): string | null {
  const message = String(error ?? '');
  const index = message.indexOf(UNKNOWN_HOST_KEY_PREFIX);
  if (index < 0) return null;

  const fingerprint = message
    .slice(index + UNKNOWN_HOST_KEY_PREFIX.length)
    .split(/\s/)[0]
    ?.trim();
  return fingerprint || null;
}

export async function invokeWithHostKeyConfirmation<T>(
  command: 'ssh_connect_direct' | 'ssh_test_connection',
  args: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    const fingerprint = extractUnknownHostFingerprint(error);
    if (!fingerprint) throw error;

    const host = String(args.host || '');
    const port = Number(args.port || 22);
    const confirmed = await showConfirm({
      title: '确认 SSH 主机指纹',
      description: '首次连接的主机尚未记录在 known_hosts 中',
      message: `主机：${host}:${port}\nSHA-256 指纹：${fingerprint}\n\n请通过可信渠道核对指纹。确认后将保存此主机密钥。`,
      confirmText: '指纹一致，继续',
      cancelText: '取消连接',
    });
    if (!confirmed) {
      throw new Error('已取消连接：SSH 主机指纹未确认');
    }

    return invoke<T>(command, {
      ...args,
      expectedFingerprint: fingerprint,
    });
  }
}

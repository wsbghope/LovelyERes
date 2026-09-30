/**
 * SSH密钥右键菜单管理器
 */

import * as IconPark from '@icon-park/svg'
import { BaseContextMenu, type MenuAction } from './contextMenu/baseContextMenu'
import { isSafeLinuxUsername, shellQuote } from '../utils/shellSafety'

export class SSHKeyContextMenu extends BaseContextMenu {
  private currentKey: any = {}

  constructor() {
    super('sshkey')
  }

  protected onShowContextMenu(keyInfo: any) {
    this.currentKey = keyInfo
  }

  protected async handleSpecialAction(action: string): Promise<boolean> {
    if (action === 'copy-key') {
      try {
        await navigator.clipboard.writeText(this.currentKey.keyContent || '')
        ;window.showNotification?.('密钥内容已复制', 'success')
      } catch { /* ignore */ }
      return true
    }
    if (action === 'copy-fingerprint') {
      try {
        await navigator.clipboard.writeText(`${this.currentKey.keyType} ${this.currentKey.keyContent}`)
        ;window.showNotification?.('密钥指纹已复制', 'success')
      } catch { /* ignore */ }
      return true
    }
    return false
  }

  protected getMenuItemsHTML(): string {
    return `
      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Info({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>密钥信息</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="view-authorized-keys">
            <span class="menu-label">
              ${IconPark.FileText({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看authorized_keys</span>
            </span>
          </div>
          <div class="menu-item" data-action="key-fingerprint">
            <span class="menu-label">
              ${IconPark.IdCard({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>密钥指纹</span>
            </span>
          </div>
          <div class="menu-item" data-action="copy-key">
            <span class="menu-label">
              ${IconPark.Copy({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>复制密钥内容</span>
            </span>
          </div>
          <div class="menu-item" data-action="copy-fingerprint">
            <span class="menu-label">
              ${IconPark.Copy({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>复制密钥指纹</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Shield({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>安全检查</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="check-permissions">
            <span class="menu-label">
              ${IconPark.Lock({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查文件权限</span>
            </span>
          </div>
          <div class="menu-item" data-action="check-ssh-dir">
            <span class="menu-label">
              ${IconPark.FolderOpen({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查.ssh目录权限</span>
            </span>
          </div>
          <div class="menu-item" data-action="check-key-age">
            <span class="menu-label">
              ${IconPark.Time({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查密钥创建时间</span>
            </span>
          </div>
          <div class="menu-item" data-action="all-user-keys">
            <span class="menu-label">
              ${IconPark.Peoples({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>列出该用户所有密钥</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-divider"></div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Caution({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>应急操作</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="backup-keys">
            <span class="menu-label">
              ${IconPark.Save({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>备份authorized_keys</span>
            </span>
          </div>
          <div class="menu-item" data-action="disable-key-auth">
            <span class="menu-label">
              ${IconPark.CloseOne({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看sshd密钥认证配置</span>
            </span>
          </div>
        </div>
      </div>
    `
  }

  protected resolveAction(action: string): MenuAction | null {
    const key = this.currentKey
    const user = key.user || 'root'
    const file = key.file || ''
    if (!isSafeLinuxUsername(user) || !file) {
      this.showModal('错误', 'SSH 密钥记录无效，已拒绝执行远端命令')
      return null
    }
    const quotedFile = shellQuote(file)
    const quotedKey = shellQuote(`${key.keyType || ''} ${key.keyContent || ''} ${key.comment || ''}`.trim())

    const actions: Record<string, MenuAction> = {
      'view-authorized-keys': {
        command: `cat -- ${quotedFile} 2>/dev/null || echo '文件不存在或无权限'`,
        title: `SSH授权密钥 - ${user}`,
        actionName: '查看authorized_keys'
      },
      'key-fingerprint': {
        command: `printf '%s\n' ${quotedKey} | ssh-keygen -l -f - 2>/dev/null || echo '无法计算指纹'`,
        title: `密钥指纹 - ${user}`,
        actionName: '查看密钥指纹'
      },
      'check-permissions': {
        command: `ls -la -- ${quotedFile} && echo '---' && stat -- ${quotedFile}`,
        title: `文件权限 - ${file}`,
        actionName: '检查文件权限'
      },
      'check-ssh-dir': {
        command: `dir=$(dirname -- ${quotedFile}) && ls -la -- "$dir" && echo '---' && stat -- "$dir"`,
        title: `.ssh目录权限 - ${user}`,
        actionName: '检查.ssh目录权限'
      },
      'check-key-age': {
        command: `stat -c '%y %n' -- ${quotedFile} && echo '---' && dir=$(dirname -- ${quotedFile}) && find "$dir" -name '*.pub' -exec stat -c '%y %n' {} \\;`,
        title: `密钥时间 - ${user}`,
        actionName: '检查密钥创建时间'
      },
      'all-user-keys': {
        command: `cat -- ${quotedFile} 2>/dev/null | awk '{print NR": "$1" "$NF}' && echo '---总计:' && wc -l < ${quotedFile}`,
        title: `${user} 的所有密钥`,
        actionName: '列出用户所有密钥'
      },
      'backup-keys': {
        command: `backup=${quotedFile}.bak.$(date +%Y%m%d%H%M%S) && cp -- ${quotedFile} "$backup" && printf '✓ 已备份到 %s\n' "$backup"`,
        title: `备份密钥 - ${user}`,
        actionName: '备份authorized_keys'
      },
      'disable-key-auth': {
        command: `grep -i 'PubkeyAuthentication\\|AuthorizedKeysFile' /etc/ssh/sshd_config`,
        title: 'SSH密钥认证配置',
        actionName: '查看sshd密钥认证配置'
      }
    }

    return actions[action] || null
  }
}

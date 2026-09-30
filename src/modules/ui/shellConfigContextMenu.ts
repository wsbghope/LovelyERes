/**
 * Shell配置右键菜单管理器
 */

import * as IconPark from '@icon-park/svg'
import { BaseContextMenu, type MenuAction } from './contextMenu/baseContextMenu'
import { shellQuote } from '../utils/shellSafety'

export class ShellConfigContextMenu extends BaseContextMenu {
  private currentConfig: any = {}

  constructor() {
    super('shellconfig')
  }

  protected onShowContextMenu(config: any) {
    this.currentConfig = config
  }

  protected async handleSpecialAction(action: string): Promise<boolean> {
    if (action === 'copy-content') {
      try {
        await navigator.clipboard.writeText(this.currentConfig.content || '')
        ;window.showNotification?.('内容已复制', 'success')
      } catch { /* ignore */ }
      return true
    }
    return false
  }

  protected getMenuItemsHTML(): string {
    return `
      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.FileText({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>文件查看</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="view-context">
            <span class="menu-label">
              ${IconPark.AlignTextLeft({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看上下文(±5行)</span>
            </span>
          </div>
          <div class="menu-item" data-action="view-full-file">
            <span class="menu-label">
              ${IconPark.FullScreen({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看完整文件</span>
            </span>
          </div>
          <div class="menu-item" data-action="copy-content">
            <span class="menu-label">
              ${IconPark.Copy({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>复制可疑行内容</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Shield({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>安全分析</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="file-permissions">
            <span class="menu-label">
              ${IconPark.Lock({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查文件权限</span>
            </span>
          </div>
          <div class="menu-item" data-action="file-history">
            <span class="menu-label">
              ${IconPark.Time({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>文件修改历史</span>
            </span>
          </div>
          <div class="menu-item" data-action="all-suspicious">
            <span class="menu-label">
              ${IconPark.Search({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>全文搜索可疑关键字</span>
            </span>
          </div>
          <div class="menu-item" data-action="check-owner">
            <span class="menu-label">
              ${IconPark.User({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查文件归属</span>
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
          <div class="menu-item" data-action="comment-line">
            <span class="menu-label">
              ${IconPark.Code({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>注释掉此行</span>
            </span>
          </div>
          <div class="menu-item" data-action="backup-file">
            <span class="menu-label">
              ${IconPark.Save({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>备份配置文件</span>
            </span>
          </div>
        </div>
      </div>
    `
  }

  protected resolveAction(action: string): MenuAction | null {
    const cfg = this.currentConfig
    const file = cfg.file || ''
    const parsedLineNum = Number(cfg.lineNum)
    const lineNum = Number.isSafeInteger(parsedLineNum) && parsedLineNum > 0 ? parsedLineNum : 1
    if (!file) return null
    const quotedFile = shellQuote(file)

    const actions: Record<string, MenuAction> = {
      'view-context': {
        command: `awk 'NR>=${Math.max(1, lineNum - 5)} && NR<=${lineNum + 5}' ${quotedFile} | cat -n`,
        title: `上下文 - ${file}:${lineNum}`,
        actionName: '查看上下文'
      },
      'view-full-file': {
        command: `cat -n -- ${quotedFile}`,
        title: `完整文件 - ${file}`,
        actionName: '查看完整文件'
      },
      'file-permissions': {
        command: `ls -la -- ${quotedFile} && echo '---' && stat -- ${quotedFile}`,
        title: `权限 - ${file}`,
        actionName: '检查文件权限'
      },
      'file-history': {
        command: `stat -- ${quotedFile} && echo '---最近修改:' && ls -la -- ${quotedFile} && echo '---同目录备份:' && ls -la -- ${quotedFile}.* 2>/dev/null || echo '无备份文件'`,
        title: `修改历史 - ${file}`,
        actionName: '查看修改历史'
      },
      'all-suspicious': {
        command: `grep -n -E '(wget|curl|nc |ncat|bash -i|/dev/tcp|base64|eval|exec|python.*-c|perl.*-e|ruby.*-e|\\|\\s*sh)' -- ${quotedFile} 2>/dev/null`,
        title: `全文可疑搜索 - ${file}`,
        actionName: '搜索可疑关键字'
      },
      'check-owner': {
        command: `ls -la -- ${quotedFile} && echo '---文件所属用户主目录:' && dir=$(dirname -- ${quotedFile}) && ls -la -- "$dir"`,
        title: `文件归属 - ${file}`,
        actionName: '检查文件归属'
      },
      'comment-line': {
        command: `sed -i '${lineNum}s/^/#/' ${quotedFile} && echo '✓ 第${lineNum}行已注释' && sed -n '${lineNum}p' ${quotedFile}`,
        title: `注释行 - ${file}:${lineNum}`,
        actionName: '注释可疑行'
      },
      'backup-file': {
        command: `backup=${quotedFile}.bak.$(date +%Y%m%d%H%M%S) && cp -a -- ${quotedFile} "$backup" && printf '✓ 已备份到 %s\n' "$backup"`,
        title: `备份 - ${file}`,
        actionName: '备份配置文件'
      }
    }

    return actions[action] || null
  }
}

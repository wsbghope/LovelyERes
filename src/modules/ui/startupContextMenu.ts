/**
 * 自启动项右键菜单管理器
 */

import * as IconPark from '@icon-park/svg'
import { BaseContextMenu, type MenuAction } from './contextMenu/baseContextMenu'
import { isSafeSystemdUnit, shellQuote } from '../utils/shellSafety'

export class StartupContextMenu extends BaseContextMenu {
  private currentStartup: {
    name: string
    type: string
    path: string
    command: string
  } | null = null

  constructor() {
    super('startup')
  }

  protected onShowContextMenu(startup: { name: string; type: string; path: string; command: string }) {
    this.currentStartup = startup
  }

  protected getMenuItemsHTML(): string {
    return `
      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Info({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>基本信息</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="details">
            <span class="menu-label">
              ${IconPark.FileText({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>启动项详情</span>
            </span>
          </div>
          <div class="menu-item" data-action="command">
            <span class="menu-label">
              ${IconPark.Terminal({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看启动命令</span>
            </span>
          </div>
          <div class="menu-item" data-action="file-path">
            <span class="menu-label">
              ${IconPark.FolderOpen({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看文件路径</span>
            </span>
          </div>
          <div class="menu-item" data-action="copy-name">
            <span class="menu-label">
              ${IconPark.Copy({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>复制启动项名称</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.SettingConfig({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>启动项管理</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="enable">
            <span class="menu-label">
              ${IconPark.Check({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>启用自启动</span>
            </span>
          </div>
          <div class="menu-item" data-action="disable">
            <span class="menu-label">
              ${IconPark.Close({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>禁用自启动</span>
            </span>
          </div>
          <div class="menu-item" data-action="run-now">
            <span class="menu-label">
              ${IconPark.Play({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>立即运行</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Local({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>位置分析</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="startup-type">
            <span class="menu-label">
              ${IconPark.Tag({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看启动类型</span>
            </span>
          </div>
          <div class="menu-item" data-action="config-location">
            <span class="menu-label">
              ${IconPark.FolderOpen({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>配置文件位置</span>
            </span>
          </div>
          <div class="menu-item" data-action="view-config">
            <span class="menu-label">
              ${IconPark.FileText({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看配置文件</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Protection({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>安全检查</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="suspicious-path">
            <span class="menu-label">
              ${IconPark.FolderFailed({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查可疑路径</span>
            </span>
          </div>
          <div class="menu-item" data-action="file-signature">
            <span class="menu-label">
              ${IconPark.Shield({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>检查文件签名</span>
            </span>
          </div>
          <div class="menu-item" data-action="modification-time">
            <span class="menu-label">
              ${IconPark.Time({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看修改时间</span>
            </span>
          </div>
          <div class="menu-item" data-action="malware-check">
            <span class="menu-label">
              ${IconPark.Caution({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>恶意软件检测</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.NetworkTree({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>依赖分析</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="dependencies">
            <span class="menu-label">
              ${IconPark.Connection({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看依赖项</span>
            </span>
          </div>
          <div class="menu-item" data-action="boot-order">
            <span class="menu-label">
              ${IconPark.Sort({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看启动顺序</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.ChartPie({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>资源影响</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="boot-time">
            <span class="menu-label">
              ${IconPark.Timer({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>启动时间影响</span>
            </span>
          </div>
          <div class="menu-item" data-action="resource-usage">
            <span class="menu-label">
              ${IconPark.Cpu({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>资源占用</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.Log({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>日志查询</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="startup-logs">
            <span class="menu-label">
              ${IconPark.FileText({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看启动日志</span>
            </span>
          </div>
          <div class="menu-item" data-action="error-logs">
            <span class="menu-label">
              ${IconPark.Caution({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看错误日志</span>
            </span>
          </div>
          <div class="menu-item" data-action="run-history">
            <span class="menu-label">
              ${IconPark.History({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看运行记录</span>
            </span>
          </div>
        </div>
      </div>

      <div class="menu-item menu-parent">
        <span class="menu-label">
          ${IconPark.SettingTwo({ theme: 'outline', size: '16', fill: 'currentColor' })}
          <span>高级操作</span>
        </span>
        <span class="arrow">▶</span>
        <div class="submenu">
          <div class="menu-item" data-action="delay-start">
            <span class="menu-label">
              ${IconPark.Timer({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>查看延迟启动配置</span>
            </span>
          </div>
          <div class="menu-item" data-action="backup">
            <span class="menu-label">
              ${IconPark.Save({ theme: 'outline', size: '14', fill: 'currentColor' })}
              <span>备份配置信息</span>
            </span>
          </div>
        </div>
      </div>
    `
  }

  protected async handleSpecialAction(action: string): Promise<boolean> {
    if (action === 'copy-name' && this.currentStartup) {
      navigator.clipboard.writeText(this.currentStartup.name)
      this.showModal('复制成功', `已复制启动项名称: ${this.currentStartup.name}`)
      return true
    }
    return false
  }

  protected resolveAction(action: string): MenuAction | null {
    if (!this.currentStartup) return null

    const { name, type, path, command } = this.currentStartup
    const allowedTypes = new Set(['systemd', 'rc.local', 'cron', 'crontab', 'init.d'])
    if (!allowedTypes.has(type)
      || !isSafeSystemdUnit(name)
      || path.length > 4096
      || command.length === 0
      || command.length > 8192
      || /[\r\n]/.test(name + type)) {
      return null
    }

    const qName = shellQuote(name)
    const qType = shellQuote(type)
    const qPath = shellQuote(path)
    const qCommand = shellQuote(command)
    const commandName = command.trim().split(/\s+/, 1)[0] || ''
    const qCommandName = shellQuote(commandName)

    const actions: Record<string, MenuAction> = {
      'details': {
        command: `echo "=== 启动项详情 ==="; echo ""; printf '名称: %s\\n类型: %s\\n路径: %s\\n命令: %s\\n' ${qName} ${qType} ${qPath} ${qCommand}; echo ""; if [ ${qType} = "systemd" ]; then systemctl show ${qName} 2>/dev/null || echo "无法获取详细信息"; fi`,
        title: `启动项详情 - ${name}`,
        actionName: '查看启动项详情'
      },
      'command': {
        command: `echo "=== 启动命令 ==="; echo ""; printf '%s\\n' ${qCommand}; echo ""; echo "=== 命令解析 ==="; command -v -- ${qCommandName} 2>/dev/null || echo "命令路径: 未找到"`,
        title: `启动命令 - ${name}`,
        actionName: '查看启动命令'
      },
      'file-path': {
        command: `echo "=== 文件路径 ==="; echo ""; printf '%s\\n' ${qPath}; echo ""; ls -la -- ${qPath} 2>/dev/null || echo "文件不存在或无法访问"`,
        title: `文件路径 - ${name}`,
        actionName: '查看文件路径'
      },
      'enable': {
        command: type === 'systemd'
          ? `systemctl enable ${qName} 2>&1 && echo "✓ 已启用自启动" || echo "✗ 启用失败"`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "⚠️ 该类型的启动项需要手动配置"`,
        title: `启用自启动 - ${name}`,
        actionName: '启用自启动'
      },
      'disable': {
        command: type === 'systemd'
          ? `systemctl disable ${qName} 2>&1 && echo "✓ 已禁用自启动" || echo "✗ 禁用失败"`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "⚠️ 该类型的启动项需要手动配置"`,
        title: `禁用自启动 - ${name}`,
        actionName: '禁用自启动'
      },
      'run-now': {
        command: type === 'systemd'
          ? `systemctl start ${qName} 2>&1 || echo "启动失败"`
          : `sh -c ${qCommand} 2>&1 &`,
        title: `立即运行 - ${name}`,
        actionName: '立即运行'
      },
      'startup-type': {
        command: `echo "=== 启动类型分析 ==="; echo ""; printf '类型: %s\\n' ${qType}; echo ""; case ${qType} in systemd) echo "systemd服务单元，由systemd管理";; rc.local) echo "传统启动脚本，在/etc/rc.local中配置";; cron) echo "定时任务，由cron管理";; init.d) echo "传统SysV init脚本";; *) echo "其他类型";; esac`,
        title: `启动类型 - ${name}`,
        actionName: '查看启动类型'
      },
      'config-location': {
        // 用命令替换代替 xargs：BusyBox 的精简 xargs 不支持 -r，
        // 且 `ls -la --` 后的 `--` 会让 xargs 追加的目录参数被当成普通参数吞掉。
        command: `echo "=== 配置文件位置 ==="; echo ""; printf '%s\\n' ${qPath}; echo ""; dir=$(dirname -- ${qPath}) && ls -la -- "$dir" 2>/dev/null || echo "无法访问目录"`,
        title: `配置文件位置 - ${name}`,
        actionName: '配置文件位置'
      },
      'view-config': {
        command: `cat -- ${qPath} 2>/dev/null || systemctl cat ${qName} 2>/dev/null || echo "无法读取配置文件"`,
        title: `配置文件 - ${name}`,
        actionName: '查看配置文件'
      },
      'suspicious-path': {
        command: `echo "=== 可疑路径检测 ==="; echo ""; printf '文件路径: %s\\n命令: %s\\n' ${qPath} ${qCommand}; echo ""; if [[ ${qPath} =~ ^(/tmp|/dev/shm|/var/tmp) ]]; then echo "⚠️ 文件位于可疑目录"; else echo "✓ 文件路径正常"; fi; echo ""; if [[ ${qCommand} =~ ^(/tmp|/dev/shm|/var/tmp) ]]; then echo "⚠️ 命令位于可疑目录"; else echo "✓ 命令路径正常"; fi`,
        title: `可疑路径检测 - ${name}`,
        actionName: '检查可疑路径'
      },
      'file-signature': {
        command: `echo "=== 文件签名检查 ==="; echo ""; file -- ${qPath} 2>/dev/null || echo "无法获取文件类型"; echo ""; md5sum -- ${qPath} 2>/dev/null || echo "无法计算MD5"; echo ""; sha256sum -- ${qPath} 2>/dev/null || echo "无法计算SHA256"`,
        title: `文件签名 - ${name}`,
        actionName: '检查文件签名'
      },
      'modification-time': {
        command: `echo "=== 文件修改时间 ==="; echo ""; stat -- ${qPath} 2>/dev/null || ls -la -- ${qPath} 2>/dev/null || echo "无法获取文件信息"; echo ""; echo "=== 最近修改检查 ==="; find ${qPath} -mtime -7 2>/dev/null && echo "⚠️ 文件在最近7天内被修改" || echo "✓ 文件未在最近7天内修改"`,
        title: `修改时间 - ${name}`,
        actionName: '查看修改时间'
      },
      'malware-check': {
        command: `echo "=== 恶意软件检测 ==="; echo ""; printf '文件: %s\\n' ${qPath}; echo ""; echo "1. 检查可疑字符串:"; strings -- ${qPath} 2>/dev/null | grep -iE "(wget|curl|/tmp|/dev/shm|nc -|bash -i|/bin/sh)" | head -10 || echo "未发现可疑字符串"; echo ""; echo "2. 检查网络连接代码:"; strings -- ${qPath} 2>/dev/null | grep -iE "(socket|connect|bind|listen)" | head -5 || echo "未发现网络代码"; echo ""; echo "⚠️ 建议使用专业杀毒软件进行全面检查"`,
        title: `恶意软件检测 - ${name}`,
        actionName: '恶意软件检测'
      },
      'dependencies': {
        command: type === 'systemd'
          ? `systemctl list-dependencies ${qName} --no-pager 2>/dev/null || echo "无法获取依赖信息"`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "该类型的启动项依赖分析需要手动检查配置文件"`,
        title: `依赖项 - ${name}`,
        actionName: '查看依赖项'
      },
      'boot-order': {
        command: type === 'systemd'
          ? `systemd-analyze critical-chain ${qName} 2>/dev/null || echo "无法获取启动顺序"`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "该类型的启动项启动顺序需要手动分析"`,
        title: `启动顺序 - ${name}`,
        actionName: '查看启动顺序'
      },
      'boot-time': {
        command: type === 'systemd'
          ? `systemd-analyze blame | grep -F -- ${qName} 2>/dev/null || echo "无法获取启动时间影响"; echo ""; echo "=== 系统启动分析 ==="; systemd-analyze time 2>/dev/null`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "该类型的启动项时间分析需要手动测量"`,
        title: `启动时间影响 - ${name}`,
        actionName: '启动时间影响'
      },
      'resource-usage': {
        command: type === 'systemd'
          ? `systemctl status ${qName} 2>/dev/null | grep -E "(CPU|Memory|Tasks)" || echo "服务未运行或无法获取资源信息"`
          : `ps aux | grep -F -- ${qCommand} | grep -v grep || echo "进程未运行"`,
        title: `资源占用 - ${name}`,
        actionName: '查看资源占用'
      },
      'startup-logs': {
        command: type === 'systemd'
          ? `journalctl -u ${qName} -n 50 --no-pager 2>/dev/null || echo "无法获取日志"`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "该类型的启动项日志需要手动查找"`,
        title: `启动日志 - ${name}`,
        actionName: '查看启动日志'
      },
      'error-logs': {
        command: type === 'systemd'
          ? `journalctl -u ${qName} -p err -n 30 --no-pager 2>/dev/null || echo "无错误日志"`
          : `grep -i error /var/log/syslog 2>/dev/null | grep -F -- ${qName} | tail -30 || echo "无错误日志"`,
        title: `错误日志 - ${name}`,
        actionName: '查看错误日志'
      },
      'run-history': {
        command: type === 'systemd'
          ? `journalctl -u ${qName} --no-pager 2>/dev/null | grep -E "(Started|Stopped)" | tail -20 || echo "无运行记录"`
          : `grep -F -- ${qName} /var/log/syslog 2>/dev/null | tail -20 || echo "无运行记录"`,
        title: `运行记录 - ${name}`,
        actionName: '查看运行记录'
      },
      'delay-start': {
        command: type === 'systemd'
          ? `echo "=== 延迟启动配置 ==="; echo ""; systemctl show ${qName} --property=TimeoutStartUSec,TimeoutStopUSec 2>/dev/null || echo "无法获取配置"`
          : `printf '启动类型: %s\\n' ${qType}; echo ""; echo "该类型的启动项延迟配置需要手动设置"`,
        title: `延迟启动配置 - ${name}`,
        actionName: '查看延迟启动配置'
      },
      'backup': {
        command: `echo "=== 备份配置信息 ==="; echo ""; printf '名称: %s\\n类型: %s\\n路径: %s\\n命令: %s\\n' ${qName} ${qType} ${qPath} ${qCommand}; echo ""; echo "=== 配置文件内容 ==="; cat -- ${qPath} 2>/dev/null || systemctl cat ${qName} 2>/dev/null || echo "无法读取配置"`,
        title: `备份配置 - ${name}`,
        actionName: '备份配置信息'
      },
    }

    return actions[action] || null
  }
}

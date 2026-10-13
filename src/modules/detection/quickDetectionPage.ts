import { quickDetectionManager as detection } from './quickDetectionManager';
import { getComplianceRules } from './complianceRules';
import { fixHistoryManager } from './fixHistoryManager';
import { showConfirm } from '../ui/confirmDialog';
import { escapeHtml } from '../utils/safeHtml';
import { sshConnectionManager } from '../remote/sshConnectionManager';

class QuickDetectionPage {
  private bound = false;
  private filter = 'all';
  private active = false;
  private scanning = false;
  private acting = false;

  initialize(): void {
    this.active = true;
    (window as any).quickDetection = this;
    if (!this.bound) {
      document.addEventListener('click', this.onClick);
      this.bound = true;
    }
    this.renderResults();
    this.renderCompliance();
    this.renderFixHistory();
  }

  deactivate(): void {
    this.active = false;
    detection.cancelScan();
  }

  startFullScan(): void {
    if (this.active) void this.runScan();
  }

  startCompetitionScan(): void {
    if (this.active) void this.runScan(true);
  }

  private async runScan(all = false): Promise<void> {
    if (this.scanning) return;
    if (!sshConnectionManager.isConnected()) {
      window.showNotification?.('请先连接服务器', 'warning');
      return;
    }
    if (!all && !document.querySelector('.detection-item input[type="checkbox"]:checked')) {
      window.showNotification?.('请至少选择一项检测', 'warning');
      return;
    }
    this.scanning = true;
    try {
      if (all) {
        await detection.startCompetitionScan();
      } else {
        await detection.startFullScan();
      }
      if (this.active) {
        this.renderResults();
        this.renderCompliance();
        this.switchTab('results');
      }
    } catch (error) {
      window.showNotification?.(`检测失败: ${error}`, 'error');
    } finally {
      this.scanning = false;
    }
  }

  viewReport(): void { detection.viewReport(); }
  closeReportModal(): void { detection.closeReportModal(); }
  exportReport(): void { detection.exportReport(); }
  viewHistoryReport(id: string): void { detection.viewHistoryReport(id); }
  showRawOutput(id: string): void { detection.showRawOutput(id); }
  generateAISolutionStream(title: string, description: string, severity: string, containerId: string): void {
    void detection.generateAISolutionStream(title, description, severity, containerId);
  }
  toggleAllChecks(category: 'security' | 'competition' | 'performance'): void {
    detection.toggleAllChecks(category);
  }

  private onClick = (event: MouseEvent): void => {
    if (!this.active || !document.getElementById('qd-tabs-area')) return;
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>('[data-qd-tab]');
    if (tab) {
      this.switchTab(tab.dataset.qdTab || 'detection');
      return;
    }
    const filter = target.closest<HTMLElement>('[data-qd-filter]');
    if (filter) {
      this.filter = filter.dataset.qdFilter || 'all';
      this.renderResults();
      return;
    }
    const action = target.closest<HTMLElement>('[data-qd-action]');
    if (!action) return;
    void this.handleAction(action.dataset.qdAction || '', action.dataset);
  };

  private switchTab(tab: string): void {
    document.querySelectorAll<HTMLElement>('[data-qd-tab]').forEach(el => {
      el.classList.toggle('active', el.dataset.qdTab === tab);
    });
    document.querySelectorAll<HTMLElement>('.qd-tab-panel').forEach(el => {
      el.style.display = el.id === `qd-tab-${tab}` ? 'block' : 'none';
    });
    if (tab === 'fix-history') this.renderFixHistory();
    if (tab === 'hardening') this.renderHardening();
  }

  private async handleAction(action: string, data: DOMStringMap): Promise<void> {
    if (this.acting) return;
    this.acting = true;
    try {
      await this.performAction(action, data);
    } catch (error) {
      window.showNotification?.(`操作失败: ${error}`, 'error');
    } finally {
      this.acting = false;
    }
  }

  private async performAction(action: string, data: DOMStringMap): Promise<void> {
    if (action === 'fix-all' || action === 'fix-one') {
      const status = sshConnectionManager.getConnectionStatus();
      const server = status?.connected ? `${status.username}@${status.host}:${status.port}` : '';
      if (!server || detection.getCurrentReport()?.server !== server) {
        window.showNotification?.('检测报告与当前服务器不一致，请重新检测', 'warning');
        return;
      }
    }
    if (action === 'fix-all') {
      await detection.executeAllFixes();
      this.renderFixHistory();
    } else if (action === 'fix-one' && data.item && data.finding && data.fix) {
      const item = detection.getCurrentReport()?.items.find(i => i.id === data.item);
      const finding = item?.result?.findings[Number(data.finding)];
      const def = finding && detection.getFixActions(data.item, finding.title)[Number(data.fix)];
      if (finding && def && await showConfirm({
        title: '确认修复', message: `${def.title}\n${finding.title}`, dangerous: true,
      })) {
        const result = await detection.executeSingleFix(data.item, finding.title, def);
        window.showNotification?.(result.success ? '修复命令已执行' : '修复失败，请查看修复历史', result.success ? 'success' : 'error');
        this.renderFixHistory();
      }
    } else if (action === 'rollback' && data.id) {
      if (await showConfirm({ title: '确认回滚', message: '恢复这项修复前的状态？', dangerous: true })) {
        const result = await detection.rollbackFix(data.id);
        window.showNotification?.(result.output, result.success ? 'success' : 'error');
        this.renderFixHistory();
      }
    } else if (action === 'clear-fix-history') {
      if (await showConfirm({ title: '清空修复历史', message: '确定清空全部修复记录？', dangerous: true })) {
        detection.clearFixHistory();
        this.renderFixHistory();
      }
    } else if (action === 'export-fix-history') {
      this.download('fix-history.txt', fixHistoryManager.exportAll(), 'text/plain');
    } else if (action === 'check-all-hardening') {
      await this.renderHardening(true);
    } else if (action === 'harden-one' && data.id) {
      const item = detection.getHardeningItems().find(i => i.id === data.id);
      if (item && await showConfirm({
        title: '执行加固',
        message: `${item.title}\n${item.id === 'h-fw-default' ? '将仅保留当前 SSH 端口、80、443 的新入站连接，请先确认业务所需端口。' : '将修改远程系统配置，可能影响当前连接。'}继续？`,
        dangerous: true,
      })) {
        const output = await detection.executeHardening(item);
        const passed = !output.startsWith('failed:') && await detection.checkHardeningStatus(item);
        window.showNotification?.(passed ? `${item.title}：验证通过` : `${item.title}：未验证通过，请检查命令输出：${output}`, passed ? 'success' : 'error');
        await this.renderHardening(true);
      }
    }
  }

  private renderResults(): void {
    const el = document.getElementById('qd-results-list');
    if (!el) return;
    const report = detection.getCurrentReport();
    const findings = report?.items.flatMap(item => (item.result?.findings || []).map((finding, index) => ({ item, finding, index }))) || [];
    const filtered = findings.filter(({ finding }) => this.filter === 'all' || finding.severity === this.filter);
    document.querySelectorAll<HTMLElement>('[data-qd-filter]').forEach(button => button.classList.toggle('active', button.dataset.qdFilter === this.filter));
    el.innerHTML = filtered.length ? filtered.map(({ item, finding, index }) => {
      const fixes = detection.getFixActions(item.id, finding.title);
      return `<article class="modern-card" style="padding:14px;margin-bottom:10px">
        <strong>${escapeHtml(finding.title)}</strong> <small>${escapeHtml(finding.severity)} · ${escapeHtml(item.name)}</small>
        <p>${escapeHtml(finding.description)}</p>
        ${finding.recommendation ? `<p>${escapeHtml(finding.recommendation)}</p>` : ''}
        ${fixes.map((fix, fixIndex) => `<button class="qd-action-btn" data-qd-action="fix-one" data-item="${escapeHtml(item.id)}" data-finding="${index}" data-fix="${fixIndex}">${escapeHtml(fix.title)}</button>`).join('')}
      </article>`;
    }).join('') : '<div class="qd-empty">暂无匹配的检测结果</div>';
  }

  private renderCompliance(): void {
    const el = document.getElementById('qd-compliance-content');
    const report = detection.getCurrentReport();
    if (!el || !report) return;
    const renderStandard = (standard: 'cis' | 'mlps2') => {
      const rules = getComplianceRules(standard);
      const rows = rules.map(rule => {
        const item = report.items.find(i => i.id.replace(/-/g, '_') === rule.detectionItemId.replace(/-/g, '_'));
        const status = item?.result ? (item.result.passed ? '通过' : '不通过') : '未检测';
        return `<div class="modern-card" style="padding:10px;margin:6px 0">${escapeHtml(rule.title)} · ${status}</div>`;
      }).join('');
      return `<h3>${standard === 'cis' ? 'CIS' : '等保 2.0'}</h3>${rows}`;
    };
    el.innerHTML = renderStandard('cis') + renderStandard('mlps2');
  }

  private renderFixHistory(): void {
    const el = document.getElementById('qd-fix-history-list');
    if (!el) return;
    const entries = detection.getFixHistory();
    el.innerHTML = entries.length ? entries.map(entry => `<div class="modern-card" style="padding:12px;margin:6px 0">
      <strong>${escapeHtml(entry.fixTitle)}</strong> · ${escapeHtml(entry.server)} · ${new Date(entry.timestamp).toLocaleString()}
      <span>${entry.success ? '成功' : '失败'}${entry.rolledBack ? ' · 已回滚' : ''}</span>
      ${entry.restoreCommand && !entry.rolledBack ? `<button class="qd-action-btn" data-qd-action="rollback" data-id="${escapeHtml(entry.id)}">回滚</button>` : ''}
    </div>`).join('') : '<div class="qd-empty">暂无修复记录</div>';
  }

  private async renderHardening(check = false): Promise<void> {
    const el = document.getElementById('qd-hardening-list');
    if (!el) return;
    const items = detection.getHardeningItems();
    const statuses = check ? await Promise.all(items.map(i => detection.checkHardeningStatus(i))) : [];
    if (!el.isConnected) return;
    el.innerHTML = items.map((item, index) => `<div class="modern-card" style="padding:10px;margin:6px 0">
      ${escapeHtml(item.title)} · ${check ? (statuses[index] ? '已符合' : '需加固') : '未检查'}
      <button class="qd-action-btn" data-qd-action="harden-one" data-id="${escapeHtml(item.id)}">执行</button>
    </div>`).join('');
  }

  private download(name: string, content: string, type = 'application/json'): void {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }
}

export const quickDetectionPage = new QuickDetectionPage();

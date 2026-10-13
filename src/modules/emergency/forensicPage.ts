import { forensicManager, type ForensicSnapshot, type SnapshotData } from './forensicManager';
import { sshConnectionManager } from '../remote/sshConnectionManager';
import { showConfirm } from '../ui/confirmDialog';
import { escapeHtml } from '../utils/safeHtml';

class ForensicPage {
  private bound = false;
  private busy = false;

  render(): string {
    return `<section class="forensic-page" style="padding:24px;max-width:1100px;margin:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap">
        <div><h2>主机取证快照</h2><p>采集当前主机状态，比较响应前后的变化。</p></div>
        <div style="display:flex;gap:8px">
          <button class="modern-btn primary" data-forensic-action="capture">采集快照</button>
          <button class="modern-btn secondary" data-forensic-action="clear">清空本地快照</button>
        </div>
      </div>
      <div id="forensic-progress" role="status"></div>
      <div id="forensic-list"></div>
      <div id="forensic-diff"></div>
    </section>`;
  }

  initialize(): void {
    if (!this.bound) {
      document.addEventListener('click', this.onClick);
      sshConnectionManager.addListener(() => {
        if (document.getElementById('forensic-list')) {
          this.update();
          document.getElementById('forensic-diff')?.replaceChildren();
        }
      });
      this.bound = true;
    }
    this.update();
  }

  private getServer(): string {
    const status = sshConnectionManager.getConnectionStatus();
    return status?.connected ? `${status.username}@${status.host}:${status.port}` : '';
  }

  private update(): void {
    const list = document.getElementById('forensic-list');
    if (!list) return;
    const current = this.getServer();
    const snapshots = forensicManager.getSnapshots().filter(s => s.server === current).reverse();
    list.innerHTML = snapshots.length ? snapshots.map(s => `<div class="modern-card" style="padding:14px;margin:10px 0;display:flex;align-items:center;gap:12px;flex-wrap:wrap">
      <input type="checkbox" class="forensic-compare" value="${escapeHtml(s.id)}" aria-label="选择快照比较">
      <strong>${new Date(s.timestamp).toLocaleString()}</strong>
      <span>${escapeHtml(s.server)}</span>
      <button class="modern-btn secondary" data-forensic-action="view" data-id="${escapeHtml(s.id)}">查看</button>
      <button class="modern-btn secondary" data-forensic-action="export" data-id="${escapeHtml(s.id)}">导出 JSON</button>
      <button class="modern-btn secondary" data-forensic-action="delete" data-id="${escapeHtml(s.id)}">删除</button>
    </div>`).join('') + '<button class="modern-btn primary" data-forensic-action="compare">比较选中的两次快照</button>'
      : '<p>当前服务器暂无快照。已保存的其他服务器快照不会显示在这里。</p>';
  }

  private onClick = (event: MouseEvent): void => {
    if (!document.getElementById('forensic-list')) return;
    const button = (event.target as HTMLElement).closest<HTMLElement>('[data-forensic-action]');
    if (!button) return;
    void this.action(button.dataset.forensicAction || '', button.dataset.id);
  };

  private async action(action: string, id?: string): Promise<void> {
    if (this.busy && action !== 'capture') {
      window.showNotification?.('请等待当前采集完成', 'warning');
      return;
    }
    const snapshots = forensicManager.getSnapshots();
    const snapshot = snapshots.find(s => s.id === id);
    const diff = document.getElementById('forensic-diff');
    if (snapshot && snapshot.server !== this.getServer()) {
      this.update();
      return;
    }
    if (action === 'capture') {
      if (this.busy || !this.getServer()) return;
      if (!await showConfirm({
        title: '采集主机快照',
        message: '快照可能包含授权密钥、环境变量等敏感信息。最近 10 次快照会保存在本机应用数据中，可随时删除。继续采集？',
      })) return;
      this.busy = true;
      const progress = document.getElementById('forensic-progress');
      try {
        const server = this.getServer();
        await forensicManager.captureSnapshot(server, (pct, label) => {
          if (progress) progress.textContent = `${pct}% · ${label}`;
        });
        if (server === this.getServer()) this.update();
      } catch (error) {
        window.showNotification?.(`采集失败: ${error}`, 'error');
      } finally {
        this.busy = false;
        if (progress) progress.textContent = '';
      }
    } else if (action === 'clear') {
      if (await showConfirm({ title: '清空快照', message: '删除本机保存的所有服务器取证快照？', dangerous: true })) {
        forensicManager.clearSnapshots();
        if (diff) diff.replaceChildren();
        this.update();
      }
    } else if (action === 'delete' && snapshot) {
      forensicManager.deleteSnapshot(snapshot.id);
      if (diff) diff.replaceChildren();
      this.update();
    } else if (action === 'export' && snapshot) {
      forensicManager.exportSnapshot(snapshot);
    } else if (action === 'view' && snapshot && diff) {
      diff.innerHTML = this.renderData(snapshot);
    } else if (action === 'compare' && diff) {
      const ids = Array.from(document.querySelectorAll<HTMLInputElement>('.forensic-compare:checked')).map(el => el.value);
      if (ids.length !== 2) {
        window.showNotification?.('请选择恰好两次快照', 'warning');
        return;
      }
      const selected = ids.map(value => snapshots.find(s => s.id === value)).filter((s): s is ForensicSnapshot => !!s);
      if (selected.length !== 2 || selected.some(s => s.server !== this.getServer())) return;
      const [older, newer] = selected.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      const changes = forensicManager.diffSnapshots(older, newer);
      diff.innerHTML = `<h3>变化：${new Date(older.timestamp).toLocaleString()} → ${new Date(newer.timestamp).toLocaleString()}</h3>`
        + Object.entries(changes).map(([key, value]) => `<details><summary>${escapeHtml(key)} · 新增 ${value.added.length} / 消失 ${value.removed.length}</summary>
          <pre>新增:\n${escapeHtml(value.added.join('\n'))}\n\n消失:\n${escapeHtml(value.removed.join('\n'))}</pre></details>`).join('');
    }
  }

  private renderData(snapshot: ForensicSnapshot): string {
    return `<h3>${escapeHtml(snapshot.server)} · ${new Date(snapshot.timestamp).toLocaleString()}</h3>`
      + (Object.entries(snapshot.data) as [keyof SnapshotData, string][]).map(([key, value]) =>
        `<details><summary>${escapeHtml(key)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escapeHtml(value)}</pre></details>`).join('');
  }
}

export const forensicPage = new ForensicPage();

import { invoke } from '@tauri-apps/api/core';
import { revealItemInDir } from '@tauri-apps/plugin-opener';

import { showAlert, showConfirm } from '../ui/confirmDialog';

export interface ResourceTool {
  key: string;
  name: string;
  provider: string;
  architecture: string;
  source: 'official' | 'custom';
  version: string | null;
  category: string;
  description: string;
  size: number;
  sha256: string;
  verified: boolean;
  systemPath: string | null;
  deployedPaths: string[];
  warning: string | null;
}

interface ResourceScanResult {
  root: string;
  targetArchitecture: string;
  selectedArchitecture: string;
  uid: number;
  availableArchitectures: string[];
  tools: ResourceTool[];
}

interface ResourceDeployment {
  name: string;
  provider: string;
  architecture: string;
  remotePath: string;
  invocation: string;
  verification: string | null;
  verificationOk: boolean | null;
}

const escapeHtml = (value: string): string => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};

export const filterResourceTools = (tools: ResourceTool[], query: string): ResourceTool[] => {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return tools;
  return tools.filter(tool =>
    `${tool.name} ${tool.provider} ${tool.category} ${tool.description}`.toLowerCase().includes(normalized));
};

export const summarizeResourceSelection = (tools: ResourceTool[], targetArchitecture: string) => ({
  existingCount: tools.filter(tool => Boolean(tool.systemPath)).length,
  mismatchCount: tools.filter(tool => tool.architecture !== targetArchitecture).length,
});

/** 核心模板 HTML — 页面模式和弹窗模式共用 */
const CORE_TEMPLATE = `
  <div class="em-resource-core">
    <header class="em-resource-header">
      <div>
        <h3 id="em-resource-title">应急工具上传</h3>
        <p>扫描 LovelyERes-Resources，所有上传均由你勾选确认。</p>
      </div>
      <button class="em-resource-close" data-action="close" title="关闭">×</button>
    </header>
    <div class="em-resource-controls">
      <label>工具架构
        <select id="em-resource-arch"></select>
      </label>
      <label class="em-resource-search-label">
        <input id="em-resource-search" type="search" placeholder="搜索 tcpdump、curl、wget、nc...">
      </label>
      <button class="em-resource-btn" data-action="scan">重新扫描</button>
      <button class="em-resource-btn" data-action="open-dir">打开资源目录</button>
    </div>
    <div id="em-resource-summary" class="em-resource-summary"></div>
    <div class="em-resource-table-wrap">
      <table class="em-resource-table">
        <thead><tr><th class="select"></th><th>工具</th><th>来源</th><th>架构</th><th>远端状态</th><th>说明</th></tr></thead>
        <tbody id="em-resource-body"></tbody>
      </table>
    </div>
    <footer class="em-resource-footer">
      <label class="em-resource-verify"><input id="em-resource-verify" type="checkbox"> 上传后尝试执行 --version/--help</label>
      <span id="em-resource-selection">已选择 0 项</span>
      <button class="em-resource-btn" data-action="close">取消</button>
      <button class="em-resource-btn primary" data-action="upload">上传所选工具</button>
    </footer>
  </div>`;

class ResourceUploadManager {
  private overlay: HTMLElement | null = null;
  private pageContainer: HTMLElement | null = null;
  private result: ResourceScanResult | null = null;
  private selectedKeys = new Set<string>();
  private search = '';
  private loading = false;
  /** 当前活跃的宿主元素（overlay 或 pageContainer），事件监听绑定在它上面 */
  private host: HTMLElement | null = null;

  /**
   * 以弹窗模式打开（用于跨页面跳转，如抓包页面提示前往文件上传）。
   * 在 file-upload 作为独立页面后，此方法仍保留供需要弹窗的场景使用。
   */
  async show(search = ''): Promise<void> {
    this.pageContainer = null;
    this.ensureModal();
    // ensureModal 在 overlay 已存在时会早返回，这里统一把 host 指回 overlay，
    // 避免 scan() 因 host 为空而提前退出
    this.host = this.overlay;
    this.search = search.trim().toLowerCase();
    this.overlay!.classList.add('visible');
    const input = this.overlay!.querySelector<HTMLInputElement>('#em-resource-search');
    if (input) input.value = search;
    await this.scan();
  }

  close(): void {
    this.overlay?.classList.remove('visible');
  }

  /**
   * 以页面内联模式渲染到指定容器（用于「应急响应 → 文件上传」页面）。
   * 容器由调用方提供（#file-upload-page），管理器在容器内渲染完整 UI。
   */
  async mountInContainer(container: HTMLElement, search = ''): Promise<void> {
    // 若弹窗还开着，先收起；页面模式与弹窗模式互斥
    this.overlay?.classList.remove('visible');
    this.pageContainer = container;
    this.search = search.trim().toLowerCase();

    container.innerHTML = `<div class="em-resource-page">${CORE_TEMPLATE}</div>`;

    // 绑定事件到页面容器
    this.bindEvents(container);
    this.host = container;

    const input = container.querySelector<HTMLInputElement>('#em-resource-search');
    if (input) input.value = search;
    await this.scan();
  }

  // ──── 弹窗模式：创建 overlay ────

  private ensureModal(): void {
    if (this.overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'em-resource-overlay';
    overlay.innerHTML = CORE_TEMPLATE;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.bindEvents(overlay);
    this.host = overlay;
  }

  // ──── 事件绑定（共用） ────

  private bindEvents(root: HTMLElement): void {
    root.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'close') {
        if (this.overlay && root === this.overlay) {
          this.close();
        } else if (this.pageContainer) {
          // 页面模式下"取消"不做任何操作（已在页面上）
        }
      }
      if (action === 'scan') void this.scan();
      if (action === 'open-dir') void this.openDirectory();
      if (action === 'upload') void this.uploadSelected();
    });
    root.querySelector('#em-resource-search')?.addEventListener('input', event => {
      this.search = (event.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTools();
    });
    root.querySelector('#em-resource-arch')?.addEventListener('change', event => {
      void this.scan((event.target as HTMLSelectElement).value);
    });
    root.querySelector('#em-resource-body')?.addEventListener('change', event => {
      const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-tool-key]');
      if (!checkbox) return;
      if (checkbox.checked) this.selectedKeys.add(checkbox.dataset.toolKey!);
      else this.selectedKeys.delete(checkbox.dataset.toolKey!);
      this.updateSelection();
    });
  }

  // ──── 以下方法通过 this.host 访问当前活跃的 DOM ────

  private query<T extends HTMLElement>(selector: string): T | null {
    return (this.host ?? this.overlay)?.querySelector<T>(selector) ?? null;
  }

  private async scan(architecture?: string): Promise<void> {
    if (this.loading || !this.host) return;
    this.loading = true;
    this.setBusy('正在校验并扫描本地工具包，同时检查目标机命令...');
    try {
      this.result = await invoke<ResourceScanResult>('scan_resource_tools', {
        architecture: architecture || null,
      });
      const validKeys = new Set(this.result.tools.map(tool => tool.key));
      this.selectedKeys = new Set([...this.selectedKeys].filter(key => validKeys.has(key)));
      this.renderArchitectureOptions();
      this.renderTools();
    } catch (error) {
      this.setBusy(`扫描失败：${String(error)}`, true);
    } finally {
      this.loading = false;
    }
  }

  private setBusy(message: string, isError = false): void {
    const summary = this.query<HTMLElement>('#em-resource-summary');
    const body = this.query<HTMLElement>('#em-resource-body');
    if (summary) {
      summary.classList.toggle('error', isError);
      summary.textContent = message;
    }
    if (body) body.innerHTML = `<tr><td colspan="6" class="em-resource-empty">${escapeHtml(message)}</td></tr>`;
  }

  private renderArchitectureOptions(): void {
    if (!this.result || !this.host) return;
    const select = this.host.querySelector<HTMLSelectElement>('#em-resource-arch');
    if (!select) return;
    select.innerHTML = this.result.availableArchitectures.map(architecture => {
      const target = architecture === this.result!.targetArchitecture ? '（目标机）' : '';
      const selected = architecture === this.result!.selectedArchitecture ? ' selected' : '';
      return `<option value="${escapeHtml(architecture)}"${selected}>${escapeHtml(architecture)}${target}</option>`;
    }).join('');
  }

  private renderTools(): void {
    if (!this.result || !this.host) return;
    const summary = this.host.querySelector<HTMLElement>('#em-resource-summary');
    const body = this.host.querySelector<HTMLElement>('#em-resource-body');
    if (!summary || !body) return;
    const mismatch = this.result.selectedArchitecture !== this.result.targetArchitecture;
    summary.classList.remove('error');
    summary.innerHTML = `资源目录：<code>${escapeHtml(this.result.root)}</code> · 目标架构：<b>${escapeHtml(this.result.targetArchitecture)}</b> · 上传目录：<code>/tmp/lovelyres-${this.result.uid}/bin</code>${mismatch ? '<span class="em-resource-warning">当前选择与目标架构不同，仍可上传</span>' : ''}`;

    const tools = filterResourceTools(this.result.tools, this.search);
    if (!tools.length) {
      body.innerHTML = '<tr><td colspan="6" class="em-resource-empty">没有匹配的工具。可将自定义文件放入 custom/&lt;架构&gt;/bin 后重新扫描。</td></tr>';
      this.updateSelection();
      return;
    }

    body.innerHTML = tools.map(tool => {
      const source = tool.source === 'official'
        ? `<span class="em-resource-badge official">官方 ${escapeHtml(tool.version || '')}</span>`
        : '<span class="em-resource-badge custom">用户添加</span>';
      const provider = tool.provider !== tool.name ? `<div class="em-resource-sub">由 ${escapeHtml(tool.provider)} 提供</div>` : '';
      const states = [
        tool.systemPath ? `<span class="em-resource-state">系统已有 ${escapeHtml(tool.systemPath)}</span>` : '<span class="em-resource-muted">系统未发现</span>',
        tool.deployedPaths.length ? `<span class="em-resource-state deployed">已上传 ${tool.deployedPaths.length} 份</span>` : '',
      ].filter(Boolean).join('<br>');
      const notes = [tool.description, tool.warning].filter(Boolean).map((note, index) =>
        `<div class="${index ? 'em-resource-warning-text' : ''}">${escapeHtml(note!)}</div>`).join('');
      return `<tr>
        <td class="select"><input type="checkbox" data-tool-key="${escapeHtml(tool.key)}" ${this.selectedKeys.has(tool.key) ? 'checked' : ''}></td>
        <td><b>${escapeHtml(tool.name)}</b>${provider}<div class="em-resource-sub">${formatSize(tool.size)} · SHA-256 ${escapeHtml(tool.sha256.slice(0, 12))}</div></td>
        <td>${source}${tool.verified ? '<div class="em-resource-verified">摘要已校验</div>' : ''}</td>
        <td><code>${escapeHtml(tool.architecture)}</code></td>
        <td>${states}</td>
        <td>${notes}</td>
      </tr>`;
    }).join('');
    this.updateSelection();
  }

  private updateSelection(): void {
    const label = this.host?.querySelector<HTMLElement>('#em-resource-selection');
    if (label) label.textContent = `已选择 ${this.selectedKeys.size} 项`;
  }

  private async openDirectory(): Promise<void> {
    try {
      const root = this.result?.root || await invoke<string>('get_resource_directory');
      await revealItemInDir(root);
    } catch (error) {
      await showAlert({ title: '打开失败', message: String(error), type: 'error' });
    }
  }

  private async uploadSelected(): Promise<void> {
    if (!this.result || !this.selectedKeys.size) {
      await showAlert({ title: '请选择工具', message: '请勾选一个或多个要上传的工具。', type: 'warning' });
      return;
    }
    const selected = this.result.tools.filter(tool => this.selectedKeys.has(tool.key));
    const { mismatchCount, existingCount } = summarizeResourceSelection(
      selected,
      this.result.targetArchitecture,
    );
    const approved = await showConfirm({
      title: `确认上传 ${selected.length} 个工具`,
      message: `文件将上传到 /tmp/lovelyres-${this.result.uid}/bin 下的版本化名称，不覆盖目标机系统文件。\n\n系统已有同名命令：${existingCount} 项\n架构与目标不一致：${mismatchCount} 项\n\n以上提示均不阻止上传，是否继续？`,
      confirmText: '确认上传',
      cancelText: '取消',
    });
    if (!approved) return;

    const verify = this.host?.querySelector<HTMLInputElement>('#em-resource-verify')?.checked ?? false;
    this.loading = true;
    try {
      const deployments = await invoke<ResourceDeployment[]>('deploy_resource_tools', {
        request: { keys: [...this.selectedKeys], verifyAfterUpload: verify },
      });
      const physical = new Set(deployments.map(item => item.remotePath)).size;
      const lines = deployments.map(item => {
        const verification = item.verificationOk === false ? '（执行验证失败，但文件已上传）' : '';
        return `${item.name}: ${item.invocation}${verification}`;
      });
      await showAlert({
        title: '上传完成',
        message: `已部署 ${physical} 个物理文件，提供 ${deployments.length} 个命令。\n\n${lines.join('\n')}`,
        type: 'info',
      });
      await this.scan(this.result.selectedArchitecture);
    } catch (error) {
      await showAlert({ title: '上传失败', message: String(error), type: 'error' });
    } finally {
      this.loading = false;
    }
  }
}

export const resourceUploadManager = new ResourceUploadManager();

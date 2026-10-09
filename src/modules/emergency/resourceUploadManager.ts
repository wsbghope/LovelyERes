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

/**
 * 控制区 + 表格 + 底栏 — 页面模式和弹窗模式共用。
 * 不含标题栏（弹窗模式有自己的 em-resource-header，页面模式有独立的 page-header）。
 */
const BODY_TEMPLATE = `
    <div class="em-resource-controls">
      <label>工具架构
        <select id="em-resource-arch"></select>
      </label>
      <label class="em-resource-search-label">
        <input id="em-resource-search" type="search" placeholder="搜索 tcpdump、curl、wget、nc...">
      </label>
      <button class="em-resource-btn" data-action="scan" id="em-resource-btn-scan">重新扫描</button>
      <button class="em-resource-btn" data-action="open-dir" id="em-resource-btn-dir">打开资源目录</button>
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
      <button class="em-resource-btn primary" data-action="upload" id="em-resource-btn-upload">上传所选工具</button>
    </footer>`;

/** 弹窗模式完整模板（含标题栏） */
const MODAL_TEMPLATE = `
  <div class="em-resource-core">
    <header class="em-resource-header">
      <div>
        <h3>应急工具上传</h3>
        <p>扫描 LovelyERes-Resources，所有上传均由你勾选确认。</p>
      </div>
      <button class="em-resource-close" data-action="close" title="关闭">×</button>
    </header>
    ${BODY_TEMPLATE}
  </div>`;

/** 页面模式完整模板（含页面级标题栏，与抓包/日志审计页面视觉一致） */
const PAGE_TEMPLATE = `
  <div class="em-resource-page">
    <div class="em-resource-page-header">
      <div class="em-resource-page-header-left">
        <div class="em-resource-page-header-icon">
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M5 14v5h14v-5"/></svg>
        </div>
        <div>
          <h2 class="em-resource-page-title">文件上传</h2>
          <div class="em-resource-page-subtitle">应急工具部署 · SHA-256 校验 · 不覆盖系统命令</div>
        </div>
      </div>
    </div>
    <div class="em-resource-card">${BODY_TEMPLATE}</div>
  </div>`;

class ResourceUploadManager {
  private overlay: HTMLElement | null = null;
  private result: ResourceScanResult | null = null;
  private selectedKeys = new Set<string>();
  private search = '';
  private loading = false;
  /** 当前活跃的宿主元素（overlay 或页面容器） */
  private host: HTMLElement | null = null;
  /** 已绑定事件的根元素（用于切换 host 时移除旧监听器） */
  private boundRoot: HTMLElement | null = null;
  /** 存储已绑定的处理函数引用，便于精确 removeEventListener */
  private boundClick: ((e: Event) => void) | null = null;
  private boundInput: ((e: Event) => void) | null = null;
  private boundChange: ((e: Event) => void) | null = null;
  private boundBodyChange: ((e: Event) => void) | null = null;

  // ──── 公共 API ────

  /**
   * 以弹窗模式打开（用于跨页面跳转等需要浮层的场景）。
   */
  async show(search = ''): Promise<void> {
    this.detachListeners();
    this.ensureModal();
    this.host = this.overlay;
    this.search = search.trim().toLowerCase();
    this.overlay!.classList.add('visible');
    const input = this.overlay!.querySelector<HTMLInputElement>('#em-resource-search');
    if (input) input.value = search;
    this.attachListeners(this.overlay!);
    await this.scan();
  }

  close(): void {
    this.overlay?.classList.remove('visible');
  }

  /**
   * 以页面内联模式渲染到指定容器（用于「应急响应 → 文件上传」页面）。
   */
  async mountInContainer(container: HTMLElement, search = ''): Promise<void> {
    // 先清理上一轮的监听器，防止反复切换页面导致事件堆积
    this.detachListeners();
    this.overlay?.classList.remove('visible');

    this.host = container;
    this.search = search.trim().toLowerCase();
    container.innerHTML = PAGE_TEMPLATE;

    const input = container.querySelector<HTMLInputElement>('#em-resource-search');
    if (input) input.value = search;

    this.attachListeners(container);
    await this.scan();
  }

  /**
   * 离开页面时调用：移除事件监听器、释放 DOM 引用。
   * 确保 globalFunctions 的页面切换逻辑中 pageId !== 'file-upload' 时调用。
   */
  deactivate(): void {
    this.detachListeners();
    this.host = null;
    this.loading = false;
  }

  // ──── 内部：弹窗创建 ────

  private ensureModal(): void {
    if (this.overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'em-resource-overlay';
    overlay.innerHTML = MODAL_TEMPLATE;
    document.body.appendChild(overlay);
    this.overlay = overlay;
  }

  // ──── 内部：事件监听管理 ────

  private attachListeners(root: HTMLElement): void {
    // 安全起见先解绑（正常流程下 detachListeners 已调用，此处为防御性编程）
    this.detachListeners();

    this.boundClick = (event: Event) => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'close' && root === this.overlay) this.close();
      if (action === 'scan') void this.scan();
      if (action === 'open-dir') void this.openDirectory();
      if (action === 'upload') void this.uploadSelected();
    };
    this.boundInput = (event: Event) => {
      this.search = (event.target as HTMLInputElement).value.trim().toLowerCase();
      this.renderTools();
    };
    this.boundChange = (event: Event) => {
      void this.scan((event.target as HTMLSelectElement).value);
    };
    this.boundBodyChange = (event: Event) => {
      const checkbox = (event.target as HTMLElement).closest<HTMLInputElement>('input[data-tool-key]');
      if (!checkbox) return;
      if (checkbox.checked) this.selectedKeys.add(checkbox.dataset.toolKey!);
      else this.selectedKeys.delete(checkbox.dataset.toolKey!);
      this.updateSelection();
    };

    root.addEventListener('click', this.boundClick);
    root.querySelector('#em-resource-search')?.addEventListener('input', this.boundInput);
    root.querySelector('#em-resource-arch')?.addEventListener('change', this.boundChange);
    root.querySelector('#em-resource-body')?.addEventListener('change', this.boundBodyChange);

    this.boundRoot = root;
  }

  private detachListeners(): void {
    if (!this.boundRoot) return;
    if (this.boundClick) this.boundRoot.removeEventListener('click', this.boundClick);
    if (this.boundInput) this.boundRoot.querySelector('#em-resource-search')?.removeEventListener('input', this.boundInput);
    if (this.boundChange) this.boundRoot.querySelector('#em-resource-arch')?.removeEventListener('change', this.boundChange);
    if (this.boundBodyChange) this.boundRoot.querySelector('#em-resource-body')?.removeEventListener('change', this.boundBodyChange);
    this.boundRoot = null;
    this.boundClick = null;
    this.boundInput = null;
    this.boundChange = null;
    this.boundBodyChange = null;
  }

  // ──── 内部：加载状态 ────

  private setLoadingButtons(disabled: boolean): void {
    this.host?.querySelectorAll<HTMLElement>('[data-action]').forEach(btn => {
      btn.setAttribute('data-disabled', disabled ? '1' : '0');
      (btn as HTMLButtonElement).disabled = disabled;
    });
  }

  // ──── 内部：扫描 ────

  private async scan(architecture?: string): Promise<void> {
    if (this.loading || !this.host) return;
    this.loading = true;
    this.setLoadingButtons(true);
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
      this.setLoadingButtons(false);
    }
  }

  private setBusy(message: string, isError = false): void {
    const summary = this.host?.querySelector<HTMLElement>('#em-resource-summary');
    const body = this.host?.querySelector<HTMLElement>('#em-resource-body');
    if (summary) {
      summary.classList.toggle('error', isError);
      summary.textContent = message;
    }
    if (body) body.innerHTML = `<tr><td colspan="6" class="em-resource-empty">${escapeHtml(message)}</td></tr>`;
  }

  // ──── 内部：渲染 ────

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

  // ──── 内部：操作 ────

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
    this.setLoadingButtons(true);
    // 上传期间在摘要区给出进度提示
    const summary = this.host?.querySelector<HTMLElement>('#em-resource-summary');
    if (summary) {
      summary.classList.remove('error');
      summary.innerHTML = `<span class="em-resource-uploading">正在上传 ${this.selectedKeys.size} 个工具，请稍候…</span>`;
    }
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
      this.setLoadingButtons(false);
    }
  }
}

export const resourceUploadManager = new ResourceUploadManager();

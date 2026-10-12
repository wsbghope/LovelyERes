/**
 * 数据库管理器
 * 管理数据库连接、SQL 执行、数据浏览等功能
 */

import { invoke } from '@tauri-apps/api/core';

// ==================== Types ====================

export interface DatabaseInfo {
  db_type: string;
  name: string;
  version: string;
  status: string;
  port: number;
  data_dir: string;
}

export interface DbConnection {
  id: string;
  db_type: string;
  host: string;
  port: number;
  username: string;
  password: string;
  encryptedPassword?: string;
  database?: string;
  name: string;          // 显示名称
  isConnected: boolean;
}

export interface SqlResult {
  columns: string[];
  rows: string[][];
  row_count: number;
  affected_rows?: number;
  execution_time_ms: number;
  error?: string;
}

export interface TableInfo {
  name: string;
  row_count?: number;
  size?: string;
  engine?: string;
}

export interface ColumnInfo {
  name: string;
  data_type: string;
  is_nullable: boolean;
  is_primary_key: boolean;
  default_value?: string;
}

export interface DbUser {
  username: string;
  host: string;
  privileges: string[];
}

export interface SqlHistoryEntry {
  sql: string;
  db_type: string;
  database: string;
  timestamp: number;
  success: boolean;
  row_count?: number;
}

export type DbTab = 'connections' | 'sql' | 'browser' | 'users' | 'ops';

export function getSqlResultError(result: SqlResult): string | null {
  const error = result.error?.trim();
  return error || null;
}

export function normalizeStoredDbConnections(value: unknown): DbConnection[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((connection): connection is DbConnection =>
      Boolean(connection)
      && typeof connection === 'object'
      && typeof (connection as DbConnection).id === 'string'
      && typeof (connection as DbConnection).db_type === 'string'
      && typeof (connection as DbConnection).host === 'string'
      && Number.isInteger((connection as DbConnection).port)
      && (connection as DbConnection).port > 0
      && (connection as DbConnection).port <= 65535
      && typeof (connection as DbConnection).username === 'string'
      && typeof (connection as DbConnection).name === 'string'
    )
    .map(connection => ({
      ...connection,
      password: '',
      database: typeof connection.database === 'string' ? connection.database : undefined,
      encryptedPassword: typeof connection.encryptedPassword === 'string'
        ? connection.encryptedPassword : undefined,
      isConnected: false,
    }));
}

export function serializeDbConnections(connections: DbConnection[]): DbConnection[] {
  return connections.map(connection => ({
    ...connection,
    password: '',
    isConnected: false,
  }));
}

export function buildTablePreviewSql(dbType: string, tableName: string): string {
  if (dbType === 'mongodb') {
    return `db.getCollection(${JSON.stringify(tableName)}).find().limit(100).toArray()`;
  }
  if (dbType === 'mysql') {
    return `SELECT * FROM \`${tableName.replace(/`/g, '``')}\` LIMIT 100`;
  }
  const quoted = tableName.replace(/"/g, '""');
  return `SELECT * FROM "${quoted}" LIMIT 100`;
}

// ==================== Manager ====================

export class DatabaseManager {
  private detectedDatabases: DatabaseInfo[] = [];
  private connections: DbConnection[] = [];
  private activeConnection: DbConnection | null = null;
  private currentTab: DbTab = 'connections';
  private sqlHistory: SqlHistoryEntry[] = [];
  private lastSqlResult: SqlResult | null = null;

  // 数据浏览状态
  private databases: string[] = [];
  private currentDatabase: string = '';
  private tables: TableInfo[] = [];
  private currentTable: string = '';
  private tableData: SqlResult | null = null;
  private columns: ColumnInfo[] = [];

  // 用户管理状态
  private users: DbUser[] = [];

  // UI 状态
  private initialized = false;
  private loading = false;
  private connectionRequestId = 0;
  private browserRequestId = 0;
  private databaseListRequestId = 0;
  private tableListRequestId = 0;
  private tableRequestId = 0;
  private sqlRequestId = 0;
  private pendingConnectionId: string | null = null;
  private sqlDraft = '';

  constructor() {
    this.loadConnectionsFromStorage();
    this.loadSqlHistory();
  }

  // ==================== Lifecycle ====================

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.bindEvents();
      this.initialized = true;
      (window as any).databaseManager = this;
    }
    // Navigation recreates the page shell; rehydrate its active panel each time.
    this.switchTab(this.currentTab);
  }

  private bindEvents(): void {
    document.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement | null)?.closest?.('[data-db-action]') as HTMLElement | undefined;
      if (!target) return;
      // Select elements commit their value on "change", not on "click".
      if (target instanceof HTMLSelectElement && target.getAttribute('data-db-action') === 'select-database') {
        return;
      }
      const action = target.getAttribute('data-db-action') || '';
      void this.handleAction(action, target).catch(error => {
        console.error('数据库操作失败:', error);
        window.showNotification?.(`数据库操作失败: ${error}`, 'error');
      });
    });

    document.addEventListener('change', (e) => {
      const target = e.target;
      if (target instanceof HTMLSelectElement && target.getAttribute('data-db-action') === 'select-database') {
        void this.selectDatabase(target.value).catch(error => {
          console.error('切换数据库失败:', error);
          window.showNotification?.(`切换数据库失败: ${error}`, 'error');
        });
      }
    });

    document.addEventListener('input', (e) => {
      const target = e.target;
      if (target instanceof HTMLTextAreaElement && target.id === 'db-sql-editor') {
        this.sqlDraft = target.value;
      }
    });

    // SQL 执行快捷键
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        const sqlEditor = document.getElementById('db-sql-editor') as HTMLTextAreaElement;
        if (sqlEditor && document.activeElement === sqlEditor) {
          e.preventDefault();
          void this.executeSql().catch(error => {
            console.error('SQL 执行失败:', error);
            window.showNotification?.(`SQL 执行失败: ${error}`, 'error');
          });
        }
      }
    });
  }

  // ==================== Action Router ====================

  private async handleAction(action: string, el: HTMLElement): Promise<void> {
    switch (action) {
      case 'switch-tab': this.switchTab(el.getAttribute('data-tab') as DbTab); break;
      case 'detect': await this.detectDatabases(); break;
      case 'add-connection': this.showAddConnectionModal(); break;
      case 'connect': await this.connectToDatabase(el.getAttribute('data-conn-id') || ''); break;
      case 'disconnect': this.disconnectDatabase(); break;
      case 'service-start': await this.serviceControl(el.getAttribute('data-db-type') || '', 'start'); break;
      case 'service-stop': await this.serviceControl(el.getAttribute('data-db-type') || '', 'stop'); break;
      case 'service-restart': await this.serviceControl(el.getAttribute('data-db-type') || '', 'restart'); break;
      case 'execute-sql': await this.executeSql(); break;
      case 'clear-sql': this.clearSqlEditor(); break;
      case 'select-database': await this.selectDatabase(el.getAttribute('data-name') || ''); break;
      case 'select-table': await this.selectTable(el.getAttribute('data-name') || ''); break;
      case 'refresh-tables': await this.refreshTables(); break;
      case 'list-users': await this.listUsers(); break;
      case 'backup': await this.backupDatabase(); break;
      case 'delete-connection': this.deleteConnection(el.getAttribute('data-conn-id') || ''); break;
      case 'save-connection': await this.saveNewConnection(); break;
      case 'close-modal': this.hideAddConnectionModal(); break;
      case 'history-item': this.loadHistoryItem(parseInt(el.getAttribute('data-index') || '0')); break;
    }
  }

  // ==================== Database Detection ====================

  async detectDatabases(): Promise<void> {
    this.loading = true;
    this.updateUI();
    try {
      this.detectedDatabases = await invoke('db_detect') as DatabaseInfo[];
      window.showNotification?.(`发现 ${this.detectedDatabases.length} 个数据库实例`, 'success');

      // 对每个检测到的数据库尝试本地连接测试
      for (const db of this.detectedDatabases) {
        if (db.status !== 'running') continue;
        try {
          const testSql = db.db_type === 'redis' ? 'PING'
            : db.db_type === 'mongodb' ? 'db.runCommand({ping:1})'
            : 'SELECT 1';
          const result = await invoke<SqlResult>('db_execute_sql', {
            dbType: db.db_type, host: '127.0.0.1', port: db.port || 0,
            username: db.db_type === 'redis' ? '' : 'root',
            password: '', database: '', sql: testSql,
          });
          const error = getSqlResultError(result);
          if (error) throw new Error(error);
          (db as any).connectable = true;
        } catch {
          (db as any).connectable = false;
        }
      }
    } catch (e) {
      console.error('数据库检测失败:', e);
      window.showNotification?.(`检测失败: ${e}`, 'error');
    }
    this.loading = false;
    this.updateUI();
  }

  // ==================== Connection Management ====================

  async connectToDatabase(connId: string): Promise<void> {
    const conn = this.connections.find(c => c.id === connId);
    if (!conn) return;
    const requestId = ++this.connectionRequestId;
    this.pendingConnectionId = connId;

    try {
      // 验证连接（执行一个简单查询）
      const testSql = conn.db_type === 'redis' ? 'PING'
        : conn.db_type === 'mongodb' ? 'db.runCommand({ping:1})'
        : 'SELECT 1';
      const password = conn.password || (conn.encryptedPassword
        ? await invoke<string>('decrypt_password', { encryptedPassword: conn.encryptedPassword })
        : '');
      if (requestId !== this.connectionRequestId) return;

      const result = await invoke<SqlResult>('db_execute_sql', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password,
        database: conn.database || '', sql: testSql,
      });
      const error = getSqlResultError(result);
      if (error) throw new Error(error);
      if (requestId !== this.connectionRequestId) return;

      if (this.activeConnection && this.activeConnection !== conn) {
        this.activeConnection.isConnected = false;
        this.activeConnection.password = '';
      }
      ++this.browserRequestId;
      ++this.sqlRequestId;
      this.loading = false;
      this.databases = [];
      this.currentDatabase = conn.database || '';
      this.tables = [];
      this.currentTable = '';
      this.tableData = null;
      this.columns = [];
      this.users = [];
      this.lastSqlResult = null;
      conn.password = password;
      // Keep the decrypted secret only in runtime state; storage always strips it.
      conn.isConnected = true;
      this.activeConnection = conn;
      this.saveConnectionsToStorage();

      // 加载数据库列表
      await this.loadDatabases();
      if (requestId !== this.connectionRequestId) return;

      window.showNotification?.(`已连接 ${conn.name}`, 'success');
    } catch (e) {
      if (requestId !== this.connectionRequestId) return;
      if (this.activeConnection === conn) {
        this.disconnectDatabase();
      } else {
        conn.isConnected = false;
      }
      window.showNotification?.(`连接失败: ${e}`, 'error');
    } finally {
      if (requestId === this.connectionRequestId) this.pendingConnectionId = null;
    }
    this.updateUI();
  }

  disconnectDatabase(): void {
    ++this.connectionRequestId;
    ++this.browserRequestId;
    ++this.sqlRequestId;
    this.loading = false;
    this.pendingConnectionId = null;
    if (this.activeConnection) {
      this.activeConnection.isConnected = false;
      this.activeConnection.password = '';
      this.activeConnection = null;
    }
    this.databases = [];
    this.tables = [];
    this.currentDatabase = '';
    this.currentTable = '';
    this.tableData = null;
    this.columns = [];
    this.users = [];
    this.lastSqlResult = null;
    this.updateUI();
  }

  // ==================== SQL Execution ====================

  async executeSql(): Promise<void> {
    if (!this.activeConnection) {
      window.showNotification?.('请先连接数据库', 'warning');
      return;
    }

    const editor = document.getElementById('db-sql-editor') as HTMLTextAreaElement;
    if (!editor) return;

    // 支持选中执行
    const sql = editor.selectionStart !== editor.selectionEnd
      ? editor.value.substring(editor.selectionStart, editor.selectionEnd).trim()
      : editor.value.trim();

    if (!sql) return;

    const conn = this.activeConnection;
    const database = this.currentDatabase || conn.database || '';
    const requestId = ++this.sqlRequestId;
    this.loading = true;
    this.updateResultsArea('<div class="db-loading">执行中...</div>');

    try {
      const result = await invoke<SqlResult>('db_execute_sql', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
        database, sql,
      });
      if (requestId !== this.sqlRequestId || conn !== this.activeConnection) return;

      this.lastSqlResult = result;
      this.addToHistory(sql, conn.db_type, database, !result.error, result.row_count);

      if (result.error) {
        this.updateResultsArea(`<div class="db-error">${this.escapeHtml(result.error)}</div>`);
      } else {
        this.renderSqlResults(result);
      }
    } catch (e) {
      if (requestId !== this.sqlRequestId || conn !== this.activeConnection) return;
      this.lastSqlResult = {
        columns: [], rows: [], row_count: 0, execution_time_ms: 0, error: String(e),
      };
      this.addToHistory(sql, conn.db_type, database, false);
      this.updateResultsArea(`<div class="db-error">执行失败: ${this.escapeHtml(String(e))}</div>`);
    } finally {
      if (requestId === this.sqlRequestId) this.loading = false;
    }
  }

  // ==================== Data Browser ====================

  async loadDatabases(): Promise<void> {
    if (!this.activeConnection) return;
    const conn = this.activeConnection;
    const contextId = this.browserRequestId;
    const requestId = ++this.databaseListRequestId;
    try {
      const databases = await invoke<string[]>('db_list_databases', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
      });
      if (requestId !== this.databaseListRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      this.databases = Array.isArray(databases) ? databases : [];
      if (this.databases.length > 0 && !this.databases.includes(this.currentDatabase)) {
        this.currentDatabase = this.databases[0];
      }
    } catch (e) {
      if (requestId !== this.databaseListRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      console.error('加载数据库列表失败:', e);
    }
    this.updateUI();
  }

  async selectDatabase(name: string): Promise<void> {
    if (!this.activeConnection) return;
    ++this.browserRequestId;
    ++this.sqlRequestId;
    this.loading = false;
    this.currentDatabase = name;
    this.currentTable = '';
    this.tableData = null;
    this.tables = [];
    this.columns = [];
    this.lastSqlResult = null;
    this.updateUI();
    await this.refreshTables();
  }

  async refreshTables(): Promise<void> {
    if (!this.activeConnection || !this.currentDatabase) return;
    const conn = this.activeConnection;
    const database = this.currentDatabase;
    const contextId = this.browserRequestId;
    const requestId = ++this.tableListRequestId;
    try {
      const tables = await invoke<TableInfo[]>('db_list_tables', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
        database,
      });
      if (requestId !== this.tableListRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      this.tables = Array.isArray(tables) ? tables : [];
    } catch (e) {
      if (requestId !== this.tableListRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      console.error('加载表列表失败:', e);
    }
    this.updateUI();
  }

  async selectTable(name: string): Promise<void> {
    if (!this.activeConnection || !this.currentDatabase) return;
    this.currentTable = name;
    this.tableData = null;
    this.columns = [];
    const conn = this.activeConnection;
    const database = this.currentDatabase;
    const contextId = this.browserRequestId;
    const requestId = ++this.tableRequestId;
    this.updateUI();

    try {
      const columns = await invoke<ColumnInfo[]>('db_list_columns', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
        database, table: name,
      });
      if (requestId !== this.tableRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;

      const sql = buildTablePreviewSql(conn.db_type, name);
      const tableData = await invoke<SqlResult>('db_execute_sql', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
        database, sql,
      });
      if (requestId !== this.tableRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      this.columns = columns;
      this.tableData = tableData;
    } catch (e) {
      if (requestId !== this.tableRequestId || contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      console.error('加载表数据失败:', e);
    }
    this.updateUI();
  }

  // ==================== User Management ====================

  async listUsers(): Promise<void> {
    if (!this.activeConnection) return;
    const conn = this.activeConnection;
    const contextId = this.browserRequestId;
    try {
      const users = await invoke<DbUser[]>('db_list_users', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
      });
      if (contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      this.users = users;
    } catch (e) {
      if (contextId !== this.browserRequestId || conn !== this.activeConnection) return;
      console.error('加载用户列表失败:', e);
      window.showNotification?.(`加载用户失败: ${e}`, 'error');
    }
    this.updateUI();
  }

  // ==================== Operations ====================

  async serviceControl(dbType: string, action: string): Promise<void> {
    try {
      const result = await invoke('db_service_control', { dbType, action }) as string;
      window.showNotification?.(`${dbType} ${action}: ${result}`, 'success');
      // 刷新检测
      setTimeout(() => this.detectDatabases(), 1000);
    } catch (e) {
      window.showNotification?.(`操作失败: ${e}`, 'error');
    }
  }

  async backupDatabase(): Promise<void> {
    if (!this.activeConnection || !this.currentDatabase) {
      window.showNotification?.('请先选择数据库', 'warning');
      return;
    }
    const conn = this.activeConnection;
    try {
      window.showNotification?.(`正在备份 ${this.currentDatabase}...`, 'info');
      const result = await invoke('db_backup', {
        dbType: conn.db_type, host: conn.host, port: conn.port,
        username: conn.username, password: conn.password,
        database: this.currentDatabase,
      }) as string;
      window.showNotification?.(`备份完成: ${result}`, 'success');
    } catch (e) {
      window.showNotification?.(`备份失败: ${e}`, 'error');
    }
  }

  // ==================== Tab Management ====================

  switchTab(tab: DbTab): void {
    if (!['connections', 'sql', 'browser', 'users', 'ops'].includes(tab)) return;
    this.currentTab = tab;
    // Update tab buttons
    document.querySelectorAll('.db-tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
    });
    // Show/hide panels
    document.querySelectorAll('.db-tab-panel').forEach(panel => {
      (panel as HTMLElement).style.display = panel.id === `db-panel-${tab}` ? '' : 'none';
    });
    this.updateUI();

    // 延迟加载
    if (tab === 'users' && this.users.length === 0 && this.activeConnection) {
      this.listUsers();
    }
    if (tab === 'browser' && this.databases.length === 0 && this.activeConnection) {
      this.loadDatabases();
    }
  }

  // ==================== Connection Storage ====================

  private loadConnectionsFromStorage(): void {
    try {
      const data = localStorage.getItem('lovelyres-db-connections');
      if (data) this.connections = normalizeStoredDbConnections(JSON.parse(data));
    } catch { /* ignore */ }
  }

  private saveConnectionsToStorage(): void {
    try {
      const safe = serializeDbConnections(this.connections);
      localStorage.setItem('lovelyres-db-connections', JSON.stringify(safe));
    } catch { /* ignore */ }
  }

  // ==================== SQL History ====================

  private loadSqlHistory(): void {
    try {
      const data = localStorage.getItem('lovelyres-sql-history');
      if (data) {
        const entries: unknown = JSON.parse(data);
        this.sqlHistory = Array.isArray(entries)
          ? entries.filter((entry): entry is SqlHistoryEntry =>
            entry !== null && typeof entry === 'object'
            && typeof entry.sql === 'string'
            && typeof entry.db_type === 'string'
            && typeof entry.database === 'string'
            && typeof entry.timestamp === 'number'
            && typeof entry.success === 'boolean'
            && (entry.row_count === undefined || typeof entry.row_count === 'number'),
          ).slice(0, 50)
          : [];
      }
    } catch { /* ignore */ }
  }

  private addToHistory(sql: string, dbType: string, database: string, success: boolean, rowCount?: number): void {
    this.sqlHistory.unshift({
      sql, db_type: dbType, database, timestamp: Date.now(), success, row_count: rowCount,
    });
    if (this.sqlHistory.length > 50) this.sqlHistory.length = 50;
    try {
      localStorage.setItem('lovelyres-sql-history', JSON.stringify(this.sqlHistory));
    } catch { /* ignore */ }
  }

  private loadHistoryItem(index: number): void {
    const entry = this.sqlHistory[index];
    if (!entry) return;
    const editor = document.getElementById('db-sql-editor') as HTMLTextAreaElement;
    if (editor) editor.value = entry.sql;
    this.sqlDraft = entry.sql;
  }

  // ==================== Modal ====================

  showAddConnectionModal(): void {
    const modal = document.getElementById('db-add-modal');
    if (modal) modal.style.display = 'flex';
  }

  hideAddConnectionModal(): void {
    const modal = document.getElementById('db-add-modal');
    if (modal) modal.style.display = 'none';
  }

  async saveNewConnection(): Promise<void> {
    const name = (document.getElementById('db-add-name') as HTMLInputElement)?.value?.trim();
    const dbType = (document.getElementById('db-add-type') as HTMLSelectElement)?.value;
    const host = (document.getElementById('db-add-host') as HTMLInputElement)?.value?.trim() || '127.0.0.1';
    const port = Number((document.getElementById('db-add-port') as HTMLInputElement)?.value);
    const username = (document.getElementById('db-add-username') as HTMLInputElement)?.value?.trim() || 'root';
    const password = (document.getElementById('db-add-password') as HTMLInputElement)?.value || '';
    const database = (document.getElementById('db-add-database') as HTMLInputElement)?.value?.trim() || '';

    if (!name) {
      window.showNotification?.('请输入连接名称', 'warning');
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      window.showNotification?.('端口必须是 1 到 65535 的整数', 'warning');
      return;
    }

    let encryptedPassword: string | undefined;
    if (password) {
      try {
        encryptedPassword = await invoke<string>('encrypt_password', { password });
      } catch (error) {
        window.showNotification?.(`保存密码失败: ${error}`, 'error');
        return;
      }
    }

    const conn: DbConnection = {
      id: `db-${Date.now()}-${Math.random().toString(36).slice(2)}`, db_type: dbType, host, port,
      username, password, encryptedPassword, database, name, isConnected: false,
    };

    this.connections.push(conn);
    this.saveConnectionsToStorage();
    this.hideAddConnectionModal();
    this.updateUI();
    window.showNotification?.(`已添加连接: ${name}`, 'success');
  }

  deleteConnection(connId: string): void {
    if (this.pendingConnectionId === connId) {
      ++this.connectionRequestId;
      this.pendingConnectionId = null;
    }
    this.connections = this.connections.filter(c => c.id !== connId);
    if (this.activeConnection?.id === connId) {
      this.disconnectDatabase();
    }
    this.saveConnectionsToStorage();
    this.updateUI();
  }

  // ==================== UI Helpers ====================

  private updateUI(): void {
    // 由 renderer 负责（通过 getters 获取状态）
    const content = document.getElementById(`db-panel-${this.currentTab}`);
    if (content) {
      // Trigger re-render based on current tab
      const renderer = (window as any).app?.modernUIRenderer?.databaseRenderer;
      if (renderer?.renderTabContent) {
        let focusedSelection: { start: number; end: number; direction: 'forward' | 'backward' | 'none' } | null = null;
        if (this.currentTab === 'sql') {
          const editor = content.querySelector<HTMLTextAreaElement>('#db-sql-editor');
          if (editor) {
            this.sqlDraft = editor.value;
            if (document.activeElement === editor) {
              focusedSelection = {
                start: editor.selectionStart,
                end: editor.selectionEnd,
                direction: editor.selectionDirection,
              };
            }
          }
        }
        content.innerHTML = renderer.renderTabContent(this.currentTab, this);
        if (this.currentTab === 'sql') {
          const editor = content.querySelector<HTMLTextAreaElement>('#db-sql-editor');
          if (editor) {
            editor.value = this.sqlDraft;
            if (focusedSelection) {
              editor.focus();
              editor.setSelectionRange(
                focusedSelection.start,
                focusedSelection.end,
                focusedSelection.direction,
              );
            }
          }
        }
      }
    }
  }

  private updateResultsArea(html: string): void {
    const area = document.getElementById('db-results-area');
    if (area) area.innerHTML = html;
  }

  private renderSqlResults(result: SqlResult): void {
    if (!result.columns.length) {
      this.updateResultsArea(`<div class="db-results-info">执行成功，影响 ${result.affected_rows || 0} 行 (${result.execution_time_ms}ms)</div>`);
      return;
    }

    const html = `
      <table class="db-results-table">
        <thead><tr>${result.columns.map(c => `<th>${this.escapeHtml(c)}</th>`).join('')}</tr></thead>
        <tbody>${result.rows.map(row =>
          `<tr>${row.map(cell => `<td>${this.escapeHtml(cell ?? 'NULL')}</td>`).join('')}</tr>`
        ).join('')}</tbody>
      </table>
      <div class="db-results-info">${result.row_count} 行 · ${result.execution_time_ms}ms</div>
    `;
    this.updateResultsArea(html);
  }

  private clearSqlEditor(): void {
    const editor = document.getElementById('db-sql-editor') as HTMLTextAreaElement;
    if (editor) editor.value = '';
    this.sqlDraft = '';
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ==================== Getters (for renderer) ====================

  getDetectedDatabases(): DatabaseInfo[] { return this.detectedDatabases; }
  getConnections(): DbConnection[] { return this.connections; }
  getActiveConnection(): DbConnection | null { return this.activeConnection; }
  getCurrentTab(): DbTab { return this.currentTab; }
  getSqlHistory(): SqlHistoryEntry[] { return this.sqlHistory; }
  getLastSqlResult(): SqlResult | null { return this.lastSqlResult; }
  getDatabases(): string[] { return this.databases; }
  getCurrentDatabase(): string { return this.currentDatabase; }
  getTables(): TableInfo[] { return this.tables; }
  getCurrentTable(): string { return this.currentTable; }
  getTableData(): SqlResult | null { return this.tableData; }
  getColumns(): ColumnInfo[] { return this.columns; }
  getUsers(): DbUser[] { return this.users; }
  isLoading(): boolean { return this.loading; }
}

export const databaseManager = new DatabaseManager();

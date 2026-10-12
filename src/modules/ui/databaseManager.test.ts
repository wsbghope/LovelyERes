import { afterEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

import {
  buildTablePreviewSql,
  DatabaseManager,
  getSqlResultError,
  normalizeStoredDbConnections,
  serializeDbConnections,
} from './databaseManager';
import { DatabaseRenderer } from './databaseRenderer';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());

describe('buildTablePreviewSql', () => {
  it('quotes relational identifiers returned by an untrusted server', () => {
    expect(buildTablePreviewSql('mysql', 'audit`log')).toBe(
      'SELECT * FROM `audit``log` LIMIT 100',
    );
    expect(buildTablePreviewSql('postgresql', 'audit"log')).toBe(
      'SELECT * FROM "audit""log" LIMIT 100',
    );
  });

  it('uses a string argument for MongoDB collection names', () => {
    expect(buildTablePreviewSql('mongodb', 'events); quit(); //')).toBe(
      'db.getCollection("events); quit(); //").find().limit(100).toArray()',
    );
  });
});

describe('database connection state', () => {
  const connection = {
    id: 'db-1',
    db_type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    username: 'root',
    password: 'plain-secret',
    encryptedPassword: 'encrypted-secret',
    name: 'local',
    isConnected: true,
  };

  it('does not restore stale runtime state or plaintext passwords', () => {
    expect(normalizeStoredDbConnections([connection])).toEqual([
      expect.objectContaining({
        password: '',
        encryptedPassword: 'encrypted-secret',
        isConnected: false,
      }),
    ]);
  });

  it('drops malformed stored records before rendering them', () => {
    expect(normalizeStoredDbConnections([
      { ...connection, port: '3306' },
      { ...connection, port: 70000 },
      null,
    ])).toEqual([]);
  });

  it('persists encrypted credentials but not runtime connection state', () => {
    expect(serializeDbConnections([connection])).toEqual([
      expect.objectContaining({
        password: '',
        encryptedPassword: 'encrypted-secret',
        isConnected: false,
      }),
    ]);
  });

  it('surfaces backend SQL errors to connection checks', () => {
    expect(getSqlResultError({
      columns: [],
      rows: [],
      row_count: 0,
      execution_time_ms: 1,
      error: 'authentication failed',
    })).toBe('authentication failed');
  });
});

describe('database page interactions', () => {
  function setupPage(savedConnections: unknown[] = []) {
    const renderer = new DatabaseRenderer();
    const panelIds = [...renderer.render().matchAll(/id="(db-panel-[^"]+)"/g)]
      .map(match => match[1]);
    const panels = new Map(panelIds.map(id => [id, {
      id,
      style: { display: id === 'db-panel-connections' ? '' : 'none' },
      innerHTML: '',
      querySelector: () => null,
    }]));
    const listeners = new Map<string, (event: { target: unknown }) => void>();
    const sqlEditor = { value: 'SELECT 1', selectionStart: 0, selectionEnd: 0 };
    const document = {
      addEventListener: vi.fn((event: string, handler: (event: { target: unknown }) => void) => {
        listeners.set(event, handler);
      }),
      querySelectorAll: vi.fn((selector: string) =>
        selector === '.db-tab-panel' ? [...panels.values()] : []),
      getElementById: vi.fn((id: string) =>
        id === 'db-sql-editor' ? sqlEditor : panels.get(id) ?? null),
    };
    class FakeSelect {
      constructor(public value: string) {}
      getAttribute(attribute: string) {
        return attribute === 'data-db-action' ? 'select-database' : null;
      }
      closest() { return this; }
    }
    class FakeTextArea {}
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => key === 'lovelyres-db-connections'
        ? JSON.stringify(savedConnections) : null,
      setItem: vi.fn(),
    });
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', {
      app: { modernUIRenderer: { databaseRenderer: renderer } },
      showNotification: vi.fn(),
    });
    vi.stubGlobal('HTMLSelectElement', FakeSelect);
    vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
    return { manager: new DatabaseManager(), panels, listeners, FakeSelect };
  }

  it('renders the initial panel and switches to a visible populated panel', async () => {
    const { manager, panels } = setupPage();
    await manager.initialize();
    expect(panels.get('db-panel-connections')?.innerHTML).toContain('已保存的连接');

    manager.switchTab('sql');
    expect(panels.get('db-panel-connections')?.style.display).toBe('none');
    expect(panels.get('db-panel-sql')?.style.display).toBe('');
    expect(panels.get('db-panel-sql')?.innerHTML).toContain('db-sql-editor');

    panels.get('db-panel-sql')!.innerHTML = '';
    await manager.initialize();
    expect(panels.get('db-panel-sql')?.innerHTML).toContain('db-sql-editor');
  });

  it('uses the selected database value on change, not the select click', async () => {
    const connection = {
      id: 'db-1', name: 'local', db_type: 'mysql', host: '127.0.0.1',
      port: 3306, username: 'root', password: '', isConnected: false,
    };
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'db_execute_sql') return { error: null, columns: [], rows: [], row_count: 0 };
      if (command === 'db_list_databases') return ['one', 'two'];
      if (command === 'db_list_tables') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { manager, listeners, FakeSelect } = setupPage([connection]);
    await manager.initialize();
    await manager.connectToDatabase('db-1');
    const select = new FakeSelect('two');
    listeners.get('click')?.({ target: select });
    expect(vi.mocked(invoke)).not.toHaveBeenCalledWith('db_list_tables', expect.anything());
    listeners.get('change')?.({ target: select });
    await vi.waitFor(() => {
      expect(vi.mocked(invoke)).toHaveBeenCalledWith(
        'db_list_tables', expect.objectContaining({ database: 'two' }),
      );
    });
  });

  it('ignores delayed table results after switching databases', async () => {
    const connection = {
      id: 'db-1', name: 'local', db_type: 'mysql', host: '127.0.0.1',
      port: 3306, username: 'root', password: '', isConnected: false,
    };
    let resolveOldTables!: (tables: { name: string }[]) => void;
    const oldTables = new Promise<{ name: string }[]>(resolve => {
      resolveOldTables = resolve;
    });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      if (command === 'db_execute_sql') return { error: null, columns: [], rows: [], row_count: 0 };
      if (command === 'db_list_databases') return ['old', 'new'];
      if (command === 'db_list_tables') {
        return (args as { database: string }).database === 'old'
          ? oldTables : [{ name: 'current' }];
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { manager } = setupPage([connection]);
    await manager.initialize();
    await manager.connectToDatabase('db-1');

    const pending = manager.selectDatabase('old');
    await manager.selectDatabase('new');
    resolveOldTables([{ name: 'stale' }]);
    await pending;
    expect(manager.getTables()).toEqual([{ name: 'current' }]);
    expect(manager.getCurrentDatabase()).toBe('new');
  });

  it('does not reactivate a deleted connection after its check completes', async () => {
    const connection = {
      id: 'db-1', name: 'local', db_type: 'mysql', host: '127.0.0.1',
      port: 3306, username: 'root', password: '', isConnected: false,
    };
    let finishCheck!: (result: object) => void;
    vi.mocked(invoke).mockImplementation((command) => {
      if (command === 'db_execute_sql') {
        return new Promise(resolve => { finishCheck = resolve; });
      }
      throw new Error(`Unexpected command: ${command}`);
    });
    const { manager } = setupPage([connection]);
    await manager.initialize();
    const pending = manager.connectToDatabase('db-1');
    manager.deleteConnection('db-1');
    finishCheck({ error: null });
    await pending;
    expect(manager.getActiveConnection()).toBeNull();
    expect(manager.getConnections()).toEqual([]);
  });

  it('ignores a SQL result that arrives after disconnecting', async () => {
    const connection = {
      id: 'db-1', name: 'local', db_type: 'mysql', host: '127.0.0.1',
      port: 3306, username: 'root', password: '', isConnected: false,
    };
    let finishSql!: (result: object) => void;
    let sqlCalls = 0;
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === 'db_execute_sql') {
        if (sqlCalls++ === 0) return { error: null };
        return new Promise(resolve => { finishSql = resolve; });
      }
      if (command === 'db_list_databases') return [];
      throw new Error(`Unexpected command: ${command}`);
    });
    const { manager } = setupPage([connection]);
    await manager.initialize();
    await manager.connectToDatabase('db-1');
    const pending = manager.executeSql();
    manager.disconnectDatabase();
    finishSql({ columns: ['secret'], rows: [['old']], row_count: 1, execution_time_ms: 5 });
    await pending;
    expect(manager.getLastSqlResult()).toBeNull();
    expect(manager.isLoading()).toBe(false);
  });
});

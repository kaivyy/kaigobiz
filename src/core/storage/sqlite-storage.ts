import fs from 'fs';
import path from 'path';
import { StorageAdapter, SessionData, TransactionData, PaymentOrder } from './storage.interface';

// Dynamic load of native node:sqlite so bundlers/Vite without node:sqlite built-in mappings don't fail
const nodeSqlite: any = (() => {
  try {
    const req = typeof require !== 'undefined' ? require : (globalThis as any).require;
    return req('node' + ':sqlite');
  } catch {
    return null;
  }
})();

export const DatabaseSync = nodeSqlite ? nodeSqlite.DatabaseSync : class MockDb {};

export interface SqliteStorageConfig {
  dbPath?: string;
  enableWal?: boolean;
  busyTimeout?: number;
  autoMigrateJson?: boolean;
  jsonBaseDir?: string;
}

export class SqliteStorageAdapter implements StorageAdapter {
  private db: DatabaseSync;
  private dbPath: string;

  constructor(config?: SqliteStorageConfig) {
    const baseDir = config?.jsonBaseDir || process.cwd();
    this.dbPath = config?.dbPath || path.join(baseDir, '.kaigobiz.db');

    if (this.dbPath !== ':memory:') {
      const dir = path.dirname(this.dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new DatabaseSync(this.dbPath);
    this.initPragmas(config);
    this.initSchema();

    if (config?.autoMigrateJson !== false && this.dbPath !== ':memory:') {
      this.migrateJsonFiles(baseDir);
    }
  }

  private initPragmas(config?: SqliteStorageConfig) {
    const busyTimeout = config?.busyTimeout ?? 5000;
    this.db.exec(`PRAGMA busy_timeout = ${busyTimeout};`);

    if (this.dbPath !== ':memory:' && config?.enableWal !== false) {
      try {
        this.db.exec('PRAGMA journal_mode = WAL;');
        this.db.exec('PRAGMA synchronous = NORMAL;');
      } catch {
        // In-memory or environments where WAL is unsupported
      }
    }
  }

  private initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payment_orders (
        payment_id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        amount REAL NOT NULL,
        raw_amount REAL,
        unique_code INTEGER,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        paid_at TEXT,
        transaction_id TEXT,
        callback_url TEXT,
        callback_status TEXT,
        callback_retries INTEGER DEFAULT 0,
        last_callback_attempt TEXT,
        qris_string TEXT,
        qris_qr_url TEXT
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_order_amount
        ON payment_orders(amount) WHERE status = 'PENDING' AND unique_code IS NOT NULL;

      CREATE INDEX IF NOT EXISTS idx_orders_status_expires
        ON payment_orders(status, expires_at);

      CREATE INDEX IF NOT EXISTS idx_orders_created_at
        ON payment_orders(created_at);

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        amount REAL NOT NULL,
        description TEXT,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL,
        raw TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tx_timestamp
        ON transactions(timestamp);

      CREATE INDEX IF NOT EXISTS idx_tx_amount
        ON transactions(amount);
    `);
  }

  private migrateJsonFiles(baseDir: string) {
    try {
      // 1. Migrate session if empty
      const sessionFile = path.join(baseDir, '.kaigobiz-session.json');
      if (fs.existsSync(sessionFile)) {
        const count = this.db.prepare('SELECT COUNT(*) as count FROM session').get() as { count: number };
        if (count.count === 0) {
          const raw = fs.readFileSync(sessionFile, 'utf-8');
          const data = JSON.parse(raw);
          if (data && data.access_token) {
            this.db.prepare('INSERT OR REPLACE INTO session (id, data, updated_at) VALUES (1, ?, ?)').run(
              raw,
              data.updated_at || new Date().toISOString()
            );
          }
        }
      }

      // 2. Migrate orders if empty
      const ordersFile = path.join(baseDir, '.kaigobiz-orders.json');
      if (fs.existsSync(ordersFile)) {
        const count = this.db.prepare('SELECT COUNT(*) as count FROM payment_orders').get() as { count: number };
        if (count.count === 0) {
          const raw = fs.readFileSync(ordersFile, 'utf-8');
          const orders = JSON.parse(raw);
          if (Array.isArray(orders)) {
            for (const o of orders) {
              try {
                this.savePaymentOrderSync(o);
              } catch {
                // Ignore duplicates or constraint issues during migration
              }
            }
          }
        }
      }

      // 3. Migrate transactions if empty
      const txFile = path.join(baseDir, '.kaigobiz-tx.json');
      if (fs.existsSync(txFile)) {
        const count = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
        if (count.count === 0) {
          const raw = fs.readFileSync(txFile, 'utf-8');
          const txs = JSON.parse(raw);
          if (Array.isArray(txs)) {
            for (const t of txs) {
              try {
                this.saveTransactionSync(t);
              } catch {
                // Ignore duplicates
              }
            }
          }
        }
      }
    } catch {
      // Non-fatal if JSON migration has parsing error
    }
  }

  async getSession(): Promise<SessionData | null> {
    try {
      const row = this.db.prepare('SELECT data FROM session WHERE id = 1').get() as { data: string } | undefined;
      if (!row || !row.data) return null;
      return JSON.parse(row.data);
    } catch {
      return null;
    }
  }

  async saveSession(session: SessionData): Promise<boolean> {
    try {
      const json = JSON.stringify(session);
      const updatedAt = session.updated_at || new Date().toISOString();
      this.db.prepare('INSERT OR REPLACE INTO session (id, data, updated_at) VALUES (1, ?, ?)').run(json, updatedAt);
      return true;
    } catch {
      return false;
    }
  }

  async clearSession(): Promise<boolean> {
    try {
      this.db.prepare('DELETE FROM session WHERE id = 1').run();
      return true;
    } catch {
      return false;
    }
  }

  private saveTransactionSync(tx: TransactionData): boolean {
    const rawStr = tx.raw ? JSON.stringify(tx.raw) : null;
    this.db.prepare(`
      INSERT OR REPLACE INTO transactions (id, amount, description, timestamp, status, raw)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(tx.id, tx.amount, tx.description || null, tx.timestamp, tx.status, rawStr);
    return true;
  }

  async saveTransaction(tx: TransactionData): Promise<boolean> {
    try {
      return this.saveTransactionSync(tx);
    } catch {
      return false;
    }
  }

  async saveTransactions(txs: TransactionData[]): Promise<boolean> {
    if (!txs || txs.length === 0) return true;
    try {
      this.db.exec('BEGIN IMMEDIATE;');
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO transactions (id, amount, description, timestamp, status, raw)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const tx of txs) {
        const rawStr = tx.raw ? JSON.stringify(tx.raw) : null;
        stmt.run(tx.id, tx.amount, tx.description || null, tx.timestamp, tx.status, rawStr);
      }
      this.db.exec('COMMIT;');
      return true;
    } catch {
      try { this.db.exec('ROLLBACK;'); } catch {}
      return false;
    }
  }

  async getTransactions(): Promise<TransactionData[]> {
    try {
      const rows = this.db.prepare(`
        SELECT id, amount, description, timestamp, status, raw
        FROM transactions
        ORDER BY timestamp DESC
      `).all() as any[];

      return rows.map((r) => ({
        id: r.id,
        amount: Number(r.amount),
        description: r.description || undefined,
        timestamp: r.timestamp,
        status: r.status,
        raw: r.raw ? JSON.parse(r.raw) : undefined,
      }));
    } catch {
      return [];
    }
  }

  private rowToPaymentOrder(r: any): PaymentOrder {
    return {
      paymentId: r.payment_id,
      orderId: r.order_id,
      amount: Number(r.amount),
      rawAmount: r.raw_amount !== null && r.raw_amount !== undefined ? Number(r.raw_amount) : undefined,
      uniqueCode: r.unique_code !== null && r.unique_code !== undefined ? Number(r.unique_code) : undefined,
      status: r.status,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      paidAt: r.paid_at || undefined,
      transactionId: r.transaction_id || undefined,
      callbackUrl: r.callback_url || undefined,
      callbackStatus: r.callback_status || undefined,
      callbackRetries: r.callback_retries !== null && r.callback_retries !== undefined ? Number(r.callback_retries) : 0,
      lastCallbackAttempt: r.last_callback_attempt || undefined,
      qrisString: r.qris_string || '',
      qrisQrUrl: r.qris_qr_url || undefined,
    };
  }

  private savePaymentOrderSync(order: PaymentOrder): boolean {
    this.db.prepare(`
      INSERT INTO payment_orders (
        payment_id, order_id, amount, raw_amount, unique_code, status,
        created_at, expires_at, paid_at, transaction_id, callback_url,
        callback_status, callback_retries, last_callback_attempt, qris_string, qris_qr_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(payment_id) DO UPDATE SET
        order_id = excluded.order_id,
        amount = excluded.amount,
        raw_amount = excluded.raw_amount,
        unique_code = excluded.unique_code,
        status = excluded.status,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at,
        paid_at = excluded.paid_at,
        transaction_id = excluded.transaction_id,
        callback_url = excluded.callback_url,
        callback_status = excluded.callback_status,
        callback_retries = excluded.callback_retries,
        last_callback_attempt = excluded.last_callback_attempt,
        qris_string = excluded.qris_string,
        qris_qr_url = excluded.qris_qr_url
    `).run(
      order.paymentId,
      order.orderId,
      order.amount,
      order.rawAmount ?? null,
      order.uniqueCode ?? null,
      order.status,
      order.createdAt,
      order.expiresAt,
      order.paidAt ?? null,
      order.transactionId ?? null,
      order.callbackUrl ?? null,
      order.callbackStatus ?? null,
      order.callbackRetries ?? 0,
      order.lastCallbackAttempt ?? null,
      order.qrisString ?? null,
      order.qrisQrUrl ?? null
    );
    return true;
  }

  async savePaymentOrder(order: PaymentOrder): Promise<boolean> {
    try {
      return this.savePaymentOrderSync(order);
    } catch (err: any) {
      // Bubble up unique constraint error so callers can retry candidate unique codes
      if (err.message && err.message.includes('UNIQUE constraint failed')) {
        throw err;
      }
      return false;
    }
  }

  async getPaymentOrder(paymentId: string): Promise<PaymentOrder | null> {
    try {
      const row = this.db.prepare('SELECT * FROM payment_orders WHERE payment_id = ?').get(paymentId);
      if (!row) return null;
      return this.rowToPaymentOrder(row);
    } catch {
      return null;
    }
  }

  async getAllPaymentOrders(): Promise<PaymentOrder[]> {
    try {
      const rows = this.db.prepare('SELECT * FROM payment_orders ORDER BY created_at DESC').all();
      return rows.map((r) => this.rowToPaymentOrder(r));
    } catch {
      return [];
    }
  }

  async backup(targetPath: string): Promise<boolean> {
    try {
      const dir = path.dirname(targetPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
      }
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      this.db.prepare('VACUUM INTO ?').run(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    } catch {}
    this.db.close();
  }
}

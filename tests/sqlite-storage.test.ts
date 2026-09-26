import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStorageAdapter, DatabaseSync } from '../src/core/storage/sqlite-storage';
import fs from 'fs';
import path from 'path';
import os from 'os';

describe('SqliteStorageAdapter', () => {
  let storage: SqliteStorageAdapter;

  beforeEach(() => {
    storage = new SqliteStorageAdapter({ dbPath: ':memory:', autoMigrateJson: false });
  });

  afterEach(() => {
    storage.close();
  });

  describe('Session Management', () => {
    it('should return null when no session exists', async () => {
      const session = await storage.getSession();
      expect(session).toBeNull();
    });

    it('should save, retrieve, and clear session data correctly', async () => {
      const mockSession = {
        phone_number: '628123456789',
        merchant_id: 'G12345678',
        outlet_name: 'Warung Kopi Test',
        access_token: 'acc_token_123',
        refresh_token: 'ref_token_456',
        cookie: 'access_token=acc_token_123',
        expires_at: new Date(Date.now() + 86400000).toISOString(),
      };

      const saved = await storage.saveSession(mockSession);
      expect(saved).toBe(true);

      const retrieved = await storage.getSession();
      expect(retrieved).not.toBeNull();
      expect(retrieved?.phone_number).toBe(mockSession.phone_number);
      expect(retrieved?.access_token).toBe(mockSession.access_token);
      expect(retrieved?.outlet_name).toBe(mockSession.outlet_name);

      const cleared = await storage.clearSession?.();
      expect(cleared).toBe(true);

      const afterClear = await storage.getSession();
      expect(afterClear).toBeNull();
    });
  });

  describe('Transaction Storage', () => {
    it('should save single transaction and retrieve it', async () => {
      const tx = {
        id: 'tx_001',
        amount: 25000,
        description: 'QRIS BCA',
        timestamp: '2026-09-26T10:00:00.000Z',
        status: 'COMPLETED' as const,
      };

      await storage.saveTransaction(tx);
      const all = await storage.getTransactions();
      expect(all).toHaveLength(1);
      expect(all[0].id).toBe('tx_001');
      expect(all[0].amount).toBe(25000);
    });

    it('should save multiple transactions in a batch and sort by timestamp descending', async () => {
      const txs = [
        { id: 'tx_1', amount: 10000, timestamp: '2026-09-26T08:00:00Z', status: 'COMPLETED' as const },
        { id: 'tx_2', amount: 20000, timestamp: '2026-09-26T09:00:00Z', status: 'COMPLETED' as const },
        { id: 'tx_3', amount: 30000, timestamp: '2026-09-26T07:00:00Z', status: 'COMPLETED' as const },
      ];

      await storage.saveTransactions?.(txs);
      const all = await storage.getTransactions();
      expect(all).toHaveLength(3);
      expect(all[0].id).toBe('tx_2'); // latest (09:00)
      expect(all[1].id).toBe('tx_1'); // (08:00)
      expect(all[2].id).toBe('tx_3'); // earliest (07:00)
    });
  });

  describe('Payment Orders & Partial Unique Index', () => {
    it('should save and retrieve payment order', async () => {
      const order = {
        paymentId: 'pay_123',
        orderId: 'INV-001',
        amount: 50123,
        rawAmount: 50000,
        uniqueCode: 123,
        status: 'PENDING' as const,
        createdAt: '2026-09-26T10:00:00Z',
        expiresAt: '2026-09-26T10:05:00Z',
        qrisString: '000201...',
      };

      await storage.savePaymentOrder(order);
      const retrieved = await storage.getPaymentOrder('pay_123');
      expect(retrieved).not.toBeNull();
      expect(retrieved?.orderId).toBe('INV-001');
      expect(retrieved?.amount).toBe(50123);
      expect(retrieved?.uniqueCode).toBe(123);
    });

    it('should enforce partial uniqueness for PENDING orders with identical amounts', async () => {
      const order1 = {
        paymentId: 'pay_1',
        orderId: 'INV-1',
        amount: 50123,
        status: 'PENDING' as const,
        createdAt: '2026-09-26T10:00:00Z',
        expiresAt: '2026-09-26T10:05:00Z',
        qrisString: '000201...',
      };

      const order2 = {
        paymentId: 'pay_2',
        orderId: 'INV-2',
        amount: 50123, // Identical amount
        status: 'PENDING' as const,
        createdAt: '2026-09-26T10:01:00Z',
        expiresAt: '2026-09-26T10:06:00Z',
        qrisString: '000201...',
      };

      await storage.savePaymentOrder(order1);

      // Attempting to save order2 with identical pending amount must throw UNIQUE constraint error
      await expect(storage.savePaymentOrder(order2)).rejects.toThrow(/UNIQUE constraint failed/);

      // If order1 is resolved (e.g. marked PAID), order2 with identical amount must now succeed
      order1.status = 'PAID' as any;
      await storage.savePaymentOrder(order1);

      const savedOrder2 = await storage.savePaymentOrder(order2);
      expect(savedOrder2).toBe(true);

      const all = await storage.getAllPaymentOrders?.();
      expect(all).toHaveLength(2);
    });
  });

  describe('Auto Migration & Hot Backup', () => {
    it('should auto-migrate JSON data on initialization', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaigobiz-migrate-test-'));
      const dbFile = path.join(tempDir, 'test.db');

      // Create mock JSON files
      const mockSession = { phone_number: '628999999', access_token: 'acc_migrated' };
      fs.writeFileSync(path.join(tempDir, '.kaigobiz-session.json'), JSON.stringify(mockSession));

      const mockOrders = [
        { paymentId: 'mig_1', orderId: 'MIG-1', amount: 15000, status: 'PAID', createdAt: '2026-09-26T00:00:00Z', expiresAt: '2026-09-26T00:05:00Z' },
      ];
      fs.writeFileSync(path.join(tempDir, '.kaigobiz-orders.json'), JSON.stringify(mockOrders));

      const mockTxs = [
        { id: 'tx_mig_1', amount: 15000, timestamp: '2026-09-26T00:02:00Z', status: 'COMPLETED' },
      ];
      fs.writeFileSync(path.join(tempDir, '.kaigobiz-tx.json'), JSON.stringify(mockTxs));

      // Initialize SqliteStorageAdapter pointing to tempDir
      const diskStorage = new SqliteStorageAdapter({
        dbPath: dbFile,
        jsonBaseDir: tempDir,
        autoMigrateJson: true,
      });

      const migratedSession = await diskStorage.getSession();
      expect(migratedSession?.phone_number).toBe('628999999');

      const migratedOrders = await diskStorage.getAllPaymentOrders?.();
      expect(migratedOrders).toHaveLength(1);
      expect(migratedOrders?.[0].paymentId).toBe('mig_1');

      const migratedTxs = await diskStorage.getTransactions();
      expect(migratedTxs).toHaveLength(1);
      expect(migratedTxs[0].id).toBe('tx_mig_1');

      // Test backup
      const backupPath = path.join(tempDir, 'backup.db');
      const backupOk = await diskStorage.backup?.(backupPath);
      expect(backupOk).toBe(true);
      expect(fs.existsSync(backupPath)).toBe(true);

      // Verify backup is valid SQLite database
      const verifyDb = new DatabaseSync(backupPath);
      const rows = verifyDb.prepare('SELECT count(*) as count FROM payment_orders').get() as { count: number };
      expect(rows.count).toBe(1);
      verifyDb.close();

      diskStorage.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    });
  });
});

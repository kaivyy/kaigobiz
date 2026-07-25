import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FileStorageAdapter } from '../src/core/storage/file-storage';
import fs from 'fs';
import path from 'path';

describe('FileStorageAdapter', () => {
  const testDir = path.join(__dirname, 'temp');
  let storage: FileStorageAdapter;

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    storage = new FileStorageAdapter({
      sessionFile: path.join(testDir, 'session.json'),
      txFile: path.join(testDir, 'transactions.json'),
      ordersFile: path.join(testDir, 'orders.json'),
    });
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should save and load session correctly', async () => {
    const dummySession = {
      phone_number: '628123456789',
      merchant_id: 'merchant_123',
      outlet_name: 'Warung Kopi',
      access_token: 'access_123',
      refresh_token: 'refresh_123',
      expires_at: new Date().toISOString(),
    };

    await storage.saveSession(dummySession);
    const loaded = await storage.getSession();
    expect(loaded).toEqual(dummySession);
  });

  it('should return null when session file does not exist', async () => {
    const loaded = await storage.getSession();
    expect(loaded).toBeNull();
  });

  it('should save and retrieve transactions correctly', async () => {
    const dummyTx = {
      id: 'tx_123',
      amount: 15000,
      description: 'Payment for Coffee',
      timestamp: new Date().toISOString(),
      status: 'COMPLETED' as const,
    };

    await storage.saveTransaction(dummyTx);
    const txs = await storage.getTransactions();
    expect(txs).toHaveLength(1);
    expect(txs[0]).toEqual(dummyTx);
  });

  it('should save and retrieve payment orders correctly', async () => {
    const dummyOrder = {
      paymentId: 'pay_123',
      orderId: 'ord_456',
      amount: 25000,
      qrisString: '000201010212...',
      status: 'PENDING' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    };

    await storage.savePaymentOrder(dummyOrder);
    const loaded = await storage.getPaymentOrder('pay_123');
    expect(loaded).toEqual(dummyOrder);
  });

  it('should update existing payment order when saved with same paymentId', async () => {
    const order = {
      paymentId: 'pay_123',
      orderId: 'ord_456',
      amount: 25000,
      qrisString: '000201010212...',
      status: 'PENDING' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 900000).toISOString(),
    };

    await storage.savePaymentOrder(order);
    const updatedOrder = { ...order, status: 'PAID' as const };
    await storage.savePaymentOrder(updatedOrder);

    const loaded = await storage.getPaymentOrder('pay_123');
    expect(loaded?.status).toBe('PAID');
  });
});

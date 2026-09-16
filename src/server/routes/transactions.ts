import { Hono } from 'hono';
import { FileStorageAdapter } from '../../core/storage/file-storage';
import { SessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';

const transactions = new Hono();
const storage = new FileStorageAdapter();
const manager = new SessionManager(storage);
const client = new GoBizClient();

transactions.get('/', async (c) => {
  const session = await manager.refreshIfNeeded();
  if (!session) {
    const saved = (await storage.getTransactions()).filter((tx) => !tx.id.startsWith('tx_reconcile'));
    return c.json({
      success: true,
      connected: false,
      count: saved.length,
      transactions: saved,
      message: 'Sesi GoBiz belum terhubung.',
    });
  }
  try {
    const items = await client.fetchTransactions(session);
    if (items.length > 0) {
      await storage.saveTransactions(items);
    }
    const all = (await storage.getTransactions()).filter((tx) => !tx.id.startsWith('tx_reconcile'));
    return c.json({ success: true, connected: true, count: all.length, transactions: all });
  } catch (err: any) {
    const saved = (await storage.getTransactions()).filter((tx) => !tx.id.startsWith('tx_reconcile'));
    return c.json({
      success: false,
      connected: true,
      fallback: true,
      count: saved.length,
      transactions: saved,
      error: 'Gagal mengambil mutasi langsung dari GoBiz: ' + (err.message || 'Jaringan bermasalah'),
    });
  }
});

export default transactions;

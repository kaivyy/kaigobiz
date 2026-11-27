import { Hono } from 'hono';
import { getStorage } from '../../core/storage';
import { getSessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';
import { syncGoBizTransactions } from '../../core/gobiz-sync';

const transactions = new Hono();
const storage = getStorage();
const manager = getSessionManager(storage);
const client = new GoBizClient();

transactions.get('/', async (c) => {
  const session = (await manager.refreshIfNeeded()) || (await manager.getSession());
  if (!session || manager.isHardExpired(session) || manager.needsRelogin) {
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
    await syncGoBizTransactions(storage, manager, client, {
      hoursBack: 72,
      maxPages: 4,
    });
    const all = (await storage.getTransactions()).filter((tx) => !tx.id.startsWith('tx_reconcile'));
    return c.json({ success: true, connected: true, count: all.length, transactions: all });
  } catch (err: any) {
    const saved = (await storage.getTransactions()).filter((tx) => !tx.id.startsWith('tx_reconcile'));
    return c.json({
      success: false,
      connected: !manager.needsRelogin,
      fallback: true,
      count: saved.length,
      transactions: saved,
      error: 'Gagal mengambil mutasi langsung dari GoBiz: ' + (err.message || 'Jaringan bermasalah'),
    });
  }
});

export default transactions;

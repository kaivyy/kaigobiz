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
    return c.json({ error: 'GoBiz Session not connected or expired' }, 401);
  }
  try {
    const items = await client.fetchTransactions(session);
    for (const item of items) {
      await storage.saveTransaction(item);
    }
    return c.json({ success: true, count: items.length, transactions: items });
  } catch (err: any) {
    const saved = await storage.getTransactions();
    return c.json({ success: false, fallback: true, count: saved.length, transactions: saved });
  }
});

export default transactions;

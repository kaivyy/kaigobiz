import { GoBizClient, FetchTransactionsOptions } from './gobiz-client';
import { SessionManager } from './session-manager';
import { StorageAdapter, TransactionData } from './storage/storage.interface';

export interface SyncGoBizOptions extends FetchTransactionsOptions {
  hoursBack?: number;
  force?: boolean;
  minCooldownMs?: number;
}

let inFlightSync: Promise<TransactionData[]> | null = null;
let lastSyncTime = 0;
let lastSyncCooldownMs = 0;

async function readCachedTransactions(store: StorageAdapter): Promise<TransactionData[]> {
  const sinceIso = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
  return store.getRecentTransactions
    ? await store.getRecentTransactions(sinceIso, 500)
    : await store.getTransactions();
}

export async function syncGoBizTransactions(
  store: StorageAdapter,
  mgr: SessionManager,
  gobiz: GoBizClient,
  options?: SyncGoBizOptions
): Promise<TransactionData[]> {
  if (await mgr.isApiRateLimited()) {
    return await readCachedTransactions(store);
  }

  const now = Date.now();
  const defaultCooldown = process.env.NODE_ENV === 'test' ? 0 : 6000;
  const baseCooldown = options?.minCooldownMs ?? defaultCooldown;
  const effectiveCooldown = baseCooldown > 0 ? Math.max(lastSyncCooldownMs, baseCooldown) : 0;

  if (!options?.force && effectiveCooldown > 0 && lastSyncTime > 0 && now - lastSyncTime < effectiveCooldown) {
    return await readCachedTransactions(store);
  }

  if (inFlightSync) {
    return await inFlightSync;
  }

  const hoursBack = options?.hoursBack ?? 72;
  const fetchOpts: FetchTransactionsOptions = {
    maxPages: options?.maxPages,
    stopBeforeTimestamp: options?.stopBeforeTimestamp,
  };

  inFlightSync = (async () => {
    try {
      const jitter = process.env.NODE_ENV === 'test' ? 0 : Math.floor(Math.random() * 1500);
      lastSyncCooldownMs = baseCooldown + jitter;

      const session = await mgr.refreshIfNeeded();
      if (!session) {
        return [];
      }

      let freshItems: TransactionData[] = [];
      try {
        freshItems = await gobiz.fetchTransactions(session, hoursBack, fetchOpts);
      } catch (err: any) {
        if (err?.isRateLimited || err?.status === 429) {
          await mgr.recordApiRateLimit(err);
          throw err;
        }
        const refreshed = await mgr.handleAuthError(err);
        if (refreshed) {
          freshItems = await gobiz.fetchTransactions(refreshed, hoursBack, fetchOpts);
        } else {
          throw err;
        }
      }

      if (freshItems.length > 0) {
        await store.saveTransactions?.(freshItems);
      }
      return freshItems;
    } finally {
      lastSyncTime = Date.now();
      inFlightSync = null;
    }
  })();

  return await inFlightSync;
}

export function resetGoBizSyncState(): void {
  inFlightSync = null;
  lastSyncTime = 0;
  lastSyncCooldownMs = 0;
}

import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns';
import http from 'http';
import https from 'https';
import { StorageAdapter, PaymentOrder, TransactionData } from '../core/storage/storage.interface';
import { SessionManager } from '../core/session-manager';
import { GoBizClient } from '../core/gobiz-client';
import { syncGoBizTransactions } from '../core/gobiz-sync';

const CONFIG_FILE = path.join(process.cwd(), '.kaigobiz-config.json');

let configCache: Record<string, any> | null = null;
let lastConfigCheck = 0;

export function getCachedConfig(): Record<string, any> {
  if (configCache) {
    return configCache;
  }
  if (process.env.NODE_ENV !== 'test' && fs.existsSync(CONFIG_FILE)) {
    try {
      configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) || {};
      lastConfigCheck = Date.now();
      return configCache || {};
    } catch {
      return {};
    }
  }
  return {};
}

export async function getCachedConfigAsync(storage?: StorageAdapter): Promise<Record<string, any>> {
  const now = Date.now();
  if (configCache && now - lastConfigCheck < 2000) {
    return configCache;
  }
  if (storage?.getConfig) {
    const dbCfg = await storage.getConfig();
    configCache = dbCfg;
    lastConfigCheck = now;
    return configCache;
  }
  return getCachedConfig();
}

export async function setStoredConfig(storage: StorageAdapter, patch: Record<string, any>): Promise<Record<string, any>> {
  const current = { ...(await getCachedConfigAsync(storage)) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || String(v).trim() === '') {
      delete current[k];
    } else {
      current[k] = String(v).trim();
    }
  }
  if (storage.setConfig) {
    await storage.setConfig(patch);
  }
  configCache = current;
  lastConfigCheck = Date.now();
  return current;
}

export function invalidateConfigCache(): void {
  configCache = null;
  lastConfigCheck = 0;
}

export function getGlobalWebhookUrl(): string | null {
  const config = getCachedConfig();
  if (config.webhookUrl && typeof config.webhookUrl === 'string' && config.webhookUrl.trim()) {
    return config.webhookUrl.trim();
  }
  if (process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.trim()) {
    return process.env.WEBHOOK_URL.trim();
  }
  return null;
}

export async function getGlobalWebhookUrlAsync(storage?: StorageAdapter): Promise<string | null> {
  const config = await getCachedConfigAsync(storage);
  if (config.webhookUrl && typeof config.webhookUrl === 'string' && config.webhookUrl.trim()) {
    return config.webhookUrl.trim();
  }
  if (process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.trim()) {
    return process.env.WEBHOOK_URL.trim();
  }
  return null;
}

export function getWebhookSecret(): string | null {
  const config = getCachedConfig();
  if (config.webhookSecret && typeof config.webhookSecret === 'string' && config.webhookSecret.trim()) {
    return config.webhookSecret.trim();
  }
  if (process.env.WEBHOOK_SECRET && process.env.WEBHOOK_SECRET.trim()) {
    return process.env.WEBHOOK_SECRET.trim();
  }
  return null;
}

export async function getWebhookSecretAsync(storage?: StorageAdapter): Promise<string | null> {
  const config = await getCachedConfigAsync(storage);
  if (config.webhookSecret && typeof config.webhookSecret === 'string' && config.webhookSecret.trim()) {
    return config.webhookSecret.trim();
  }
  if (process.env.WEBHOOK_SECRET && process.env.WEBHOOK_SECRET.trim()) {
    return process.env.WEBHOOK_SECRET.trim();
  }
  return null;
}

function normalizeBareHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
}

export function isPrivateIP(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;
  const clean = normalizeBareHost(ip);
  if (!clean || clean === 'localhost' || clean === '::1' || clean === '::') {
    return true;
  }

  const ipv4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;
    const [o1, o2, o3] = octets;
    if (o1 === 0 || o1 === 10 || o1 === 127) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true; // CGNAT 100.64.0.0/10
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 192 && o2 === 0 && (o3 === 0 || o3 === 2)) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return true;
    if (o1 >= 224) return true;
    return false;
  }

  // Dotted IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1)
  const v4MappedDotted = clean.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (v4MappedDotted) {
    return isPrivateIP(v4MappedDotted[1]);
  }

  // Hex IPv4-mapped IPv6 (e.g. ::ffff:7f00:1)
  const v4MappedHex = clean.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4MappedHex) {
    const hi = parseInt(v4MappedHex[1], 16);
    const lo = parseInt(v4MappedHex[2], 16);
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    return isPrivateIP(v4);
  }

  // IPv6 link-local (fe80::/10), unique-local (fc00::/7), multicast (ff00::/8)
  if (/^fe[89ab][0-9a-f]{0,2}:/.test(clean) || /^f[cd][0-9a-f]{0,2}:/.test(clean) || /^ff[0-9a-f]{0,2}:/.test(clean)) {
    return true;
  }

  // Expanded IPv6 loopback/unspecified (e.g. 0:0:0:0:0:0:0:1 or 0000::0001)
  if (clean.includes(':')) {
    const groups = clean.split(':').filter((g) => g.length > 0);
    if (groups.length > 0 && groups.every((g, idx) => /^[0-9a-f]+$/.test(g) && parseInt(g, 16) <= (idx === groups.length - 1 ? 1 : 0))) {
      return true;
    }
  }

  return false;
}

export function isSafeWebhookUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }

    if (process.env.ALLOW_LOCAL_WEBHOOKS === 'true') {
      return true;
    }

    const hostname = normalizeBareHost(parsed.hostname);
    if (!hostname) return false;

    const blockedSuffixes = ['.localhost', '.local', '.internal', '.lan', '.nip.io', '.sslip.io', '.localtest.me', '.lvh.me'];
    if (hostname === 'localhost' || blockedSuffixes.some((sfx) => hostname.endsWith(sfx))) {
      return false;
    }

    // Reject integer, hex, or octal IP forms
    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
      return false;
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && hostname.split('.').some((part) => /^0\d+/.test(part))) {
      return false;
    }

    if (isPrivateIP(hostname)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

export interface WebhookPayload {
  event: 'payment.success';
  paymentId: string;
  orderId: string;
  amount: number;
  status: 'PAID';
  paidAt: string;
  transactionId?: string | null;
  timestamp: string;
}

function createPinnedAgents(pinnedIp: string, family: number) {
  const pinnedLookup = (_hostname: string, _opts: any, cb: any) => {
    if (typeof _opts === 'function') {
      cb = _opts;
    }
    if (_opts && _opts.all) {
      return cb(null, [{ address: pinnedIp, family }]);
    }
    return cb(null, pinnedIp, family);
  };
  return {
    httpAgent: new http.Agent({ lookup: pinnedLookup as any }),
    httpsAgent: new https.Agent({ lookup: pinnedLookup as any }),
  };
}

export async function sendWebhookNotification(
  targetUrl: string,
  order: PaymentOrder,
  transaction?: TransactionData | null,
  storage?: StorageAdapter
): Promise<boolean> {
  if (!isSafeWebhookUrl(targetUrl)) {
    console.error(`[KaiGoBiz Webhook] Rejected unsafe webhook URL: ${targetUrl}`);
    return false;
  }

  let agents: { httpAgent?: http.Agent; httpsAgent?: https.Agent } = {};
  if (process.env.NODE_ENV !== 'test' && process.env.ALLOW_LOCAL_WEBHOOKS !== 'true') {
    try {
      const parsed = new URL(targetUrl);
      const bareHost = normalizeBareHost(parsed.hostname);
      const records = await dns.promises.lookup(bareHost, { all: true });
      if (!records || records.length === 0 || records.some((r) => isPrivateIP(r.address))) {
        console.error(`[KaiGoBiz Webhook] Destination resolved to blocked/private IP: ${targetUrl}`);
        return false;
      }
      // Pin resolved IP onto agent to prevent DNS rebinding TOCTOU
      agents = createPinnedAgents(records[0].address, records[0].family);
    } catch {
      return false;
    }
  }

  const timestamp = new Date().toISOString();
  const payload: WebhookPayload = {
    event: 'payment.success',
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
    status: 'PAID',
    paidAt: order.paidAt || timestamp,
    transactionId: transaction?.id || order.transactionId || null,
    timestamp: transaction?.timestamp || timestamp,
  };

  const payloadString = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'KaiGoBiz-Webhook/1.0',
    'X-KaiGoBiz-Timestamp': timestamp,
  };

  const secret = await getWebhookSecretAsync(storage);
  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
    headers['X-KaiGoBiz-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await axios.post(targetUrl, payloadString, {
      timeout: 10000,
      headers,
      maxRedirects: 0,
      ...agents,
    });
    return res.status >= 200 && res.status < 300;
  } catch (err: any) {
    console.error(`[KaiGoBiz Webhook] Failed to deliver webhook to ${targetUrl}:`, err.message || err);
    return false;
  } finally {
    agents.httpAgent?.destroy();
    agents.httpsAgent?.destroy();
  }
}

export function getUsedTransactionIds(orders: PaymentOrder[]): Set<string> {
  const set = new Set<string>();
  for (const o of orders) {
    if (o.status === 'PAID' && o.transactionId) {
      set.add(o.transactionId);
    }
  }
  return set;
}

export function isTransactionMatch(
  tx: TransactionData,
  orderAmount: number,
  orderCreatedAt: number,
  usedTxIds: Set<string>
): boolean {
  if (tx.status !== 'COMPLETED') return false;
  if (usedTxIds.has(tx.id)) return false;

  const isDirectMatch = Math.abs(tx.amount - orderAmount) < 0.01;

  // Fallback for raw sen only when not already normalized by GoBiz client
  const isAlreadyNormalized = Boolean(
    tx.raw?.wallstreet_transaction_id ||
    tx.raw?.channel_type === 'STATIC_QR' ||
    tx.raw?.service_type === 'QRIS'
  );
  const isSenMatch = !isAlreadyNormalized && Math.abs(tx.amount / 100 - orderAmount) < 0.01;

  if (!isDirectMatch && !isSenMatch) return false;
  const txTime = new Date(tx.timestamp).getTime();
  return txTime >= orderCreatedAt - 15000;
}

export function findBestTransactionMatch(
  txs: TransactionData[],
  orderAmount: number,
  orderCreatedAt: number,
  usedTxIds: Set<string>
): TransactionData | undefined {
  const candidates = txs
    .filter((tx) => isTransactionMatch(tx, orderAmount, orderCreatedAt, usedTxIds))
    .sort((a, b) => {
      const aDirect = Math.abs(a.amount - orderAmount) < 0.01 ? 0 : 1;
      const bDirect = Math.abs(b.amount - orderAmount) < 0.01 ? 0 : 1;
      if (aDirect !== bDirect) return aDirect - bDirect;
      return new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
    });
  return candidates[0];
}

let lastPeriodicRefresh = 0;

export async function reconcilePaymentOrders(
  storage: StorageAdapter,
  manager: SessionManager,
  client: GoBizClient
): Promise<number> {
  const now = Date.now();

  if (now - lastPeriodicRefresh >= 300_000) {
    lastPeriodicRefresh = now;
    try {
      await manager.refreshIfNeeded();
    } catch {
      // Ignore background refresh failure
    }
  }

  await storage.expireStalePendingOrders?.(new Date(now).toISOString());

  const pendingOrders = storage.getPendingOrders
    ? await storage.getPendingOrders()
    : ((await storage.getAllPaymentOrders?.()) || [])
        .filter((o) => o.status === 'PENDING')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  let reconciledCount = 0;
  const globalWebhook = await getGlobalWebhookUrlAsync(storage);

  if (pendingOrders.length > 0) {
    const usedTxIds = storage.getUsedTransactionIds
      ? await storage.getUsedTransactionIds()
      : getUsedTransactionIds((await storage.getAllPaymentOrders?.()) || []);

    const sinceIso = new Date(now - 72 * 3600 * 1000).toISOString();
    const localTxs = storage.getRecentTransactions
      ? await storage.getRecentTransactions(sinceIso, 500)
      : await storage.getTransactions();

    let freshTxs: TransactionData[] = [];
    let fetchedFromGoBiz = false;

    for (const order of pendingOrders) {
      const isExpired = new Date(order.expiresAt).getTime() <= now;
      if (isExpired) {
        order.status = 'EXPIRED';
        await storage.savePaymentOrder(order);
        continue;
      }

      const orderCreatedAt = new Date(order.createdAt).getTime();
      let matched = findBestTransactionMatch(localTxs, order.amount, orderCreatedAt, usedTxIds);

      if (!matched && !fetchedFromGoBiz) {
        try {
          const activeTimestamps = pendingOrders
            .filter((o) => new Date(o.expiresAt).getTime() > now)
            .map((o) => new Date(o.createdAt).getTime())
            .filter((ms) => Number.isFinite(ms));
          const oldestCreatedAt = activeTimestamps.length > 0 ? Math.min(...activeTimestamps) : orderCreatedAt;
          const hoursBack = Math.min(72, Math.max(2, Math.ceil((now - oldestCreatedAt) / 3600_000) + 1));

          freshTxs = await syncGoBizTransactions(storage, manager, client, {
            hoursBack,
            maxPages: 2,
            stopBeforeTimestamp: oldestCreatedAt - 60_000,
          });
        } catch {
          // Session or network error
        }
        fetchedFromGoBiz = true;
        matched = findBestTransactionMatch(freshTxs, order.amount, orderCreatedAt, usedTxIds);
      }

      if (matched) {
        const paidAt = new Date().toISOString();
        let claimed = false;
        if (storage.markOrderPaidIfPending) {
          claimed = await storage.markOrderPaidIfPending(order.paymentId, matched.id, paidAt);
        } else {
          order.status = 'PAID';
          order.paidAt = paidAt;
          order.transactionId = matched.id;
          order.callbackRetries = 0;
          order.lastCallbackAttempt = paidAt;
          claimed = await storage.savePaymentOrder(order);
        }

        if (claimed) {
          order.status = 'PAID';
          order.paidAt = paidAt;
          order.transactionId = matched.id;
          usedTxIds.add(matched.id);
          reconciledCount++;

          const callbackUrl = order.callbackUrl || globalWebhook;
          if (callbackUrl && isSafeWebhookUrl(callbackUrl)) {
            sendWebhookNotification(callbackUrl, order, matched, storage)
              .then((success) => {
                const attemptAt = new Date().toISOString();
                if (storage.updateOrderCallbackStatus) {
                  return storage.updateOrderCallbackStatus(order.paymentId, success ? 'SUCCESS' : 'FAILED', attemptAt, false);
                }
                order.callbackStatus = success ? 'SUCCESS' : 'FAILED';
                order.lastCallbackAttempt = attemptAt;
                return storage.savePaymentOrder(order);
              })
              .catch(() => {});
          }
        }
      }
    }
  }

  // Retry failed webhook deliveries even when no pending orders remain
  const failedOrders = storage.getFailedCallbackOrders
    ? await storage.getFailedCallbackOrders(5, 30000)
    : ((await storage.getAllPaymentOrders?.()) || []).filter(
        (o) =>
          o.status === 'PAID' &&
          o.callbackStatus === 'FAILED' &&
          (o.callbackRetries || 0) < 5 &&
          (!o.lastCallbackAttempt || now - new Date(o.lastCallbackAttempt).getTime() >= 30_000)
      );

  for (const failedOrder of failedOrders) {
    const target = failedOrder.callbackUrl || globalWebhook;
    if (target && isSafeWebhookUrl(target)) {
      const attemptAt = new Date().toISOString();
      if (storage.updateOrderCallbackStatus) {
        await storage.updateOrderCallbackStatus(failedOrder.paymentId, 'FAILED', attemptAt, true);
      } else {
        failedOrder.callbackRetries = (failedOrder.callbackRetries || 0) + 1;
        failedOrder.lastCallbackAttempt = attemptAt;
        await storage.savePaymentOrder(failedOrder);
      }

      sendWebhookNotification(target, failedOrder, null, storage)
        .then((success) => {
          if (success) {
            const okAt = new Date().toISOString();
            if (storage.updateOrderCallbackStatus) {
              return storage.updateOrderCallbackStatus(failedOrder.paymentId, 'SUCCESS', okAt, false);
            }
            failedOrder.callbackStatus = 'SUCCESS';
            failedOrder.lastCallbackAttempt = okAt;
            return storage.savePaymentOrder(failedOrder);
          }
        })
        .catch(() => {});
    }
  }

  return reconciledCount;
}

let reconcilerTimer: any = null;
let isReconcilerRunning = false;

export function startBackgroundReconciler(
  storage: StorageAdapter,
  manager: SessionManager,
  client: GoBizClient,
  baseIntervalMs = 8000
) {
  if (reconcilerTimer) return;

  const scheduleNext = () => {
    const jitter = Math.floor((Math.random() - 0.5) * 3000);
    const delay = Math.max(5000, baseIntervalMs + jitter);
    reconcilerTimer = setTimeout(runTick, delay);
    if (reconcilerTimer.unref) {
      reconcilerTimer.unref();
    }
  };

  const runTick = async () => {
    if (isReconcilerRunning) {
      scheduleNext();
      return;
    }
    isReconcilerRunning = true;
    try {
      await reconcilePaymentOrders(storage, manager, client);
    } catch {
      // Ignore background reconciler tick error
    } finally {
      isReconcilerRunning = false;
      scheduleNext();
    }
  };

  scheduleNext();
}

export function stopBackgroundReconciler() {
  if (reconcilerTimer) {
    clearTimeout(reconcilerTimer);
    reconcilerTimer = null;
  }
}

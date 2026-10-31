import axios from 'axios';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dns from 'dns';
import { StorageAdapter, PaymentOrder, TransactionData } from '../core/storage/storage.interface';
import { SessionManager } from '../core/session-manager';
import { GoBizClient } from '../core/gobiz-client';

const CONFIG_FILE = path.join(process.cwd(), '.kaigobiz-config.json');

let cachedConfig: Record<string, any> | null = null;
let lastConfigCheck = 0;

export function getCachedConfig(): Record<string, any> {
  const now = Date.now();
  if (cachedConfig && now - lastConfigCheck < 2000) {
    return cachedConfig;
  }
  lastConfigCheck = now;
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cachedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      return cachedConfig || {};
    } catch {
      return {};
    }
  }
  return {};
}

export function invalidateConfigCache(): void {
  cachedConfig = null;
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

export function isPrivateIP(ip: string): boolean {
  if (!ip || typeof ip !== 'string') return true;
  const clean = ip.trim().toLowerCase();
  if (clean === 'localhost' || clean === '127.0.0.1' || clean === '::1' || clean === '0.0.0.0') {
    return true;
  }
  const ipv4Match = clean.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const octets = ipv4Match.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) return true;
    const [o1, o2] = octets;
    if (o1 === 0 || o1 === 127 || o1 === 10) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 >= 224) return true;
    return false;
  }
  if (
    clean.startsWith('fe80:') ||
    clean.startsWith('fc00:') ||
    clean.startsWith('fd00:') ||
    clean.startsWith('::ffff:127.') ||
    clean.startsWith('::ffff:10.') ||
    clean.startsWith('::ffff:192.168.') ||
    (clean.includes(':') && (clean.endsWith(':1') || clean === '::'))
  ) {
    return true;
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
    const hostname = parsed.hostname.toLowerCase();

    if (process.env.NODE_ENV === 'test' || process.env.ALLOW_LOCAL_WEBHOOKS === 'true') {
      return true;
    }

    if (
      hostname === 'localhost' ||
      hostname.endsWith('.local') ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.lan') ||
      hostname.includes('127.0.0.1')
    ) {
      return false;
    }

    if (/^\d+$/.test(hostname) || /^0x[0-9a-f]+$/i.test(hostname)) {
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

export async function sendWebhookNotification(
  targetUrl: string,
  order: PaymentOrder,
  transaction?: TransactionData | null
): Promise<boolean> {
  if (!isSafeWebhookUrl(targetUrl)) {
    console.error(`[KaiGoBiz Webhook] Rejected unsafe webhook URL: ${targetUrl}`);
    return false;
  }

  if (process.env.NODE_ENV !== 'test' && process.env.ALLOW_LOCAL_WEBHOOKS !== 'true') {
    try {
      const parsed = new URL(targetUrl);
      const res = await dns.promises.lookup(parsed.hostname);
      if (isPrivateIP(res.address)) {
        console.error(`[KaiGoBiz Webhook] Webhook destination resolved to private IP ${res.address}: ${targetUrl}`);
        return false;
      }
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

  const secret = getWebhookSecret();
  if (secret) {
    const signature = crypto.createHmac('sha256', secret).update(payloadString).digest('hex');
    headers['X-KaiGoBiz-Signature'] = `sha256=${signature}`;
  }

  try {
    const res = await axios.post(targetUrl, payload, {
      timeout: 10000,
      headers,
    });
    return res.status >= 200 && res.status < 300;
  } catch (err: any) {
    console.error(`[KaiGoBiz Webhook] Failed to deliver webhook to ${targetUrl}:`, err.message || err);
    return false;
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

let lastPeriodicRefresh = 0;

export async function reconcilePaymentOrders(
  storage: StorageAdapter,
  manager: SessionManager,
  client: GoBizClient
): Promise<number> {
  const now = Date.now();

  if (now - lastPeriodicRefresh >= 60_000) {
    lastPeriodicRefresh = now;
    try {
      await manager.refreshIfNeeded();
    } catch {
      // Ignore background refresh failure
    }
  }

  const pendingOrders = storage.getPendingOrders
    ? await storage.getPendingOrders()
    : ((await storage.getAllPaymentOrders?.()) || [])
        .filter((o) => o.status === 'PENDING')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

  if (pendingOrders.length === 0) {
    return 0;
  }

  const usedTxIds = storage.getUsedTransactionIds
    ? await storage.getUsedTransactionIds()
    : getUsedTransactionIds((await storage.getAllPaymentOrders?.()) || []);

  let freshTxs: TransactionData[] = [];
  let fetchedFromGoBiz = false;
  let reconciledCount = 0;

  for (const order of pendingOrders) {
    const isExpired = new Date(order.expiresAt).getTime() < now;
    if (isExpired) {
      order.status = 'EXPIRED';
      await storage.savePaymentOrder(order);
      continue;
    }

    const orderCreatedAt = new Date(order.createdAt).getTime();

    let localTxs = await storage.getTransactions();
    const localCandidates = localTxs
      .filter((tx) => isTransactionMatch(tx, order.amount, orderCreatedAt, usedTxIds))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    let matched = localCandidates[0];

    if (!matched && !fetchedFromGoBiz) {
      try {
        const session = await manager.refreshIfNeeded();
        if (session) {
          freshTxs = await client.fetchTransactions(session);
          if (freshTxs.length > 0) {
            await storage.saveTransactions?.(freshTxs);
          }
        }
      } catch {
        // Session or network error
      }
      fetchedFromGoBiz = true;

      const freshCandidates = freshTxs
        .filter((tx) => isTransactionMatch(tx, order.amount, orderCreatedAt, usedTxIds))
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      matched = freshCandidates[0];
    }

    if (matched) {
      order.status = 'PAID';
      order.paidAt = new Date().toISOString();
      order.transactionId = matched.id;
      order.callbackRetries = 0;
      order.lastCallbackAttempt = new Date().toISOString();
      usedTxIds.add(matched.id);
      reconciledCount++;

      await storage.savePaymentOrder(order);

      const callbackUrl = order.callbackUrl || getGlobalWebhookUrl();
      if (callbackUrl && isSafeWebhookUrl(callbackUrl)) {
        sendWebhookNotification(callbackUrl, order, matched)
          .then((success) => {
            order.callbackStatus = success ? 'SUCCESS' : 'FAILED';
            storage.savePaymentOrder(order).catch(() => {});
          })
          .catch(() => {});
      }
    }
  }

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
    const target = failedOrder.callbackUrl || getGlobalWebhookUrl();
    if (target && isSafeWebhookUrl(target)) {
      failedOrder.callbackRetries = (failedOrder.callbackRetries || 0) + 1;
      failedOrder.lastCallbackAttempt = new Date().toISOString();
      await storage.savePaymentOrder(failedOrder);

      sendWebhookNotification(target, failedOrder, null)
        .then((success) => {
          if (success) {
            failedOrder.callbackStatus = 'SUCCESS';
            storage.savePaymentOrder(failedOrder).catch(() => {});
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
    // Human-like anti-bot jitter: +/- 25% variation in polling timing
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

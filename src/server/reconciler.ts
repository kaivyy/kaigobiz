import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { StorageAdapter, PaymentOrder, TransactionData } from '../core/storage/storage.interface';
import { SessionManager } from '../core/session-manager';
import { GoBizClient } from '../core/gobiz-client';

const CONFIG_FILE = path.join(process.cwd(), '.kaigobiz-config.json');

export function getGlobalWebhookUrl(): string | null {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (config.webhookUrl && typeof config.webhookUrl === 'string' && config.webhookUrl.trim()) {
        return config.webhookUrl.trim();
      }
    } catch {}
  }
  if (process.env.WEBHOOK_URL && process.env.WEBHOOK_URL.trim()) {
    return process.env.WEBHOOK_URL.trim();
  }
  return null;
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
  const payload: WebhookPayload = {
    event: 'payment.success',
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
    status: 'PAID',
    paidAt: order.paidAt || new Date().toISOString(),
    transactionId: transaction?.id || null,
    timestamp: transaction?.timestamp || new Date().toISOString(),
  };

  try {
    const res = await axios.post(targetUrl, payload, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'KaiGoBiz-Webhook/1.0',
      },
    });
    return res.status >= 200 && res.status < 300;
  } catch (err: any) {
    console.error(`[KaiGoBiz Webhook] Failed to deliver webhook to ${targetUrl}:`, err.message || err);
    return false;
  }
}

export async function reconcilePaymentOrders(
  storage: StorageAdapter,
  manager: SessionManager,
  client: GoBizClient
): Promise<number> {
  if (!storage.getAllPaymentOrders) return 0;

  const orders = await storage.getAllPaymentOrders();
  const pendingOrders = orders.filter((o) => o.status === 'PENDING');
  if (pendingOrders.length === 0) return 0;

  const now = Date.now();
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

    // Check existing stored transactions first
    let localTxs = await storage.getTransactions();
    let matched = localTxs.find(
      (tx) =>
        tx.status === 'COMPLETED' &&
        (Math.abs(tx.amount - order.amount) < 0.01 || Math.abs(tx.amount / 100 - order.amount) < 0.01) &&
        new Date(tx.timestamp).getTime() >= orderCreatedAt - 15000
    );

    // If not found locally, fetch fresh transactions from GoBiz session once
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
        // Session or network error, ignore
      }
      fetchedFromGoBiz = true;

      matched = freshTxs.find(
        (tx) =>
          tx.status === 'COMPLETED' &&
          (Math.abs(tx.amount - order.amount) < 0.01 || Math.abs(tx.amount / 100 - order.amount) < 0.01) &&
          new Date(tx.timestamp).getTime() >= orderCreatedAt - 15000
      );
    }

    if (matched) {
      order.status = 'PAID';
      order.paidAt = new Date().toISOString();
      reconciledCount++;

      const callbackUrl = order.callbackUrl || getGlobalWebhookUrl();
      if (callbackUrl) {
        sendWebhookNotification(callbackUrl, order, matched)
          .then((success) => {
            order.callbackStatus = success ? 'SUCCESS' : 'FAILED';
            storage.savePaymentOrder(order).catch(() => {});
          })
          .catch(() => {});
      }

      await storage.savePaymentOrder(order);
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
  intervalMs = 8000
) {
  if (reconcilerTimer) return;

  reconcilerTimer = setInterval(async () => {
    if (isReconcilerRunning) return;
    isReconcilerRunning = true;
    try {
      await reconcilePaymentOrders(storage, manager, client);
    } catch {
      // Ignore background reconciler tick error
    } finally {
      isReconcilerRunning = false;
    }
  }, intervalMs);

  // Allow Node.js process to exit cleanly if needed
  if (reconcilerTimer.unref) {
    reconcilerTimer.unref();
  }
}

export function stopBackgroundReconciler() {
  if (reconcilerTimer) {
    clearInterval(reconcilerTimer);
    reconcilerTimer = null;
  }
}

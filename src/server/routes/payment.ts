import { Hono } from 'hono';
import { getStorage } from '../../core/storage';
import { getSessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';
import { syncGoBizTransactions } from '../../core/gobiz-sync';
import { generateDynamicQRIS, generateQRCodeDataURL, inspectQRIS } from '../../core/qris-generator';
import { PaymentOrder } from '../../core/storage/storage.interface';
import {
  getGlobalWebhookUrlAsync,
  sendWebhookNotification,
  getUsedTransactionIds,
  findBestTransactionMatch,
  isSafeWebhookUrl,
  getCachedConfigAsync,
  setStoredConfig,
} from '../reconciler';
import { execFile } from 'child_process';
import { promisify } from 'util';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';

const execFileAsync = promisify(execFile);

const payment = new Hono();
const storage = getStorage();
const manager = getSessionManager(storage);
const client = new GoBizClient();

const FALLBACK_DUMMY_TEMPLATE =
  '00020101021126390013ID.GO-JEK.WWW01189360091430000000005204581253033605802ID5914KAI GOBIZ SHOP6007JAKARTA63045B63';

async function getActiveTemplate(): Promise<string> {
  const config = await getCachedConfigAsync(storage);
  if (config.staticQrisTemplate && config.staticQrisTemplate.trim()) {
    return config.staticQrisTemplate.trim();
  }
  if (process.env.STATIC_QRIS_TEMPLATE && process.env.STATIC_QRIS_TEMPLATE.trim()) {
    return process.env.STATIC_QRIS_TEMPLATE.trim();
  }
  return FALLBACK_DUMMY_TEMPLATE;
}

payment.get('/template', async (c) => {
  const template = await getActiveTemplate();
  const isDefault = template === FALLBACK_DUMMY_TEMPLATE;
  const details = inspectQRIS(template);

  return c.json({
    success: true,
    template,
    isDefault,
    details,
  });
});

payment.post('/template', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { template } = body || {};
  if (!template || typeof template !== 'string' || !template.trim()) {
    return c.json({ error: 'Template QRIS tidak boleh kosong' }, 400);
  }

  const cleanTemplate = template.trim();
  const details = inspectQRIS(cleanTemplate);
  if (!details.isValid) {
    return c.json({ error: 'Format QRIS tidak valid. Pastikan string berstandar EMVCo QRIS (diawali 000201...)' }, 400);
  }

  await setStoredConfig(storage, { staticQrisTemplate: cleanTemplate });

  return c.json({
    success: true,
    template: cleanTemplate,
    isDefault: cleanTemplate === FALLBACK_DUMMY_TEMPLATE,
    details,
    message: 'Template QRIS merchant berhasil disimpan dan diaktifkan.',
  });
});

let activeQrDecodes = 0;
const MAX_CONCURRENT_QR_DECODES = 3;

payment.post('/decode-qr', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch (err: any) {
    console.error('[decode-qr] JSON parse error:', err.message);
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { imageBase64 } = body || {};
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    return c.json({ error: 'Data gambar QR code tidak ditemukan' }, 400);
  }

  if (imageBase64.length > 10 * 1024 * 1024) {
    return c.json({ error: 'Ukuran file gambar terlalu besar (maksimal 7 MB)' }, 413);
  }

  if (activeQrDecodes >= MAX_CONCURRENT_QR_DECODES) {
    return c.json({ error: 'Server sedang memproses gambar lain, silakan coba beberapa detik lagi.' }, 429);
  }

  activeQrDecodes++;
  let tempFilePath: string | null = null;
  try {
    const pythonScript = path.join(process.cwd(), 'decode_qr.py');
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');

    tempFilePath = path.join(os.tmpdir(), `kaigobiz_qr_${crypto.randomUUID()}.bin`);
    await fs.promises.writeFile(tempFilePath, buffer, { mode: 0o600 });

    const { stdout } = await execFileAsync('python3', [pythonScript, tempFilePath], {
      encoding: 'utf-8',
      timeout: 20000,
    });
    const qrString = stdout.trim();

    if (!qrString || qrString === 'NO_QR_FOUND') {
      return c.json(
        { error: 'Tidak dapat mendeteksi kode QR dari gambar tersebut. Pastikan foto atau tangkapan layar jelas dan memuat kode QR.' },
        400
      );
    }

    const details = inspectQRIS(qrString);
    if (!details.isValid && !qrString.startsWith('000201')) {
      return c.json({ error: 'Kode QR terdeteksi, namun bukan format QRIS standar (harus diawali 000201...).' }, 400);
    }

    return c.json({
      success: true,
      qrString,
      qrisString: qrString,
      details,
    });
  } catch (err: any) {
    console.error('[decode-qr] Processing exception:', err.message);
    return c.json({ error: 'Gagal memproses gambar QR code' }, 500);
  } finally {
    activeQrDecodes = Math.max(0, activeQrDecodes - 1);
    if (tempFilePath) {
      await fs.promises.unlink(tempFilePath).catch(() => {});
    }
  }
});

payment.get('/webhook-config', async (c) => {
  const webhookUrl = await getGlobalWebhookUrlAsync(storage);
  return c.json({
    success: true,
    webhookUrl,
  });
});

payment.post('/webhook-config', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { webhookUrl } = body || {};
  const cleanWebhook = webhookUrl && typeof webhookUrl === 'string' && webhookUrl.trim() ? webhookUrl.trim() : null;

  if (cleanWebhook && !isSafeWebhookUrl(cleanWebhook)) {
    return c.json({ error: 'URL Webhook tidak valid atau mengarah ke alamat privat/lokal yang diblokir (SSRF protection)' }, 400);
  }

  const updated = await setStoredConfig(storage, { webhookUrl: cleanWebhook });

  return c.json({
    success: true,
    webhookUrl: updated.webhookUrl ?? null,
    message: 'Konfigurasi Webhook URL berhasil diperbarui.',
  });
});

function allocateUniqueCode(
  integerAmount: number,
  minCode: number,
  maxCode: number,
  isSubtract: boolean,
  pendingAmounts: Set<number>
): { finalAmount: number; uniqueCode: number } | null {
  const rangeSize = maxCode - minCode + 1;

  for (let attempt = 0; attempt < Math.min(30, rangeSize * 2); attempt++) {
    const candidateCode = Math.floor(minCode + Math.random() * rangeSize);
    const candidateAmount = isSubtract ? integerAmount - candidateCode : integerAmount + candidateCode;
    if (candidateAmount >= 1 && !pendingAmounts.has(candidateAmount)) {
      return { finalAmount: candidateAmount, uniqueCode: candidateCode };
    }
  }

  for (let code = minCode; code <= maxCode; code++) {
    const candidateAmount = isSubtract ? integerAmount - code : integerAmount + code;
    if (candidateAmount >= 1 && !pendingAmounts.has(candidateAmount)) {
      return { finalAmount: candidateAmount, uniqueCode: code };
    }
  }

  return null;
}

function formatReusedOrderResponse(existing: PaymentOrder, origin: string) {
  return {
    success: true,
    paymentId: existing.paymentId,
    orderId: existing.orderId,
    amount: existing.amount,
    rawAmount: existing.rawAmount,
    uniqueCode: existing.uniqueCode,
    qrisString: existing.qrisString,
    qrisQrUrl: existing.qrisQrUrl,
    checkoutUrl: `${origin}/pay/${existing.paymentId}`,
    expiresAt: existing.expiresAt,
    callbackUrl: existing.callbackUrl,
    returnUrl: existing.returnUrl,
    reused: true,
  };
}

payment.post('/create', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const {
    orderId,
    amount,
    expiryMinutes = 5,
    callbackUrl,
    returnUrl,
    useUniqueCode,
    uniqueCodeMin,
    uniqueCodeMax,
    uniqueCodeType,
  } = body || {};

  if (orderId === undefined || orderId === null) {
    return c.json({ error: 'orderId wajib diisi' }, 400);
  }
  const cleanOrderId = String(orderId).trim();
  if (!cleanOrderId || cleanOrderId.length > 100) {
    return c.json({ error: 'orderId harus berupa teks dengan panjang antara 1 sampai 100 karakter' }, 400);
  }

  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount) || numericAmount < 1 || numericAmount > 100_000_000) {
    return c.json({ error: 'Nominal pembayaran tidak valid. Harus berupa angka positif antara Rp 1 sampai Rp 100.000.000' }, 400);
  }
  const integerAmount = Math.round(numericAmount);

  const expMin = Number(expiryMinutes ?? 5);
  if (!Number.isFinite(expMin) || expMin < 1 || expMin > 1440) {
    return c.json({ error: 'expiryMinutes harus berupa angka antara 1 sampai 1440 menit (maksimal 24 jam)' }, 400);
  }

  let cleanCallbackUrl: string | undefined;
  if (callbackUrl && typeof callbackUrl === 'string' && callbackUrl.trim()) {
    const trimmedUrl = callbackUrl.trim();
    if (!isSafeWebhookUrl(trimmedUrl)) {
      return c.json({ error: 'callbackUrl tidak valid atau dilarang demi keamanan sistem (SSRF protection)' }, 400);
    }
    cleanCallbackUrl = trimmedUrl;
  }

  let cleanReturnUrl: string | undefined;
  if (returnUrl && typeof returnUrl === 'string' && returnUrl.trim()) {
    const trimmedReturn = returnUrl.trim();
    if (!/^https?:\/\//i.test(trimmedReturn) || !isSafeWebhookUrl(trimmedReturn)) {
      return c.json({ error: 'returnUrl tidak valid' }, 400);
    }
    cleanReturnUrl = trimmedReturn;
  }

  // Sweep stale pending orders first so expired rows do not block unique indexes
  await storage.expireStalePendingOrders?.();

  const reqUrl = new URL(c.req.url);
  const existingPending = storage.getActivePendingOrder
    ? await storage.getActivePendingOrder(cleanOrderId)
    : ((await storage.getAllPaymentOrders?.()) || []).find(
        (o) =>
          o.orderId === cleanOrderId &&
          o.status === 'PENDING' &&
          new Date(o.expiresAt).getTime() > Date.now()
      );

  if (existingPending) {
    const existingBase = existingPending.rawAmount ?? existingPending.amount;
    if (existingBase === integerAmount || existingPending.amount === integerAmount) {
      return c.json(formatReusedOrderResponse(existingPending, reqUrl.origin));
    }
    return c.json({ error: 'Order ID sudah memiliki pembayaran pending dengan nominal berbeda' }, 409);
  }

  let finalAmount = integerAmount;
  let uniqueCode: number | undefined;
  const minCode = Math.max(1, Number(uniqueCodeMin) || 1);
  const maxCode = Math.max(minCode, Math.min(9999, Number(uniqueCodeMax) || 250));
  const isSubtract = uniqueCodeType === 'SUBTRACT';

  const getPendingAmountSet = async (): Promise<Set<number>> =>
    storage.getActivePendingAmounts
      ? await storage.getActivePendingAmounts()
      : new Set(
          ((await storage.getAllPaymentOrders?.()) || [])
            .filter((o) => o.status === 'PENDING' && new Date(o.expiresAt).getTime() > Date.now())
            .map((o) => o.amount)
        );

  if (useUniqueCode) {
    const pendingAmounts = await getPendingAmountSet();
    const allocated = allocateUniqueCode(integerAmount, minCode, maxCode, isSubtract, pendingAmounts);
    if (!allocated) {
      return c.json(
        { error: 'Semua kode unik dalam rentang tersebut sedang aktif. Harap coba beberapa saat lagi.' },
        409
      );
    }
    finalAmount = allocated.finalAmount;
    uniqueCode = allocated.uniqueCode;
  }

  const activeTemplate = await getActiveTemplate();
  const paymentId = 'pay_' + crypto.randomBytes(12).toString('hex');
  const qrisString = generateDynamicQRIS(activeTemplate, finalAmount);
  const qrisQrUrl = await generateQRCodeDataURL(qrisString);
  const expiresAt = new Date(Date.now() + expMin * 60 * 1000).toISOString();

  const order: PaymentOrder = {
    paymentId,
    orderId: cleanOrderId,
    amount: finalAmount,
    rawAmount: integerAmount,
    uniqueCode,
    qrisString,
    qrisQrUrl,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    expiresAt,
    callbackUrl: cleanCallbackUrl,
    returnUrl: cleanReturnUrl,
  };

  let orderSaved = false;
  for (let retry = 0; retry < 5; retry++) {
    try {
      await storage.savePaymentOrder(order);
      orderSaved = true;
      break;
    } catch (err: any) {
      const msg = err?.message || '';
      if (msg.includes('UNIQUE constraint failed')) {
        // Concurrent request with identical orderId wins the index race
        if (msg.includes('order_id')) {
          const concurrent = storage.getActivePendingOrder
            ? await storage.getActivePendingOrder(cleanOrderId)
            : null;
          if (concurrent) {
            const concurrentBase = concurrent.rawAmount ?? concurrent.amount;
            if (concurrentBase === integerAmount || concurrent.amount === integerAmount) {
              return c.json(formatReusedOrderResponse(concurrent, reqUrl.origin));
            }
          }
          return c.json({ error: 'Order ID sudah memiliki pembayaran pending aktif' }, 409);
        }

        if (useUniqueCode) {
          await storage.expireStalePendingOrders?.();
          const pendingAmounts = await getPendingAmountSet();
          const nextAlloc = allocateUniqueCode(integerAmount, minCode, maxCode, isSubtract, pendingAmounts);
          if (!nextAlloc) {
            return c.json(
              { error: 'Semua kode unik dalam rentang tersebut sedang aktif. Harap coba beberapa saat lagi.' },
              409
            );
          }
          order.amount = nextAlloc.finalAmount;
          order.uniqueCode = nextAlloc.uniqueCode;
          order.qrisString = generateDynamicQRIS(activeTemplate, nextAlloc.finalAmount);
          order.qrisQrUrl = await generateQRCodeDataURL(order.qrisString);
          continue;
        }
      }
      throw err;
    }
  }

  if (!orderSaved) {
    return c.json({ error: 'Gagal mengalokasikan kode unik karena kepadatan transaksi, silakan coba lagi.' }, 409);
  }

  const checkoutUrl = `${reqUrl.origin}/pay/${order.paymentId}`;

  return c.json({
    success: true,
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
    rawAmount: order.rawAmount,
    uniqueCode: order.uniqueCode,
    qrisString: order.qrisString,
    qrisQrUrl: order.qrisQrUrl,
    checkoutUrl,
    expiresAt: order.expiresAt,
    callbackUrl: order.callbackUrl,
    returnUrl: order.returnUrl,
  });
});

payment.get('/status/:paymentId', async (c) => {
  const paymentId = c.req.param('paymentId');
  const order = await storage.getPaymentOrder(paymentId);

  if (!order) {
    return c.json({ error: 'Payment order not found' }, 404);
  }

  if (order.status === 'PENDING') {
    const isExpired = new Date(order.expiresAt).getTime() <= Date.now();
    if (isExpired) {
      order.status = 'EXPIRED';
      await storage.savePaymentOrder(order);
    } else {
      const orderCreatedAt = new Date(order.createdAt).getTime();
      const usedTxIds = storage.getUsedTransactionIds
        ? await storage.getUsedTransactionIds()
        : getUsedTransactionIds((await storage.getAllPaymentOrders?.()) || []);

      const sinceIso = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      const txs = storage.getRecentTransactions
        ? await storage.getRecentTransactions(sinceIso, 500)
        : await storage.getTransactions();

      let matched = findBestTransactionMatch(txs, order.amount, orderCreatedAt, usedTxIds);

      if (!matched) {
        try {
          const hoursBack = Math.min(72, Math.max(2, Math.ceil((Date.now() - orderCreatedAt) / 3600_000) + 1));
          const freshItems = await syncGoBizTransactions(storage, manager, client, {
            hoursBack,
            maxPages: 2,
            stopBeforeTimestamp: orderCreatedAt - 60_000,
          });
          matched = findBestTransactionMatch(freshItems, order.amount, orderCreatedAt, usedTxIds);
        } catch {
          // Ignore sync errors and report current state
        }
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
          claimed = await storage.savePaymentOrder(order);
        }

        if (claimed) {
          order.status = 'PAID';
          order.paidAt = paidAt;
          order.transactionId = matched.id;

          const targetCallback = order.callbackUrl || (await getGlobalWebhookUrlAsync(storage));
          if (targetCallback && order.callbackStatus !== 'SUCCESS') {
            sendWebhookNotification(targetCallback, order, matched, storage)
              .then((ok) => {
                const attemptAt = new Date().toISOString();
                if (storage.updateOrderCallbackStatus) {
                  return storage.updateOrderCallbackStatus(order.paymentId, ok ? 'SUCCESS' : 'FAILED', attemptAt, false);
                }
                order.callbackStatus = ok ? 'SUCCESS' : 'FAILED';
                order.lastCallbackAttempt = attemptAt;
                return storage.savePaymentOrder(order);
              })
              .catch(() => {});
          }
        } else {
          const reloaded = await storage.getPaymentOrder(paymentId);
          if (reloaded) {
            Object.assign(order, reloaded);
          }
        }
      }
    }
  }

  return c.json({
    success: true,
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
    rawAmount: order.rawAmount,
    uniqueCode: order.uniqueCode,
    status: order.status,
    expiresAt: order.expiresAt,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    transactionId: order.transactionId,
    qrisString: order.qrisString,
    qrisQrUrl: order.qrisQrUrl,
  });
});

export default payment;

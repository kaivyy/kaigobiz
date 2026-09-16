import { Hono } from 'hono';
import { FileStorageAdapter } from '../../core/storage/file-storage';
import { SessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';
import { generateDynamicQRIS, generateQRCodeDataURL, inspectQRIS } from '../../core/qris-generator';
import { PaymentOrder } from '../../core/storage/storage.interface';
import {
  getGlobalWebhookUrl,
  sendWebhookNotification,
  getUsedTransactionIds,
  isTransactionMatch,
  isSafeWebhookUrl,
} from '../reconciler';
import { execFileSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

const payment = new Hono();
const storage = new FileStorageAdapter();
const manager = new SessionManager(storage);
const client = new GoBizClient();

const CONFIG_FILE = path.join(process.cwd(), '.kaigobiz-config.json');

const FALLBACK_DUMMY_TEMPLATE =
  '00020101021126390013ID.GO-JEK.WWW01189360091430000000005204581253033605802ID5914KAI GOBIZ SHOP6007JAKARTA63045B63';

function getActiveTemplate(): string {
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (config.staticQrisTemplate && config.staticQrisTemplate.trim()) {
        return config.staticQrisTemplate.trim();
      }
    } catch {}
  }
  if (process.env.STATIC_QRIS_TEMPLATE && process.env.STATIC_QRIS_TEMPLATE.trim()) {
    return process.env.STATIC_QRIS_TEMPLATE.trim();
  }
  return FALLBACK_DUMMY_TEMPLATE;
}

// Get active QRIS template info
payment.get('/template', (c) => {
  const template = getActiveTemplate();
  const isDefault = template === FALLBACK_DUMMY_TEMPLATE;
  const details = inspectQRIS(template);

  return c.json({
    success: true,
    template,
    isDefault,
    details,
  });
});

// Update active QRIS template
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

  // Persist to .kaigobiz-config.json
  let config: Record<string, any> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
  }
  config.staticQrisTemplate = cleanTemplate;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  return c.json({
    success: true,
    template: cleanTemplate,
    isDefault: cleanTemplate === FALLBACK_DUMMY_TEMPLATE,
    details,
    message: 'Template QRIS merchant berhasil disimpan dan diaktifkan.',
  });
});

// Decode QR Code image to extract QRIS string
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

  // Prevent memory exhaustion (max 10MB base64 string ~ 7.5MB image)
  if (imageBase64.length > 10 * 1024 * 1024) {
    return c.json({ error: 'Ukuran file gambar terlalu besar (maksimal 7 MB)' }, 413);
  }

  let tempFilePath: string | null = null;
  try {
    const pythonScript = path.join(process.cwd(), 'decode_qr.py');
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');

    const randomSuffix = Math.random().toString(36).substring(2, 10);
    tempFilePath = path.join(os.tmpdir(), `kaigobiz_qr_${Date.now()}_${randomSuffix}.png`);
    fs.writeFileSync(tempFilePath, buffer);

    const qrString = execFileSync('python3', [pythonScript, tempFilePath], {
      encoding: 'utf-8',
      timeout: 20000,
    }).trim();

    if (!qrString || qrString === 'NO_QR_FOUND') {
      return c.json({ error: 'Tidak dapat mendeteksi kode QR dari gambar tersebut. Pastikan foto atau tangkapan layar jelas dan memuat kode QR.' }, 400);
    }

    const details = inspectQRIS(qrString);
    if (!details.isValid && !qrString.startsWith('000201')) {
      return c.json({ error: 'Kode QR terdeteksi, namun bukan format QRIS standar (harus diawali 000201...).' }, 400);
    }

    return c.json({
      success: true,
      qrString,
      details,
    });
  } catch (err: any) {
    console.error('[decode-qr] Processing exception:', err.message);
    return c.json({ error: 'Gagal memproses gambar QR code: ' + (err.message || 'Error') }, 500);
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      try {
        fs.unlinkSync(tempFilePath);
      } catch {}
    }
  }
});

// Get Webhook Config
payment.get('/webhook-config', (c) => {
  const webhookUrl = getGlobalWebhookUrl();
  return c.json({
    success: true,
    webhookUrl,
  });
});

// Update Webhook Config
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

  let config: Record<string, any> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
  }

  config.webhookUrl = cleanWebhook;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  return c.json({
    success: true,
    webhookUrl: config.webhookUrl,
    message: 'Konfigurasi Webhook URL berhasil diperbarui.',
  });
});

let inFlightFetch: Promise<any[]> | null = null;
let lastGoBizFetchTime = 0;
const GOBIZ_FETCH_COOLDOWN_MS = 2500;

async function fetchTransactionsCoalesced(
  manager: SessionManager,
  client: GoBizClient,
  storage: FileStorageAdapter
): Promise<any[]> {
  const now = Date.now();
  if (now - lastGoBizFetchTime < GOBIZ_FETCH_COOLDOWN_MS) {
    return await storage.getTransactions();
  }
  if (inFlightFetch) {
    return await inFlightFetch;
  }

  inFlightFetch = (async () => {
    try {
      const session = await manager.refreshIfNeeded();
      if (session) {
        const freshItems = await client.fetchTransactions(session);
        if (freshItems.length > 0) {
          await storage.saveTransactions(freshItems);
        }
        lastGoBizFetchTime = Date.now();
        return freshItems;
      }
      return [];
    } catch {
      return [];
    } finally {
      inFlightFetch = null;
    }
  })();

  return await inFlightFetch;
}

// Create dynamic payment
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

  // Idempotency: Return existing active pending order if orderId and amount match
  const allOrders = (await storage.getAllPaymentOrders?.()) || [];
  const existingPending = allOrders.find(
    (o) =>
      o.orderId === cleanOrderId &&
      o.status === 'PENDING' &&
      new Date(o.expiresAt).getTime() > Date.now()
  );

  const reqUrl = new URL(c.req.url);

  if (existingPending && existingPending.amount === integerAmount) {
    return c.json({
      success: true,
      paymentId: existingPending.paymentId,
      orderId: existingPending.orderId,
      amount: existingPending.amount,
      rawAmount: existingPending.rawAmount,
      uniqueCode: existingPending.uniqueCode,
      qrisString: existingPending.qrisString,
      qrisQrUrl: existingPending.qrisQrUrl,
      checkoutUrl: `${reqUrl.origin}/pay/${existingPending.paymentId}`,
      expiresAt: existingPending.expiresAt,
      callbackUrl: existingPending.callbackUrl,
      reused: true,
    });
  }

  let finalAmount = integerAmount;
  let uniqueCode: number | undefined;

  if (useUniqueCode) {
    const minCode = Math.max(1, Number(uniqueCodeMin) || 1);
    const maxCode = Math.max(minCode, Math.min(9999, Number(uniqueCodeMax) || 250));
    const isSubtract = uniqueCodeType === 'SUBTRACT';

    const pendingAmounts = new Set(
      allOrders
        .filter((o) => o.status === 'PENDING' && new Date(o.expiresAt).getTime() > Date.now())
        .map((o) => o.amount)
    );

    for (let attempt = 0; attempt < (maxCode - minCode + 1) * 2; attempt++) {
      const candidateCode = Math.floor(minCode + Math.random() * (maxCode - minCode + 1));
      const candidateAmount = isSubtract ? integerAmount - candidateCode : integerAmount + candidateCode;
      if (candidateAmount >= 1 && !pendingAmounts.has(candidateAmount)) {
        finalAmount = candidateAmount;
        uniqueCode = candidateCode;
        break;
      }
    }
  }

  const activeTemplate = getActiveTemplate();
  const paymentId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
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
  };

  await storage.savePaymentOrder(order);

  const checkoutUrl = `${reqUrl.origin}/pay/${paymentId}`;

  return c.json({
    success: true,
    paymentId,
    orderId: order.orderId,
    amount: order.amount,
    rawAmount: order.rawAmount,
    uniqueCode: order.uniqueCode,
    qrisString,
    qrisQrUrl,
    checkoutUrl,
    expiresAt,
    callbackUrl: order.callbackUrl,
  });
});

payment.get('/status/:paymentId', async (c) => {
  const paymentId = c.req.param('paymentId');
  const order = await storage.getPaymentOrder(paymentId);

  if (!order) {
    return c.json({ error: 'Payment order not found' }, 404);
  }

  if (order.status === 'PENDING') {
    const isExpired = new Date(order.expiresAt).getTime() < Date.now();
    if (isExpired) {
      order.status = 'EXPIRED';
      await storage.savePaymentOrder(order);
    } else {
      const orderCreatedAt = new Date(order.createdAt).getTime();
      const allOrders = (await storage.getAllPaymentOrders?.()) || [];
      const usedTxIds = getUsedTransactionIds(allOrders);

      const txs = await storage.getTransactions();
      let matched = txs.find((tx) =>
        isTransactionMatch(tx, order.amount, orderCreatedAt, usedTxIds)
      );

      // Attempt single-flight coalesced sync from GoBiz if session is active and transaction not found locally
      if (!matched) {
        try {
          const freshItems = await fetchTransactionsCoalesced(manager, client, storage);
          matched = freshItems.find((tx) =>
            isTransactionMatch(tx, order.amount, orderCreatedAt, usedTxIds)
          );
        } catch {
          // Ignore sync errors and report current state
        }
      }

      if (matched) {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        order.transactionId = matched.id;

        const targetCallback = order.callbackUrl || getGlobalWebhookUrl();
        if (targetCallback && order.callbackStatus !== 'SUCCESS') {
          sendWebhookNotification(targetCallback, order, matched)
            .then((ok) => {
              order.callbackStatus = ok ? 'SUCCESS' : 'FAILED';
              storage.savePaymentOrder(order).catch(() => {});
            })
            .catch(() => {});
        }

        await storage.savePaymentOrder(order);
      }
    }
  }

  return c.json({
    success: true,
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
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

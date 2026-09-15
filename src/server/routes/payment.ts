import { Hono } from 'hono';
import { FileStorageAdapter } from '../../core/storage/file-storage';
import { SessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';
import { generateDynamicQRIS, generateQRCodeDataURL, inspectQRIS } from '../../core/qris-generator';
import { PaymentOrder } from '../../core/storage/storage.interface';
import { getGlobalWebhookUrl, sendWebhookNotification } from '../reconciler';
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
    console.error('[decode-qr] No imageBase64 provided');
    return c.json({ error: 'Data gambar QR code tidak ditemukan' }, 400);
  }

  let tempFilePath: string | null = null;
  try {
    const pythonScript = path.join(process.cwd(), 'decode_qr.py');
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const buffer = Buffer.from(base64Data, 'base64');

    console.log(`[decode-qr] Received image: ${buffer.length} bytes`);

    // Always preserve last upload for diagnostics
    try {
      fs.writeFileSync(path.join(process.cwd(), 'last_uploaded_qr_debug.bin'), buffer);
    } catch {}

    const randomSuffix = Math.random().toString(36).substring(2, 10);
    tempFilePath = path.join(os.tmpdir(), `kaigobiz_qr_${Date.now()}_${randomSuffix}.png`);
    fs.writeFileSync(tempFilePath, buffer);

    const qrString = execFileSync('python3', [pythonScript, tempFilePath], {
      encoding: 'utf-8',
      timeout: 20000,
    }).trim();

    console.log(`[decode-qr] Scanner output: ${qrString.substring(0, 60)}...`);

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
  let config: Record<string, any> = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    } catch {}
  }

  config.webhookUrl = webhookUrl && typeof webhookUrl === 'string' && webhookUrl.trim() ? webhookUrl.trim() : null;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');

  return c.json({
    success: true,
    webhookUrl: config.webhookUrl,
    message: 'Konfigurasi Webhook URL berhasil diperbarui.',
  });
});

// Create dynamic payment
payment.post('/create', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { orderId, amount, expiryMinutes = 5, callbackUrl } = body || {};
  const numericAmount = Number(amount);

  if (!orderId || isNaN(numericAmount) || numericAmount <= 0) {
    return c.json({ error: 'Valid orderId and positive amount are required' }, 400);
  }

  const activeTemplate = getActiveTemplate();
  const paymentId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const qrisString = generateDynamicQRIS(activeTemplate, numericAmount);
  const qrisQrUrl = await generateQRCodeDataURL(qrisString);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

  const order: PaymentOrder = {
    paymentId,
    orderId: String(orderId),
    amount: Math.round(numericAmount),
    qrisString,
    qrisQrUrl,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    expiresAt,
    callbackUrl: callbackUrl && typeof callbackUrl === 'string' && callbackUrl.trim() ? callbackUrl.trim() : undefined,
  };

  await storage.savePaymentOrder(order);

  const reqUrl = new URL(c.req.url);
  const checkoutUrl = `${reqUrl.origin}/pay/${paymentId}`;

  return c.json({
    success: true,
    paymentId,
    orderId: order.orderId,
    amount: order.amount,
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
      const txs = await storage.getTransactions();

      let matched = txs.find(
        (tx) =>
          tx.status === 'COMPLETED' &&
          Math.abs(tx.amount - order.amount) < 0.01 &&
          new Date(tx.timestamp).getTime() >= orderCreatedAt - 5000
      );

      // Attempt sync from GoBiz if session is active and transaction not found locally
      if (!matched) {
        try {
          const session = await manager.refreshIfNeeded();
          if (session) {
            const freshItems = await client.fetchTransactions(session);
            if (freshItems.length > 0) {
              await storage.saveTransactions(freshItems);
            }
            matched = freshItems.find(
              (tx) =>
                tx.status === 'COMPLETED' &&
                Math.abs(tx.amount - order.amount) < 0.01 &&
                new Date(tx.timestamp).getTime() >= orderCreatedAt - 5000
            );
          }
        } catch {
          // Ignore sync errors and report current state
        }
      }

      if (matched) {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();

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
    qrisString: order.qrisString,
    qrisQrUrl: order.qrisQrUrl,
  });
});

export default payment;

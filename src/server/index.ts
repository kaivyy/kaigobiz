import dotenv from 'dotenv';
import crypto from 'crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth';
import paymentRoutes from './routes/payment';
import transactionRoutes from './routes/transactions';
import { getStorage } from '../core/storage';
import { getSessionManager } from '../core/session-manager';
import { GoBizClient } from '../core/gobiz-client';
import { ensureApiKeyInitialized, getActiveApiKey, maskApiKey } from '../core/api-key';
import { startBackgroundReconciler } from './reconciler';
import { escapeHtml, renderCheckoutPage } from './checkout-page';

if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

const app = new Hono();

function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

const adminCors = cors({
  origin: (origin) => {
    const allowed = getAllowedOrigins();
    if (!origin) return '';
    return allowed.includes(origin) ? origin : '';
  },
});

const publicCors = cors({
  origin: (origin) => {
    const allowed = getAllowedOrigins();
    if (allowed.length > 0) {
      return origin && allowed.includes(origin) ? origin : '';
    }
    return origin || '*';
  },
});

app.use('/api/v1/auth/*', adminCors);
app.use('/api/v1/transactions', adminCors);
app.use('/api/v1/transactions/*', adminCors);
app.use('/api/v1/payment/template', adminCors);
app.use('/api/v1/payment/webhook-config', adminCors);
app.use('/api/v1/payment/decode-qr', adminCors);

app.use('/api/v1/health', publicCors);
app.use('/api/v1/payment/create', publicCors);
app.use('/api/v1/payment/status/*', publicCors);
app.use('/kaigobiz.js', publicCors);

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('X-Frame-Options', 'SAMEORIGIN');
  c.header(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
  );
});

app.use('/api/v1/*', async (c, next) => {
  const maxSize = c.req.path === '/api/v1/payment/decode-qr' ? 11 * 1024 * 1024 : 1 * 1024 * 1024;
  return bodyLimit({
    maxSize,
    onError: (ctx) => ctx.json({ error: 'Ukuran payload melebihi batas maksimum server' }, 413),
  })(c, next);
});

function constantTimeMatch(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function extractApiKey(c: any): string {
  const direct = c.req.header('x-api-key');
  if (direct && direct.trim()) return direct.trim();
  const authHeader = c.req.header('authorization') || '';
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    return authHeader.slice(7).trim();
  }
  return '';
}

const requireApiKey = async (c: any, next: any) => {
  const configuredKey = getActiveApiKey();
  if (!configuredKey) {
    return await next();
  }
  const provided = extractApiKey(c);
  if (!provided || !constantTimeMatch(provided, configuredKey)) {
    return c.json({ error: 'Unauthorized', code: 'API_KEY_REQUIRED' }, 401);
  }
  return await next();
};

app.use('/api/v1/auth/*', requireApiKey);
app.use('/api/v1/transactions', requireApiKey);
app.use('/api/v1/transactions/*', requireApiKey);
app.use('/api/v1/payment/template', requireApiKey);
app.use('/api/v1/payment/webhook-config', requireApiKey);
app.use('/api/v1/payment/decode-qr', requireApiKey);
app.use('/api/v1/payment/create', async (c, next) => {
  if (process.env.KAIGOBIZ_PUBLIC_CREATE === 'true') {
    return await next();
  }
  return await requireApiKey(c, next);
});

app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/payment', paymentRoutes);
app.route('/api/v1/transactions', transactionRoutes);

const checkoutHandler = async (c: any) => {
  const paymentId = c.req.param('paymentId');
  const storage = getStorage();
  const order = await storage.getPaymentOrder(paymentId);
  if (!order) {
    return c.html(
      `
      <!DOCTYPE html>
      <html lang="id">
      <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><link rel="icon" type="image/svg+xml" href="/favicon.svg"/><title>Tidak Ditemukan</title></head>
      <body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center;">
        <div>
          <h1 style="font-size:24px;margin-bottom:8px;">Pembayaran Tidak Ditemukan</h1>
          <p style="color:#94a3b8;font-size:14px;">ID pembayaran "${escapeHtml(paymentId)}" tidak valid atau telah dihapus.</p>
        </div>
      </body>
      </html>
    `,
      404
    );
  }

  let merchantName = 'Merchant GoBiz';
  try {
    const session = await storage.getSession();
    if (session?.outlet_name) {
      merchantName = session.outlet_name;
    }
  } catch {}

  return c.html(renderCheckoutPage(order, merchantName));
};

app.get('/pay/:paymentId', checkoutHandler);
app.get('/checkout/:paymentId', checkoutHandler);

app.use('/*', serveStatic({ root: './dist' }));

const PORT = Number(process.env.PORT || 3636);

if (process.env.NODE_ENV !== 'test') {
  (async () => {
    const storage = getStorage();
    const keyInit = await ensureApiKeyInitialized({ storage });
    if (keyInit.source === 'generated') {
      console.log(
        `[KaiGoBiz Security] KAIGOBIZ_API_KEY otomatis dibuat dan disimpan ke .env (${maskApiKey(keyInit.key)}). Lihat file .env untuk menyalin kunci lengkap.`
      );
    } else if (keyInit.source === 'env' || keyInit.source === 'storage') {
      console.log(`[KaiGoBiz Security] Proteksi API Key aktif (${maskApiKey(keyInit.key)}).`);
    } else {
      console.warn('[KaiGoBiz Security] Proteksi API Key dinonaktifkan lewat KAIGOBIZ_DISABLE_AUTH=true.');
    }

    const manager = getSessionManager(storage);
    const client = new GoBizClient();
    startBackgroundReconciler(storage, manager, client, 7000);

    serve({ fetch: app.fetch, port: PORT }, (info) => {
      console.log(`\nKaiGoBiz Payment Gateway Server running on http://localhost:${info.port}`);
      console.log(`UI Dashboard: http://localhost:${info.port}`);
      console.log(`Embed Widget Script: http://localhost:${info.port}/kaigobiz.js\n`);
    });
  })().catch((err) => {
    console.error('[KaiGoBiz Fatal] Gagal memulai server:', err);
    process.exit(1);
  });
}

export default app;

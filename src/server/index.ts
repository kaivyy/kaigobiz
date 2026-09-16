import 'dotenv/config';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth';
import paymentRoutes from './routes/payment';
import transactionRoutes from './routes/transactions';
import { FileStorageAdapter } from '../core/storage/file-storage';
import { SessionManager } from '../core/session-manager';
import { GoBizClient } from '../core/gobiz-client';
import { startBackgroundReconciler } from './reconciler';
import { renderCheckoutPage } from './checkout-page';

const app = new Hono();

app.use('*', cors({ origin: '*' }));

app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-XSS-Protection', '1; mode=block');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/payment', paymentRoutes);
app.route('/api/v1/transactions', transactionRoutes);

// Checkout / Payment Page for end-customers (similar to Midtrans Snap / Xendit Invoice)
const checkoutHandler = async (c: any) => {
  const paymentId = c.req.param('paymentId');
  const storage = new FileStorageAdapter();
  const order = await storage.getPaymentOrder(paymentId);
  if (!order) {
    return c.html(`
      <!DOCTYPE html>
      <html lang="id">
      <head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/><title>Tidak Ditemukan</title></head>
      <body style="font-family:sans-serif;background:#0f172a;color:#f8fafc;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;padding:20px;text-align:center;">
        <div>
          <h1 style="font-size:24px;margin-bottom:8px;">Pembayaran Tidak Ditemukan</h1>
          <p style="color:#94a3b8;font-size:14px;">ID pembayaran "${paymentId}" tidak valid atau telah dihapus.</p>
        </div>
      </body>
      </html>
    `, 404);
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

// Serve static dashboard and widget from dist
app.use('/*', serveStatic({ root: './dist' }));

const PORT = Number(process.env.PORT || 3636);

if (process.env.NODE_ENV !== 'test') {
  const storage = new FileStorageAdapter();
  const manager = new SessionManager(storage);
  const client = new GoBizClient();
  startBackgroundReconciler(storage, manager, client, 7000);

  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`\n🚀 KaiGoBiz Payment Gateway Server running on http://localhost:${info.port}`);
    console.log(`📱 UI Dashboard: http://localhost:${info.port}`);
    console.log(`🔌 Embed Widget Script: http://localhost:${info.port}/kaigobiz.js\n`);
  });
}

export default app;

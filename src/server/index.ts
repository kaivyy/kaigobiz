import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import authRoutes from './routes/auth';
import paymentRoutes from './routes/payment';
import transactionRoutes from './routes/transactions';

const app = new Hono();

app.use('*', cors({ origin: '*' }));

app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/payment', paymentRoutes);
app.route('/api/v1/transactions', transactionRoutes);

// Serve static dashboard and widget from dist
app.use('/*', serveStatic({ root: './dist' }));

const PORT = Number(process.env.PORT || 3000);

if (process.env.NODE_ENV !== 'test') {
  serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`\n🚀 KaiGoBiz Payment Gateway Server running on http://localhost:${info.port}`);
    console.log(`📱 UI Dashboard: http://localhost:${info.port}`);
    console.log(`🔌 Embed Widget Script: http://localhost:${info.port}/kaigobiz.js\n`);
  });
}

export default app;

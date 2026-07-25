import { Hono } from 'hono';
import { cors } from 'hono/cors';
import authRoutes from './routes/auth';
import paymentRoutes from './routes/payment';
import transactionRoutes from './routes/transactions';

const app = new Hono();

app.use('*', cors({ origin: '*' }));

app.get('/api/v1/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.route('/api/v1/auth', authRoutes);
app.route('/api/v1/payment', paymentRoutes);
app.route('/api/v1/transactions', transactionRoutes);

export default app;

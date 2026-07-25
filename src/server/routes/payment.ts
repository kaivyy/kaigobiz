import { Hono } from 'hono';
import { FileStorageAdapter } from '../../core/storage/file-storage';
import { generateDynamicQRIS, generateQRCodeDataURL } from '../../core/qris-generator';
import { PaymentOrder } from '../../core/storage/storage.interface';

const payment = new Hono();
const storage = new FileStorageAdapter();

// Default static QRIS template if not set in config
const DEFAULT_STATIC_QRIS = process.env.STATIC_QRIS_TEMPLATE || '00020101021226580014ID.GO-JEK.WWW01189360091430000000005204581253033605802ID5913KAI GOBIZ SHOP6007JAKARTA6304ABCD';

payment.post('/create', async (c) => {
  const { orderId, amount, expiryMinutes = 5 } = await c.req.json();
  if (!orderId || !amount) return c.json({ error: 'orderId and amount are required' }, 400);

  const paymentId = 'pay_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
  const qrisString = generateDynamicQRIS(DEFAULT_STATIC_QRIS, amount);
  const qrisQrUrl = await generateQRCodeDataURL(qrisString);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000).toISOString();

  const order: PaymentOrder = {
    paymentId,
    orderId,
    amount: parseFloat(amount),
    qrisString,
    qrisQrUrl,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    expiresAt,
  };

  await storage.savePaymentOrder(order);

  return c.json({
    success: true,
    paymentId,
    orderId,
    amount: order.amount,
    qrisString,
    qrisQrUrl,
    expiresAt,
  });
});

payment.get('/status/:paymentId', async (c) => {
  const paymentId = c.req.param('paymentId');
  const order = await storage.getPaymentOrder(paymentId);
  if (!order) return c.json({ error: 'Payment not found' }, 404);

  // Check expiration
  if (order.status === 'PENDING' && new Date(order.expiresAt).getTime() < Date.now()) {
    order.status = 'EXPIRED';
    await storage.savePaymentOrder(order);
  }

  return c.json({
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
    status: order.status,
    expiresAt: order.expiresAt,
  });
});

export default payment;

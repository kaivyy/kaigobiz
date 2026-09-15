import { describe, it, expect } from 'vitest';
import app from '../src/server/index';

describe('KaiGoBiz REST API Server Routes', () => {
  it('GET /api/v1/health should return status ok', async () => {
    const res = await app.request('/api/v1/health');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.timestamp).toBeDefined();
  });

  it('GET /api/v1/auth/status should return auth status', async () => {
    const res = await app.request('/api/v1/auth/status');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('connected');
  });

  it('POST /api/v1/payment/create should create dynamic QRIS payment', async () => {
    const res = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'ORDER-12345',
        amount: 25000,
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.paymentId).toBeDefined();
    expect(body.orderId).toBe('ORDER-12345');
    expect(body.amount).toBe(25000);
    expect(body.qrisString).toBeDefined();
    expect(body.qrisQrUrl).toBeDefined();
    expect(body.expiresAt).toBeDefined();
  });

  it('GET /api/v1/payment/status/:paymentId should return payment status and reconcile to PAID', async () => {
    // First create a payment with unique amount
    const testAmount = 57000;
    const createRes = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'ORDER-67890-' + Date.now(),
        amount: testAmount,
      }),
    });
    const createBody = await createRes.json();
    const paymentId = createBody.paymentId;

    // Check pending status
    const statusRes = await app.request(`/api/v1/payment/status/${paymentId}`);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.paymentId).toBe(paymentId);
    expect(statusBody.amount).toBe(testAmount);
    expect(statusBody.status).toBe('PENDING');

    // Simulate incoming completed transaction
    const { FileStorageAdapter } = await import('../src/core/storage/file-storage');
    const storage = new FileStorageAdapter();
    await storage.saveTransaction({
      id: 'tx_reconcile_' + Date.now(),
      amount: testAmount,
      timestamp: new Date().toISOString(),
      status: 'COMPLETED',
    });

    // Verify reconciliation to PAID
    const reconciledRes = await app.request(`/api/v1/payment/status/${paymentId}`);
    const reconciledBody = await reconciledRes.json();
    expect(reconciledBody.status).toBe('PAID');

    // Clean up test transactions so production storage stays clean
    const currentTxs = await storage.getTransactions();
    const cleanTxs = currentTxs.filter((t) => !t.id.startsWith('tx_reconcile_'));
    const fs = await import('fs');
    const path = await import('path');
    const txFile = path.join(process.cwd(), '.kaigobiz-tx.json');
    if (fs.existsSync(txFile)) {
      fs.writeFileSync(txFile, JSON.stringify(cleanTxs, null, 2));
    }
  });

  it('POST /api/v1/payment/create should reject invalid amount', async () => {
    const res = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'ORDER-INV',
        amount: -5000,
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/v1/auth/request-otp should reject invalid phone', async () => {
    const res = await app.request('/api/v1/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        phone: 'invalid-phone',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('GET and POST /api/v1/payment/webhook-config should manage global webhook URL', async () => {
    const postRes = await app.request('/api/v1/payment/webhook-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://example.com/webhook' }),
    });
    expect(postRes.status).toBe(200);
    const postBody = await postRes.json();
    expect(postBody.webhookUrl).toBe('https://example.com/webhook');

    const getRes = await app.request('/api/v1/payment/webhook-config');
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.webhookUrl).toBe('https://example.com/webhook');
  });

  it('POST /api/v1/payment/create should accept and store callbackUrl', async () => {
    const res = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'ORDER-CB-1',
        amount: 35000,
        callbackUrl: 'https://myshop.test/webhook',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.callbackUrl).toBe('https://myshop.test/webhook');
  });
});

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

  it('GET /api/v1/payment/status/:paymentId should return payment status', async () => {
    // First create a payment
    const createRes = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'ORDER-67890',
        amount: 50000,
      }),
    });
    const createBody = await createRes.json();
    const paymentId = createBody.paymentId;

    // Get status
    const statusRes = await app.request(`/api/v1/payment/status/${paymentId}`);
    expect(statusRes.status).toBe(200);
    const statusBody = await statusRes.json();
    expect(statusBody.paymentId).toBe(paymentId);
    expect(statusBody.orderId).toBe('ORDER-67890');
    expect(statusBody.amount).toBe(50000);
    expect(statusBody.status).toBe('PENDING');
  });
});

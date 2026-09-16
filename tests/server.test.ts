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

    // Clean up webhook URL so it doesn't trigger spurious webhook calls during tests
    await app.request('/api/v1/payment/webhook-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl: '' }),
    });
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

  it('Reconciliation should prevent duplicate settlement for identical amounts', async () => {
    const { FileStorageAdapter } = await import('../src/core/storage/file-storage');
    const storage = new FileStorageAdapter();
    const testAmount = 42000;

    // Create Order A
    const resA = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORDER-DUP-A-' + Date.now(), amount: testAmount }),
    });
    const orderA = await resA.json();

    // Create Order B with identical amount
    const resB = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORDER-DUP-B-' + Date.now(), amount: testAmount }),
    });
    const orderB = await resB.json();

    // Save only ONE incoming transaction for 42000
    const txId1 = 'tx_reconcile_unique_' + Date.now();
    await storage.saveTransaction({
      id: txId1,
      amount: testAmount,
      timestamp: new Date().toISOString(),
      status: 'COMPLETED',
    });

    // Check Order A -> should be reconciled to PAID with transactionId
    const statusResA = await app.request(`/api/v1/payment/status/${orderA.paymentId}`);
    const statusBodyA = await statusResA.json();
    expect(statusBodyA.status).toBe('PAID');
    expect(statusBodyA.transactionId).toBe(txId1);

    // Check Order B -> MUST remain PENDING because txId1 is already consumed by Order A!
    const statusResB = await app.request(`/api/v1/payment/status/${orderB.paymentId}`);
    const statusBodyB = await statusResB.json();
    expect(statusBodyB.status).toBe('PENDING');

    // Now save a SECOND transaction for 42000
    const txId2 = 'tx_reconcile_unique_2_' + Date.now();
    await storage.saveTransaction({
      id: txId2,
      amount: testAmount,
      timestamp: new Date().toISOString(),
      status: 'COMPLETED',
    });

    // Check Order B again -> now it should be reconciled to PAID with txId2
    const statusResB2 = await app.request(`/api/v1/payment/status/${orderB.paymentId}`);
    const statusBodyB2 = await statusResB2.json();
    expect(statusBodyB2.status).toBe('PAID');
    expect(statusBodyB2.transactionId).toBe(txId2);

    // Clean up
    const currentTxs = await storage.getTransactions();
    const cleanTxs = currentTxs.filter((t) => !t.id.startsWith('tx_reconcile_'));
    const fs = await import('fs');
    const path = await import('path');
    const txFile = path.join(process.cwd(), '.kaigobiz-tx.json');
    if (fs.existsSync(txFile)) {
      fs.writeFileSync(txFile, JSON.stringify(cleanTxs, null, 2));
    }
  });

  it('Reconciliation should match sen units (amount / 100)', async () => {
    const { FileStorageAdapter } = await import('../src/core/storage/file-storage');
    const storage = new FileStorageAdapter();
    const testAmount = 18500;

    const res = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORDER-SEN-' + Date.now(), amount: testAmount }),
    });
    const order = await res.json();

    // Transaction in sen (1850000 = 18500 * 100)
    const txId = 'tx_reconcile_sen_' + Date.now();
    await storage.saveTransaction({
      id: txId,
      amount: testAmount * 100,
      timestamp: new Date().toISOString(),
      status: 'COMPLETED',
    });

    const statusRes = await app.request(`/api/v1/payment/status/${order.paymentId}`);
    const statusBody = await statusRes.json();
    expect(statusBody.status).toBe('PAID');
    expect(statusBody.transactionId).toBe(txId);

    // Clean up
    const currentTxs = await storage.getTransactions();
    const cleanTxs = currentTxs.filter((t) => !t.id.startsWith('tx_reconcile_'));
    const fs = await import('fs');
    const path = await import('path');
    const txFile = path.join(process.cwd(), '.kaigobiz-tx.json');
    if (fs.existsSync(txFile)) {
      fs.writeFileSync(txFile, JSON.stringify(cleanTxs, null, 2));
    }
  });

  it('POST /api/v1/payment/create should strictly validate amount boundaries and Infinity', async () => {
    // 0 amount
    const res0 = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-BOUND-0', amount: 0 }),
    });
    expect(res0.status).toBe(400);

    // Infinity amount
    const resInf = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-BOUND-INF', amount: 'Infinity' }),
    });
    expect(resInf.status).toBe(400);

    // Exceed max QRIS limit (> 100M)
    const resMax = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-BOUND-MAX', amount: 150000000 }),
    });
    expect(resMax.status).toBe(400);

    // Invalid expiryMinutes (> 1440)
    const resExp = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-BOUND-EXP', amount: 10000, expiryMinutes: 5000 }),
    });
    expect(resExp.status).toBe(400);
  });

  it('POST /api/v1/payment/create should be idempotent for identical pending orders', async () => {
    const orderId = 'ORD-IDEMPOTENT-' + Date.now();
    const amount = 30000;

    const res1 = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, amount }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();

    const res2 = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, amount }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();

    // Must return the exact same paymentId (reused)
    expect(body2.paymentId).toBe(body1.paymentId);
    expect(body2.reused).toBe(true);
  });

  it('renderCheckoutPage should escape malicious payloads to prevent XSS', async () => {
    const { renderCheckoutPage } = await import('../src/server/checkout-page');
    const xssOrder = {
      paymentId: 'pay_xss_test',
      orderId: '</script><script>alert("XSS")</script>',
      amount: 50000,
      qrisString: '000201010211...',
      qrisQrUrl: 'https://example.com/qr.png" onerror="alert(1)',
      status: 'PENDING' as const,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 300000).toISOString(),
      callbackUrl: 'javascript:alert(document.cookie)',
    };

    const html = renderCheckoutPage(xssOrder, '<img src=x onerror=alert(1)>');

    // Escaped JSON should not contain raw unescaped </script>
    expect(html).not.toContain('</script><script>alert("XSS")</script>');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(\\"XSS\\")\\u003c/script>');

    // QR image src should be escaped
    expect(html).not.toContain('src="https://example.com/qr.png" onerror="alert(1)"');

    // Merchant name should be HTML-escaped
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
  });

  it('POST /api/v1/payment/create with useUniqueCode should assign non-colliding unique amount', async () => {
    const res1 = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-UNIQ-1-' + Date.now(), amount: 50000, useUniqueCode: true }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json();
    expect(body1.rawAmount).toBe(50000);
    expect(body1.uniqueCode).toBeGreaterThanOrEqual(1);
    expect(body1.uniqueCode).toBeLessThanOrEqual(999);
    expect(body1.amount).toBe(50000 + body1.uniqueCode);

    const res2 = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId: 'ORD-UNIQ-2-' + Date.now(), amount: 50000, useUniqueCode: true }),
    });
    expect(res2.status).toBe(200);
    const body2 = await res2.json();
    expect(body2.rawAmount).toBe(50000);
    expect(body2.uniqueCode).toBeDefined();
    // Unique amounts must not collide
    expect(body2.amount).not.toBe(body1.amount);
  });

  it('POST /api/v1/payment/create with uniqueCodeMax and SUBTRACT should cap code and deduct amount', async () => {
    const res = await app.request('/api/v1/payment/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        orderId: 'ORD-SUB-' + Date.now(),
        amount: 75000,
        useUniqueCode: true,
        uniqueCodeMin: 5,
        uniqueCodeMax: 35,
        uniqueCodeType: 'SUBTRACT',
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rawAmount).toBe(75000);
    expect(body.uniqueCode).toBeGreaterThanOrEqual(5);
    expect(body.uniqueCode).toBeLessThanOrEqual(35);
    expect(body.amount).toBe(75000 - body.uniqueCode);
  });
});

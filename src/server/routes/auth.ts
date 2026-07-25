import { Hono } from 'hono';
import { SessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';
import { FileStorageAdapter } from '../../core/storage/file-storage';

const auth = new Hono();
const storage = new FileStorageAdapter();
const manager = new SessionManager(storage);
const client = new GoBizClient();

auth.get('/status', async (c) => {
  const session = await manager.getSession();
  const isExpired = manager.isExpired(session);
  return c.json({
    connected: !!session && !isExpired,
    session: session ? {
      phone_number: session.phone_number,
      outlet_name: session.outlet_name,
      merchant_id: session.merchant_id,
      expires_at: session.expires_at,
    } : null,
  });
});

auth.post('/request-otp', async (c) => {
  const { phone } = await c.req.json();
  if (!phone) return c.json({ error: 'Phone number is required' }, 400);
  try {
    const result = await client.requestOTP(phone);
    return c.json({ success: true, ...result });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to request OTP' }, 500);
  }
});

auth.post('/verify-otp', async (c) => {
  const { phone, otp, otpToken } = await c.req.json();
  if (!phone || !otp || !otpToken) return c.json({ error: 'Missing parameters' }, 400);
  try {
    const session = await client.verifyOTP(phone, otp, otpToken);
    await manager.saveSession(session);
    return c.json({ success: true, session });
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to verify OTP' }, 500);
  }
});

export default auth;

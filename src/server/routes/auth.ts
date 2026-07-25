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

import { execSync } from 'child_process';
import path from 'path';

auth.post('/request-otp', async (c) => {
  const { phone } = await c.req.json();
  if (!phone) return c.json({ error: 'Phone number is required' }, 400);
  
  try {
    const result = await client.requestOTP(phone);
    return c.json({ success: true, ...result });
  } catch (err: any) {
    // Fallback to Camoufox Headless Browser Helper if Direct API is blocked by 401
    try {
      const pythonScript = path.join(process.cwd(), 'camoufox_gobiz_login.py');
      const output = execSync(`python3 "${pythonScript}" "${phone}"`, { encoding: 'utf-8', timeout: 30000 });
      return c.json({
        success: true,
        otpToken: 'camoufox_session_' + Date.now(),
        message: 'Kode OTP telah dikirimkan via Camoufox browser!',
      });
    } catch (camoufoxErr: any) {
      return c.json({ error: 'Gagal mengirim OTP via Camoufox: ' + (camoufoxErr.message || err.message) }, 500);
    }
  }
});

auth.post('/verify-otp', async (c) => {
  const { phone, otp, otpToken } = await c.req.json();
  if (!phone || !otp) return c.json({ error: 'Missing parameters' }, 400);

  try {
    let session;
    if (otpToken && !otpToken.startsWith('camoufox_session_')) {
      session = await client.verifyOTP(phone, otp, otpToken);
    } else {
      const pythonScript = path.join(process.cwd(), 'camoufox_gobiz_login.py');
      execSync(`python3 "${pythonScript}" "${phone}" "${otp}"`, { encoding: 'utf-8', timeout: 30000 });
      session = await manager.getSession();
    }

    if (session) {
      await manager.saveSession(session);
      return c.json({ success: true, session });
    }
    return c.json({ error: 'Verifikasi OTP gagal. Sesi tidak ditemukan.' }, 400);
  } catch (err: any) {
    return c.json({ error: err.message || 'Failed to verify OTP' }, 500);
  }
});

export default auth;

import { Hono } from 'hono';
import { SessionManager } from '../../core/session-manager';
import { GoBizClient } from '../../core/gobiz-client';
import { FileStorageAdapter } from '../../core/storage/file-storage';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const auth = new Hono();
const storage = new FileStorageAdapter();
const manager = new SessionManager(storage);
const client = new GoBizClient();

const STATE_FILE = path.join(process.cwd(), '.kaigobiz-worker-state.json');
const COMMAND_FILE = path.join(process.cwd(), '.kaigobiz-worker-command.json');
const WORKER_SCRIPT = path.join(process.cwd(), 'camoufox_gobiz_worker.py');

auth.get('/status', async (c) => {
  let session = await manager.refreshIfNeeded();
  if (!session) {
    session = await manager.getSession();
  }
  const isExpired = manager.isExpired(session);

  if (session && !isExpired) {
    // If merchant details are missing or incomplete, fetch them from GoBiz API
    if (!session.merchant_id || !session.outlet_name || !session.owner_name) {
      try {
        const profile = await client.fetchUserProfile(session);
        if (profile) {
          session.merchant_id = profile.merchant_id || session.merchant_id;
          session.outlet_name = profile.outlet_name || session.outlet_name;
          session.owner_name = profile.owner_name || session.owner_name;
          session.phone_number = profile.phone_number || session.phone_number;
          session.outlet_address = profile.outlet_address || session.outlet_address;
          session.kyc_status = profile.kyc_status || session.kyc_status;
          session.features = profile.features || session.features;
          session.updated_at = new Date().toISOString();
          await storage.saveSession(session);
        }
      } catch {}
    }
  }

  return c.json({
    connected: !!session && !isExpired,
    session: session
      ? {
          phone_number: session.phone_number,
          outlet_name: session.outlet_name,
          owner_name: session.owner_name,
          merchant_id: session.merchant_id,
          outlet_address: session.outlet_address,
          kyc_status: session.kyc_status,
          features: session.features,
          expires_at: session.expires_at,
          updated_at: session.updated_at,
        }
      : null,
  });
});

auth.post('/refresh-profile', async (c) => {
  let session = await manager.getSession();
  if (!session || manager.isExpired(session)) {
    return c.json({ error: 'Sesi GoBiz tidak aktif' }, 401);
  }

  try {
    const profile = await client.fetchUserProfile(session);
    if (!profile) {
      return c.json({ error: 'Gagal mengambil data profil dari server GoBiz' }, 502);
    }

    session.merchant_id = profile.merchant_id || session.merchant_id;
    session.outlet_name = profile.outlet_name || session.outlet_name;
    session.owner_name = profile.owner_name || session.owner_name;
    session.phone_number = profile.phone_number || session.phone_number;
    session.outlet_address = profile.outlet_address || session.outlet_address;
    session.kyc_status = profile.kyc_status || session.kyc_status;
    session.features = profile.features || session.features;
    session.updated_at = new Date().toISOString();
    await storage.saveSession(session);

    return c.json({
      success: true,
      message: 'Profil merchant berhasil disinkronkan langsung dari GoBiz',
      session: {
        phone_number: session.phone_number,
        outlet_name: session.outlet_name,
        owner_name: session.owner_name,
        merchant_id: session.merchant_id,
        outlet_address: session.outlet_address,
        kyc_status: session.kyc_status,
        features: session.features,
        expires_at: session.expires_at,
      },
    });
  } catch (err: any) {
    return c.json({ error: 'Gagal menyinkronkan profil: ' + (err.message || 'Error') }, 500);
  }
});

auth.post('/logout', async (c) => {
  await storage.clearSession();
  return c.json({
    success: true,
    message: 'Sesi GoBiz berhasil diputuskan.',
  });
});

let lastOtpRequestTimestamp = 0;
const OTP_COOLDOWN_MS = process.env.NODE_ENV === 'test' ? 1000 : 20_000;

auth.post('/request-otp', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { phone } = body || {};
  if (!phone) return c.json({ error: 'Phone number is required' }, 400);

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15) {
    return c.json({ error: 'Invalid phone number format' }, 400);
  }

  const now = Date.now();
  if (now - lastOtpRequestTimestamp < OTP_COOLDOWN_MS) {
    const remaining = Math.ceil((OTP_COOLDOWN_MS - (now - lastOtpRequestTimestamp)) / 1000);
    return c.json({ error: `Harap tunggu ${remaining} detik sebelum meminta kode OTP kembali.` }, 429);
  }
  lastOtpRequestTimestamp = now;

  // 1. First attempt direct API
  try {
    const result = await client.requestOTP(cleanPhone);
    if (result && result.otpToken) {
      return c.json({ success: true, ...result });
    }
  } catch {}

  // 2. Fallback to Camoufox persistent worker
  try {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const oldState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        if (oldState.pid) {
          try { process.kill(oldState.pid, 'SIGKILL'); } catch {}
        }
      } catch {}
      try { fs.unlinkSync(STATE_FILE); } catch {}
    }
    if (fs.existsSync(COMMAND_FILE)) {
      try { fs.unlinkSync(COMMAND_FILE); } catch {}
    }

    const worker = spawn('python3', [WORKER_SCRIPT, cleanPhone], {
      detached: true,
      stdio: 'ignore',
    });
    worker.unref();

    const startTime = Date.now();
    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 600));
      if (fs.existsSync(STATE_FILE)) {
        try {
          const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
          if (state.status === 'otp_sent') {
            return c.json({
              success: true,
              otpToken: 'camoufox_worker_' + Date.now(),
              message: 'Kode OTP telah dikirimkan ke nomor ' + cleanPhone,
            });
          }
          if (state.status === 'error') {
            return c.json({ error: state.message || 'Gagal mengirimkan kode OTP' }, 400);
          }
        } catch {}
      }
    }

    return c.json({ error: 'Batas waktu meminta OTP terlampaui (timeout)' }, 504);
  } catch (err: any) {
    return c.json({ error: 'Gagal menjalankan worker login: ' + (err.message || 'Error') }, 500);
  }
});

auth.post('/verify-otp', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { phone, otp, otpToken } = body || {};
  if (!phone || !otp) return c.json({ error: 'Missing parameters' }, 400);

  const cleanPhone = String(phone).replace(/\D/g, '');
  const cleanOtp = String(otp).replace(/\D/g, '');
  if (!cleanPhone || !cleanOtp) {
    return c.json({ error: 'Invalid phone or OTP format' }, 400);
  }

  // Direct API verification if token is from standard OAuth
  if (otpToken && !String(otpToken).startsWith('camoufox_')) {
    try {
      const session = await client.verifyOTP(cleanPhone, cleanOtp, String(otpToken));
      if (session) {
        await manager.saveSession(session);
        return c.json({ success: true, session });
      }
    } catch (err: any) {
      return c.json({ error: err.message || 'Verifikasi OTP gagal' }, 400);
    }
  }

  // Camoufox worker verification
  try {
    fs.writeFileSync(COMMAND_FILE, JSON.stringify({ otp: cleanOtp }), 'utf-8');

    const startTime = Date.now();
    while (Date.now() - startTime < 35000) {
      await new Promise((r) => setTimeout(r, 600));
      if (fs.existsSync(STATE_FILE)) {
        try {
          const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
          if (state.status === 'success') {
            let session = await manager.getSession();
            if (!session && state.session) {
              await manager.saveSession(state.session);
              session = state.session;
            }
            if (session) {
              return c.json({ success: true, session });
            }
          }
          if (state.status === 'error') {
            return c.json({ error: state.message || 'Verifikasi OTP gagal' }, 400);
          }
        } catch {}
      }
    }

    return c.json({ error: 'Batas waktu verifikasi OTP terlampaui' }, 504);
  } catch (err: any) {
    return c.json({ error: 'Gagal memverifikasi OTP: ' + (err.message || 'Error') }, 500);
  }
});

export default auth;

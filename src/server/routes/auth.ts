import { Hono } from 'hono';
import { getSessionManager } from '../../core/session-manager';
import { GoBizClient, formatGoBizPhone } from '../../core/gobiz-client';
import { setInteractiveLoginActive } from '../../core/browser-refresh';
import { checkOtpRequestAllowed, recordOtpRequest } from '../../core/otp-guard';
import { getStorage } from '../../core/storage';
import { SessionData } from '../../core/storage/storage.interface';
import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import os from 'os';

const auth = new Hono();
const storage = getStorage();
const manager = getSessionManager(storage);
const client = new GoBizClient();

const WORKER_SCRIPT = path.join(process.cwd(), 'camoufox_gobiz_worker.py');

let activeWorker: ChildProcess | null = null;
let activeStateFile: string | null = null;
let activeCommandFile: string | null = null;
let pendingDeviceId: string | null = null;

function cleanupIpcFiles() {
  for (const file of [activeStateFile, activeCommandFile]) {
    if (file && fs.existsSync(file)) {
      try {
        fs.unlinkSync(file);
      } catch {}
    }
  }
  activeStateFile = null;
  activeCommandFile = null;
}

function terminateActiveWorker() {
  if (activeWorker) {
    const proc = activeWorker;
    activeWorker = null;
    try {
      proc.kill('SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        if (!proc.killed) proc.kill('SIGKILL');
      } catch {}
    }, 500).unref?.();
  }
  setInteractiveLoginActive(false);
  cleanupIpcFiles();
}

export function sanitizeSession(session: SessionData | null) {
  if (!session) return null;
  return {
    phone_number: session.phone_number,
    outlet_name: session.outlet_name,
    owner_name: session.owner_name,
    merchant_id: session.merchant_id,
    outlet_address: session.outlet_address,
    kyc_status: session.kyc_status,
    features: session.features,
    expires_at: session.expires_at,
    updated_at: session.updated_at,
  };
}

auth.get('/status', async (c) => {
  let session = await manager.refreshIfNeeded();
  if (!session) {
    session = await manager.getSession();
  }
  const isHardExpired = manager.isHardExpired(session);
  const connected = !!session && !isHardExpired && !manager.needsRelogin;

  if (connected && session) {
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

  const health = await manager.getAuthHealth();

  return c.json({
    connected,
    needs_relogin: manager.needsRelogin,
    session: sanitizeSession(session),
    health,
  });
});

auth.post('/refresh', async (c) => {
  const existing = await manager.getSession();
  if (!existing) {
    return c.json({ error: 'Belum ada sesi GoBiz tersimpan. Silakan login terlebih dahulu.' }, 404);
  }

  const refreshed = await manager.refreshIfNeeded(true);
  const health = await manager.getAuthHealth();

  if (manager.needsRelogin) {
    return c.json(
      {
        error: 'Token sesi sudah tidak valid atau dicabut oleh GoBiz. Silakan login ulang via OTP.',
        code: 'RELOGIN_REQUIRED',
        health,
      },
      401
    );
  }

  const now = Date.now();
  if (health.rate_limited_until && health.rate_limited_until > now && !refreshed) {
    const retryAfterSeconds = Math.max(1, Math.ceil((health.rate_limited_until - now) / 1000));
    return c.json(
      {
        error: `Pembaruan token sedang dalam jeda anti-ban (${retryAfterSeconds} detik lagi).`,
        code: 'RATE_LIMITED',
        retryAfterSeconds,
        health,
      },
      429
    );
  }

  if (health.backoff_until && health.backoff_until > now && (!refreshed || manager.isHardExpired(refreshed))) {
    const retryAfterSeconds = Math.max(1, Math.ceil((health.backoff_until - now) / 1000));
    return c.json(
      {
        error: `Pembaruan token tertunda sementara, coba lagi dalam ${retryAfterSeconds} detik.`,
        code: 'BACKOFF_ACTIVE',
        retryAfterSeconds,
        health,
      },
      503
    );
  }

  const activeSession = refreshed || existing;
  return c.json({
    success: true,
    session: sanitizeSession(activeSession),
    health,
  });
});

auth.post('/refresh-profile', async (c) => {
  const session = (await manager.refreshIfNeeded()) || (await manager.getSession());
  if (!session || manager.isHardExpired(session) || manager.needsRelogin) {
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
      session: sanitizeSession(session),
    });
  } catch (err: any) {
    return c.json({ error: 'Gagal menyinkronkan profil: ' + (err.message || 'Error') }, 500);
  }
});

auth.post('/logout', async (c) => {
  terminateActiveWorker();
  pendingDeviceId = null;
  await manager.clearSession();
  const legacySessionFile = path.join(process.cwd(), '.kaigobiz-session.json');
  if (fs.existsSync(legacySessionFile)) {
    try {
      fs.unlinkSync(legacySessionFile);
    } catch {}
  }
  return c.json({
    success: true,
    message: 'Sesi GoBiz berhasil diputuskan.',
  });
});

let verifyFailCount = 0;
let verifyWindowStart = 0;

auth.post('/request-otp', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { phone, force } = body || {};
  if (!phone) return c.json({ error: 'Phone number is required' }, 400);

  const cleanPhone = String(phone).replace(/\D/g, '');
  if (!cleanPhone || cleanPhone.length < 8 || cleanPhone.length > 15) {
    return c.json({ error: 'Invalid phone number format' }, 400);
  }

  const cleanNormalized = formatGoBizPhone(cleanPhone);
  const existingSession = await manager.getSession();
  const existingNormalized = formatGoBizPhone(existingSession?.phone_number || '');

  if (
    existingSession &&
    existingNormalized &&
    cleanNormalized &&
    existingNormalized === cleanNormalized &&
    !manager.isHardExpired(existingSession) &&
    !manager.needsRelogin &&
    !force
  ) {
    return c.json(
      {
        error:
          'Sesi GoBiz untuk nomor ini masih aktif. Gunakan tombol Perbarui Token untuk memperpanjang sesi tanpa OTP, atau kirim force: true jika benar-benar ingin login ulang.',
        code: 'SESSION_ALREADY_ACTIVE',
      },
      409
    );
  }

  const otpCheck = await checkOtpRequestAllowed(storage, cleanPhone);
  if (!otpCheck.allowed) {
    return c.json(
      {
        error: otpCheck.reason,
        code: 'OTP_RATE_LIMITED',
        retryAfterSeconds: otpCheck.retryAfterSeconds,
        scope: otpCheck.scope,
      },
      429
    );
  }

  const deviceId =
    existingNormalized === cleanNormalized && existingSession?.device_id
      ? existingSession.device_id
      : crypto.randomUUID();

  if (process.env.KAIGOBIZ_LOGIN_MODE !== 'browser') {
    try {
      const result = await client.requestOTP(cleanPhone, deviceId);
      if (result && result.otpToken) {
        await recordOtpRequest(storage, cleanPhone);
        pendingDeviceId = result.deviceId;
        return c.json({ success: true, ...result });
      }
    } catch (err: any) {
      if (err?.isRateLimited || err?.status === 429) {
        await recordOtpRequest(storage, cleanPhone);
        await manager.recordApiRateLimit(err);
        const retryAfterSeconds = err.retryAfterMs ? Math.ceil(err.retryAfterMs / 1000) : 300;
        return c.json(
          {
            error:
              'GoBiz membatasi permintaan OTP sementara (HTTP 429). Tunggu beberapa saat agar nomor tidak terblokir.',
            code: 'GOBIZ_OTP_RATE_LIMITED',
            retryAfterSeconds,
          },
          429
        );
      }

      if (err?.status === 400 || err?.status === 422) {
        const msg =
          err?.response?.data?.errors?.[0]?.message ||
          err?.response?.data?.message ||
          'Permintaan OTP ditolak oleh GoBiz';
        return c.json({ error: msg }, 400);
      }
    }
  }

  // Fallback to Camoufox worker managed via ChildProcess handle
  try {
    terminateActiveWorker();
    setInteractiveLoginActive(true);

    const profileDir = path.join(process.cwd(), '.camoufox-profile');
    for (const lockFile of ['.parentlock', 'lock']) {
      const lockPath = path.join(profileDir, lockFile);
      if (fs.existsSync(lockPath)) {
        try {
          fs.unlinkSync(lockPath);
        } catch {}
      }
    }

    const nonce = crypto.randomUUID();
    const stateFile = path.join(os.tmpdir(), `kaigobiz_worker_state_${nonce}.json`);
    const commandFile = path.join(os.tmpdir(), `kaigobiz_worker_cmd_${nonce}.json`);
    activeStateFile = stateFile;
    activeCommandFile = commandFile;

    const worker = spawn(
      'python3',
      [WORKER_SCRIPT, cleanPhone, '--state-file', stateFile, '--command-file', commandFile],
      {
        stdio: 'ignore',
      }
    );
    activeWorker = worker;
    worker.on('exit', () => {
      if (activeWorker === worker) {
        activeWorker = null;
        setInteractiveLoginActive(false);
      }
    });

    const startTime = Date.now();
    while (Date.now() - startTime < 30000) {
      await new Promise((r) => setTimeout(r, 600));
      if (fs.existsSync(stateFile)) {
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (state.status === 'already_authenticated' && state.session?.access_token) {
            const restored: SessionData = {
              ...(existingNormalized === cleanNormalized && existingSession ? existingSession : {}),
              ...state.session,
              updated_at: new Date().toISOString(),
            };
            await manager.saveSession(restored);
            terminateActiveWorker();
            return c.json({
              success: true,
              alreadyAuthenticated: true,
              session: sanitizeSession(restored),
              message: 'Sesi GoBiz berhasil dipulihkan dari profil browser tanpa perlu OTP.',
            });
          }
          if (state.status === 'otp_sent') {
            await recordOtpRequest(storage, cleanPhone);
            return c.json({
              success: true,
              otpToken: 'camoufox_worker_' + nonce,
              message: 'Kode OTP telah dikirimkan ke nomor ' + cleanPhone,
            });
          }
          if (state.status === 'error') {
            terminateActiveWorker();
            return c.json({ error: state.message || 'Gagal mengirimkan kode OTP' }, 400);
          }
        } catch {}
      }
      if (!activeWorker) {
        break;
      }
    }

    terminateActiveWorker();
    return c.json({ error: 'Batas waktu meminta OTP terlampaui (timeout)' }, 504);
  } catch (err: any) {
    terminateActiveWorker();
    return c.json({ error: 'Gagal menjalankan worker login: ' + (err.message || 'Error') }, 500);
  }
});

auth.post('/verify-otp', async (c) => {
  const now = Date.now();
  if (now - verifyWindowStart > 60_000) {
    verifyWindowStart = now;
    verifyFailCount = 0;
  }
  if (verifyFailCount >= 5) {
    return c.json({ error: 'Terlalu banyak percobaan verifikasi OTP. Tunggu 1 menit sebelum mencoba kembali.' }, 429);
  }

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
  if (!cleanPhone || !cleanOtp || cleanOtp.length < 4 || cleanOtp.length > 6) {
    return c.json({ error: 'Invalid phone or OTP format' }, 400);
  }

  if (otpToken && !String(otpToken).startsWith('camoufox_')) {
    try {
      const session = await client.verifyOTP(cleanPhone, cleanOtp, String(otpToken), pendingDeviceId || undefined);
      if (session) {
        verifyFailCount = 0;
        pendingDeviceId = null;
        await manager.saveSession(session);
        return c.json({ success: true, session: sanitizeSession(session) });
      }
    } catch (err: any) {
      verifyFailCount++;
      return c.json({ error: err.message || 'Verifikasi OTP gagal' }, 400);
    }
  }

  if (!activeWorker || !activeStateFile || !activeCommandFile) {
    verifyFailCount++;
    return c.json({ error: 'Sesi permintaan OTP tidak ditemukan atau sudah kedaluwarsa. Silakan minta ulang OTP.' }, 400);
  }

  const stateFile = activeStateFile;
  const commandFile = activeCommandFile;

  try {
    const tmpCmd = `${commandFile}.tmp`;
    fs.writeFileSync(tmpCmd, JSON.stringify({ otp: cleanOtp }), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpCmd, commandFile);

    const startTime = Date.now();
    while (Date.now() - startTime < 35000) {
      await new Promise((r) => setTimeout(r, 600));
      if (fs.existsSync(stateFile)) {
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (state.status === 'success') {
            verifyFailCount = 0;
            if (state.session) {
              try {
                const profile = await client.fetchUserProfile(state.session);
                if (profile) {
                  state.session.merchant_id = profile.merchant_id || state.session.merchant_id;
                  state.session.outlet_name = profile.outlet_name || state.session.outlet_name;
                  state.session.owner_name = profile.owner_name || state.session.owner_name;
                  state.session.phone_number = profile.phone_number || state.session.phone_number;
                  state.session.outlet_address = profile.outlet_address || state.session.outlet_address;
                  state.session.kyc_status = profile.kyc_status || state.session.kyc_status;
                  state.session.features = profile.features || state.session.features;
                }
              } catch {}
              await manager.saveSession(state.session);
              const safeSession = sanitizeSession(state.session);
              terminateActiveWorker();
              return c.json({ success: true, session: safeSession });
            }
            const session = await manager.getSession();
            terminateActiveWorker();
            if (session) {
              return c.json({ success: true, session: sanitizeSession(session) });
            }
          }
          if (state.status === 'error') {
            verifyFailCount++;
            const msg = state.message || 'Verifikasi OTP gagal';
            terminateActiveWorker();
            return c.json({ error: msg }, 400);
          }
        } catch {}
      }
    }

    terminateActiveWorker();
    return c.json({ error: 'Batas waktu verifikasi OTP terlampaui' }, 504);
  } catch (err: any) {
    verifyFailCount++;
    terminateActiveWorker();
    return c.json({ error: 'Gagal memverifikasi OTP: ' + (err.message || 'Error') }, 500);
  }
});

export default auth;

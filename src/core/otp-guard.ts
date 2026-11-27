import { formatGoBizPhone } from './gobiz-client';
import { StorageAdapter } from './storage/storage.interface';

export interface OtpGuardOptions {
  cooldownMs?: number;
  maxPerHour?: number;
  maxPerDay?: number;
}

export interface OtpCheckResult {
  allowed: boolean;
  retryAfterSeconds?: number;
  reason?: string;
  scope?: 'cooldown' | 'hourly' | 'daily';
}

const OTP_HISTORY_CONFIG_KEY = 'otpRequestHistory';
const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function resolveLimits(options?: OtpGuardOptions) {
  return {
    cooldownMs:
      options?.cooldownMs ?? (process.env.NODE_ENV === 'test' ? 1000 : 60_000),
    maxPerHour: options?.maxPerHour ?? 3,
    maxPerDay: options?.maxPerDay ?? 5,
  };
}

function normalizePhoneKey(phone: string): string {
  const formatted = formatGoBizPhone(phone);
  return formatted || String(phone || '').replace(/\D/g, '') || 'unknown';
}

async function readOtpHistory(storage: StorageAdapter): Promise<Record<string, number[]>> {
  if (!storage.getConfig) return {};
  try {
    const cfg = await storage.getConfig();
    const raw = cfg?.[OTP_HISTORY_CONFIG_KEY];
    if (!raw) return {};
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed;
  } catch {
    return {};
  }
}

async function writeOtpHistory(storage: StorageAdapter, history: Record<string, number[]>): Promise<void> {
  if (!storage.setConfig) return;
  try {
    await storage.setConfig({ [OTP_HISTORY_CONFIG_KEY]: JSON.stringify(history) });
  } catch {}
}

function pruneTimestamps(list: unknown, now: number): number[] {
  if (!Array.isArray(list)) return [];
  const cutoff = now - ONE_DAY_MS;
  return list
    .map((n) => Number(n))
    .filter((n) => Number.isFinite(n) && n > cutoff && n <= now + 60_000)
    .sort((a, b) => a - b);
}

export async function checkOtpRequestAllowed(
  storage: StorageAdapter,
  phone: string,
  now: number = Date.now(),
  options?: OtpGuardOptions
): Promise<OtpCheckResult> {
  const limits = resolveLimits(options);
  const key = normalizePhoneKey(phone);
  const history = await readOtpHistory(storage);
  const timestamps = pruneTimestamps(history[key], now);

  if (timestamps.length > 0) {
    const lastTs = timestamps[timestamps.length - 1];
    const elapsed = now - lastTs;
    if (elapsed < limits.cooldownMs) {
      const retryAfterSeconds = Math.max(1, Math.ceil((limits.cooldownMs - elapsed) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        scope: 'cooldown',
        reason: `Harap tunggu ${retryAfterSeconds} detik sebelum meminta kode OTP kembali (anti-ban protection).`,
      };
    }
  }

  const lastHour = timestamps.filter((ts) => now - ts < ONE_HOUR_MS);
  if (lastHour.length >= limits.maxPerHour) {
    const oldestInHour = lastHour[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInHour + ONE_HOUR_MS - now) / 1000));
    const mins = Math.max(1, Math.ceil(retryAfterSeconds / 60));
    return {
      allowed: false,
      retryAfterSeconds,
      scope: 'hourly',
      reason: `Batas aman OTP tercapai (${limits.maxPerHour}x per jam) untuk mencegah pemblokiran nomor GoBiz. Coba lagi dalam ${mins} menit.`,
    };
  }

  if (timestamps.length >= limits.maxPerDay) {
    const oldestInDay = timestamps[0];
    const retryAfterSeconds = Math.max(1, Math.ceil((oldestInDay + ONE_DAY_MS - now) / 1000));
    const hours = Math.max(1, Math.ceil(retryAfterSeconds / 3600));
    return {
      allowed: false,
      retryAfterSeconds,
      scope: 'daily',
      reason: `Batas harian aman OTP tercapai (${limits.maxPerDay}x per 24 jam) untuk melindungi nomor dari ban GoBiz. Coba lagi dalam ${hours} jam.`,
    };
  }

  return { allowed: true };
}

export async function recordOtpRequest(
  storage: StorageAdapter,
  phone: string,
  now: number = Date.now()
): Promise<void> {
  const key = normalizePhoneKey(phone);
  const history = await readOtpHistory(storage);
  const updated: Record<string, number[]> = {};

  for (const [k, v] of Object.entries(history)) {
    const pruned = pruneTimestamps(v, now);
    if (pruned.length > 0) {
      updated[k] = pruned;
    }
  }

  const phoneList = updated[key] ? [...updated[key]] : [];
  phoneList.push(now);
  updated[key] = phoneList.slice(-20);

  await writeOtpHistory(storage, updated);
}

export async function getOtpCooldownRemaining(
  storage: StorageAdapter,
  phone?: string | null,
  now: number = Date.now(),
  options?: OtpGuardOptions
): Promise<number> {
  if (!phone) return 0;
  const check = await checkOtpRequestAllowed(storage, phone, now, options);
  return check.allowed ? 0 : check.retryAfterSeconds || 0;
}

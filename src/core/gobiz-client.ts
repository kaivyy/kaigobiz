import axios from 'axios';
import crypto from 'crypto';
import { SessionData, TransactionData } from './storage/storage.interface';

const PERMANENT_ERROR_CODES = new Set([
  'goid:error:unauthorized',
  'goid:error:token_expired',
  'goid:error:invalid_token',
  'goid:error:revoked_token',
  'invalid_grant',
]);

export interface BrowserFingerprint {
  ua: string;
  make: string;
  model: string;
  deviceId: string;
  appVersion: string;
}

export interface FetchTransactionsOptions {
  maxPages?: number;
  stopBeforeTimestamp?: number;
}

export function formatGoBizPhone(phone: string): string {
  return String(phone || '')
    .replace(/\D/g, '')
    .replace(/^(?:62|0)+/, '');
}

export function parseJwtTimestamps(token: string): { iat?: number; exp?: number } | null {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padLen = (4 - (normalized.length % 4)) % 4;
    const decoded = Buffer.from(normalized + '='.repeat(padLen), 'base64').toString('utf8');
    const payload = JSON.parse(decoded);
    if (!payload || typeof payload !== 'object') return null;

    const iat = typeof payload.iat === 'number' && Number.isFinite(payload.iat) ? payload.iat : undefined;
    const exp = typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined;
    if (iat === undefined && exp === undefined) return null;
    return { iat, exp };
  } catch {
    return null;
  }
}

export function computeTokenExpiry(
  accessToken: string,
  expiresInSeconds?: number | null,
  nowMs: number = Date.now()
): { expiresAt: string; ttlSeconds: number } {
  const jwt = parseJwtTimestamps(accessToken);
  if (jwt?.exp !== undefined && Number.isFinite(jwt.exp) && jwt.exp * 1000 > nowMs - 60_000) {
    const rawTtl =
      jwt.iat !== undefined && jwt.exp > jwt.iat
        ? jwt.exp - jwt.iat
        : Math.round((jwt.exp * 1000 - nowMs) / 1000);
    return {
      expiresAt: new Date(jwt.exp * 1000).toISOString(),
      ttlSeconds: Math.max(60, Math.round(rawTtl)),
    };
  }

  if (typeof expiresInSeconds === 'number' && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0) {
    const ttlSeconds = Math.max(60, Math.round(expiresInSeconds));
    return {
      expiresAt: new Date(nowMs + ttlSeconds * 1000).toISOString(),
      ttlSeconds,
    };
  }

  return {
    expiresAt: new Date(nowMs + 86400 * 1000).toISOString(),
    ttlSeconds: 86400,
  };
}

export function mergeCookieHeader(
  existingCookie: string | null | undefined,
  setCookieHeaders: string | string[] | undefined,
  tokens?: { accessToken?: string | null; refreshToken?: string | null }
): { cookie: string; accessToken?: string; refreshToken?: string } {
  const cookieMap = new Map<string, string>();

  if (existingCookie && typeof existingCookie === 'string') {
    for (const part of existingCookie.split(';')) {
      const trimmed = part.trim();
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const name = trimmed.slice(0, eq).trim();
        const value = trimmed.slice(eq + 1).trim();
        if (name) {
          cookieMap.set(name, value);
        }
      }
    }
  }

  let extractedAccess = cookieMap.get('access_token') || undefined;
  let extractedRefresh = cookieMap.get('refresh_token') || undefined;

  const setList = Array.isArray(setCookieHeaders)
    ? setCookieHeaders
    : typeof setCookieHeaders === 'string'
      ? [setCookieHeaders]
      : [];

  for (const rawHeader of setList) {
    if (!rawHeader || typeof rawHeader !== 'string') continue;
    const firstSegment = rawHeader.split(';')[0]?.trim() || '';
    const eq = firstSegment.indexOf('=');
    if (eq > 0) {
      const name = firstSegment.slice(0, eq).trim();
      const value = firstSegment.slice(eq + 1).trim();
      if (name) {
        cookieMap.set(name, value);
        if (name === 'access_token' && value) extractedAccess = value;
        if (name === 'refresh_token' && value) extractedRefresh = value;
      }
    }
  }

  if (tokens?.accessToken) {
    cookieMap.set('access_token', tokens.accessToken);
  }
  if (tokens?.refreshToken) {
    cookieMap.set('refresh_token', tokens.refreshToken);
  }
  if (!cookieMap.has('auth_method')) {
    cookieMap.set('auth_method', 'goid');
  }

  const serialized = Array.from(cookieMap.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  return {
    cookie: serialized,
    accessToken: extractedAccess,
    refreshToken: extractedRefresh,
  };
}

export function parseRetryAfterMs(headerVal: unknown, nowMs: number = Date.now()): number | undefined {
  const raw = Array.isArray(headerVal) ? headerVal[0] : headerVal;
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const ms = Math.round(Number(trimmed) * 1000);
    return Math.min(3600_000, Math.max(1000, ms));
  }

  const targetMs = Date.parse(trimmed);
  if (Number.isFinite(targetMs) && targetMs > nowMs) {
    return Math.min(3600_000, Math.max(1000, targetMs - nowMs));
  }

  return undefined;
}

function deterministicUuidFromSeed(seed: string): string {
  const hash = crypto.createHash('sha256').update(seed).digest();
  hash[6] = (hash[6] & 0x0f) | 0x40;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function extractAxiosErrorInfo(axiosErr: any) {
  const status: number | undefined = axiosErr?.response?.status ?? axiosErr?.status;
  const rawData = axiosErr?.response?.data;
  const errorCode: string = rawData?.errors?.[0]?.code || rawData?.error || '';
  const retryAfterMs = parseRetryAfterMs(axiosErr?.response?.headers?.['retry-after']);
  return { status, errorCode, retryAfterMs };
}

export class GoBizClient {
  private static REQUEST_OTP_URL = 'https://api.gobiz.co.id/goid/login/request';
  private static VERIFY_OTP_URL = 'https://api.gobiz.co.id/goid/token';
  private static USER_CONFIG_URL = 'https://api.gobiz.co.id/goresto/v5/public/users/config';
  private static TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';
  private static CLIENT_ID = 'go-biz-web-new';
  private static DEFAULT_APP_VERSION = process.env.GOBIZ_APP_VERSION || 'platform-v3.131.0-93e290ae';

  private static readonly UA_POOL = [
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      make: 'Windows 10 64-bit',
      model: 'Chrome 133.0.0.0 on Windows 10 64-bit',
    },
    {
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
      make: 'Windows 10 64-bit',
      model: 'Chrome 134.0.0.0 on Windows 10 64-bit',
    },
    {
      ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
      make: 'macOS Ventura',
      model: 'Chrome 133.0.0.0 on macOS',
    },
  ];

  // Bind one stable browser fingerprint and x-uniqueid per session so OS/UA never jumps mid-session
  static resolveFingerprint(session?: Partial<SessionData> | null): BrowserFingerprint {
    const seed = (session?.device_id && session.device_id.trim()) || formatGoBizPhone(session?.phone_number || '') || 'default';
    const digest = crypto.createHash('sha256').update(seed).digest();
    const fallbackFp = GoBizClient.UA_POOL[digest.readUInt32BE(0) % GoBizClient.UA_POOL.length];
    const deviceId =
      session?.device_id && session.device_id.trim()
        ? session.device_id.trim()
        : deterministicUuidFromSeed(seed);

    return {
      ua: session?.user_agent?.trim() || fallbackFp.ua,
      make: session?.phone_make?.trim() || fallbackFp.make,
      model: session?.phone_model?.trim() || fallbackFp.model,
      deviceId,
      appVersion: session?.app_version?.trim() || GoBizClient.DEFAULT_APP_VERSION,
    };
  }

  static getHeaders(
    session?: Partial<SessionData> | null,
    options?: { includeAuth?: boolean; deviceId?: string }
  ) {
    const fp = GoBizClient.resolveFingerprint(session);
    const deviceId = options?.deviceId || fp.deviceId;
    const headers: Record<string, string> = {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'id',
      'content-type': 'application/json',
      origin: 'https://portal.gofoodmerchant.co.id',
      referer: 'https://portal.gofoodmerchant.co.id/',
      'user-agent': fp.ua,
      'gojek-country-code': 'ID',
      'gojek-timezone': 'Asia/Jakarta',
      'x-appid': 'go-biz-web-dashboard',
      'x-appversion': fp.appVersion,
      'x-deviceos': 'Web',
      'x-phonemake': fp.make,
      'x-phonemodel': fp.model,
      'x-platform': 'Web',
      'x-uniqueid': deviceId,
      'x-user-locale': 'id-ID',
      'x-user-type': 'merchant',
    };

    if (session) {
      headers['authentication-type'] = 'go-id';
      if (options?.includeAuth !== false && session.access_token) {
        headers['authorization'] = `Bearer ${session.access_token}`;
      }
      if (session.cookie || session.access_token || session.refresh_token) {
        headers['cookie'] =
          session.cookie ||
          mergeCookieHeader(undefined, undefined, {
            accessToken: session.access_token,
            refreshToken: session.refresh_token,
          }).cookie;
      }
    }

    return headers;
  }

  async requestOTP(
    phone: string,
    deviceId?: string
  ): Promise<{ otpToken: string; expiry: number; otpLength?: number; channel?: string; deviceId: string }> {
    const formattedPhone = formatGoBizPhone(phone);
    const activeDeviceId = deviceId || deterministicUuidFromSeed(formattedPhone || crypto.randomUUID());

    try {
      const res = await axios.post(
        GoBizClient.REQUEST_OTP_URL,
        { client_id: GoBizClient.CLIENT_ID, phone_number: formattedPhone, country_code: '62' },
        { headers: GoBizClient.getHeaders({ phone_number: formattedPhone, device_id: activeDeviceId }), timeout: 15000 }
      );
      const data = res.data?.data || res.data;
      return {
        otpToken: data.otp_token || data.token || '',
        expiry: data.expiry || 720,
        otpLength: data.otp_length || 4,
        channel: data.channel || data.otp_channels?.[0]?.channel || 'SMS',
        deviceId: activeDeviceId,
      };
    } catch (axiosErr: any) {
      const { status, errorCode, retryAfterMs } = extractAxiosErrorInfo(axiosErr);
      if (status) axiosErr.status = status;
      if (errorCode) axiosErr.errorCode = errorCode;
      if (retryAfterMs) axiosErr.retryAfterMs = retryAfterMs;
      axiosErr.isRateLimited = status === 429;
      throw axiosErr;
    }
  }

  async verifyOTP(phone: string, otp: string, otpToken: string, deviceId?: string): Promise<SessionData> {
    const formattedPhone = formatGoBizPhone(phone);
    const activeDeviceId = deviceId || deterministicUuidFromSeed(formattedPhone || crypto.randomUUID());
    const fp = GoBizClient.resolveFingerprint({ phone_number: formattedPhone, device_id: activeDeviceId });

    let res;
    try {
      res = await axios.post(
        GoBizClient.VERIFY_OTP_URL,
        {
          client_id: GoBizClient.CLIENT_ID,
          grant_type: 'otp',
          data: { otp, otp_token: otpToken },
        },
        { headers: GoBizClient.getHeaders({ phone_number: formattedPhone, device_id: activeDeviceId }), timeout: 15000 }
      );
    } catch (axiosErr: any) {
      const { status, errorCode, retryAfterMs } = extractAxiosErrorInfo(axiosErr);
      if (status) axiosErr.status = status;
      if (errorCode) axiosErr.errorCode = errorCode;
      if (retryAfterMs) axiosErr.retryAfterMs = retryAfterMs;
      axiosErr.isRateLimited = status === 429;
      throw axiosErr;
    }

    const data = res.data?.data || res.data || {};
    const cookieInfo = mergeCookieHeader(undefined, res.headers?.['set-cookie']);
    const accessToken = data.access_token || cookieInfo.accessToken || '';
    const refreshToken = data.refresh_token || cookieInfo.refreshToken || '';
    const finalCookie = mergeCookieHeader(cookieInfo.cookie, undefined, {
      accessToken,
      refreshToken,
    }).cookie;

    let merchantId = null;
    let outletName = null;
    let ownerName = null;
    let outletAddress = null;
    let kycStatus = null;
    let features = null;

    try {
      const profile = await this.fetchUserProfile({
        phone_number: formattedPhone,
        access_token: accessToken,
        refresh_token: refreshToken,
        cookie: finalCookie,
        device_id: fp.deviceId,
        user_agent: fp.ua,
        phone_make: fp.make,
        phone_model: fp.model,
        app_version: fp.appVersion,
      });
      if (profile) {
        merchantId = profile.merchant_id || null;
        outletName = profile.outlet_name || null;
        ownerName = profile.owner_name || null;
        outletAddress = profile.outlet_address || null;
        kycStatus = profile.kyc_status || null;
        features = profile.features || null;
      }
    } catch {}

    const { expiresAt, ttlSeconds } = computeTokenExpiry(accessToken, Number(data.expires_in) || undefined);

    return {
      phone_number: formattedPhone,
      merchant_id: merchantId,
      outlet_name: outletName,
      owner_name: ownerName,
      outlet_address: outletAddress,
      kyc_status: kycStatus,
      features,
      access_token: accessToken,
      refresh_token: refreshToken,
      cookie: finalCookie,
      device_id: fp.deviceId,
      user_agent: fp.ua,
      phone_make: fp.make,
      phone_model: fp.model,
      app_version: fp.appVersion,
      token_ttl_seconds: ttlSeconds,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
  }

  async refreshToken(session: SessionData): Promise<SessionData> {
    if (!session.refresh_token || !session.refresh_token.trim()) {
      const err: any = new Error('NO_REFRESH_TOKEN');
      err.isPermanent = true;
      err.isAuthFailure = true;
      throw err;
    }

    if (process.env.NODE_ENV !== 'test') {
      await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 650)));
    }

    const fp = GoBizClient.resolveFingerprint(session);
    const cleanPhone = formatGoBizPhone(session.phone_number || '');
    const headers = GoBizClient.getHeaders(session, { includeAuth: false, deviceId: fp.deviceId });

    const flatPayload = {
      client_id: GoBizClient.CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: session.refresh_token,
    };
    const nestedPayload = {
      client_id: GoBizClient.CLIENT_ID,
      grant_type: 'refresh_token',
      data: {
        refresh_token: session.refresh_token,
        phone_number: cleanPhone,
        country_code: '62',
      },
    };

    const sendRefresh = (payload: Record<string, any>) =>
      axios.post(GoBizClient.VERIFY_OTP_URL, payload, { headers, timeout: 15000 });

    let res;
    try {
      if (cleanPhone) {
        try {
          res = await sendRefresh(nestedPayload);
        } catch (nestedErr: any) {
          const nestedStatus = nestedErr?.response?.status ?? nestedErr?.status;
          // Retry flat schema only on schema rejection (400/422), never on auth/rate-limit errors
          if (nestedStatus === 400 || nestedStatus === 422) {
            if (process.env.NODE_ENV !== 'test') {
              await new Promise((r) => setTimeout(r, 300));
            }
            res = await sendRefresh(flatPayload);
          } else {
            throw nestedErr;
          }
        }
      } else {
        res = await sendRefresh(flatPayload);
      }
    } catch (axiosErr: any) {
      const { status, errorCode, retryAfterMs } = extractAxiosErrorInfo(axiosErr);

      if (status === 401 || (status === 403 && PERMANENT_ERROR_CODES.has(errorCode))) {
        const permanent: any = new Error(`PERMANENT_AUTH_FAILURE: ${errorCode || 'token expired or revoked'}`);
        permanent.isPermanent = true;
        permanent.isAuthFailure = true;
        permanent.canTryBrowserFallback = true;
        permanent.isRateLimited = false;
        permanent.status = status;
        permanent.errorCode = errorCode;
        permanent.retryAfterMs = retryAfterMs;
        throw permanent;
      }

      if (status === 403) {
        const forbidden: any = new Error(`WAF_OR_FORBIDDEN_403: ${errorCode || 'access forbidden'}`);
        forbidden.isRateLimited = true;
        forbidden.canTryBrowserFallback = true;
        forbidden.isPermanent = false;
        forbidden.status = 403;
        forbidden.errorCode = errorCode;
        forbidden.retryAfterMs = retryAfterMs;
        throw forbidden;
      }

      if (status === 429) {
        const rateErr: any = new Error('RATE_LIMITED_429: terlalu banyak permintaan refresh ke GoBiz');
        rateErr.isRateLimited = true;
        rateErr.isPermanent = false;
        rateErr.status = 429;
        rateErr.errorCode = errorCode;
        rateErr.retryAfterMs = retryAfterMs;
        throw rateErr;
      }

      if (status) axiosErr.status = status;
      if (errorCode) axiosErr.errorCode = errorCode;
      if (retryAfterMs) axiosErr.retryAfterMs = retryAfterMs;
      axiosErr.isRateLimited = false;
      throw axiosErr;
    }

    const data = res.data?.data || res.data || {};
    const cookieInfo = mergeCookieHeader(session.cookie, res.headers?.['set-cookie']);
    const newAccessToken = data.access_token || cookieInfo.accessToken || session.access_token;
    const newRefreshToken = data.refresh_token || cookieInfo.refreshToken || session.refresh_token;
    const finalCookie = mergeCookieHeader(cookieInfo.cookie, undefined, {
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
    }).cookie;
    const { expiresAt, ttlSeconds } = computeTokenExpiry(newAccessToken, Number(data.expires_in) || undefined);

    console.log(`[KaiGoBiz Auth] Auto-refresh session berhasil! Masa berlaku hingga ${expiresAt}`);

    return {
      ...session,
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      cookie: finalCookie,
      device_id: fp.deviceId,
      user_agent: fp.ua,
      phone_make: fp.make,
      phone_model: fp.model,
      app_version: fp.appVersion,
      token_ttl_seconds: ttlSeconds,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
  }

  async fetchTransactions(
    session: SessionData,
    hoursBack = 72,
    options?: FetchTransactionsOptions
  ): Promise<TransactionData[]> {
    const now = new Date();
    const startTimeISO = new Date(now.getTime() - hoursBack * 3600 * 1000).toISOString();
    const endTimeISO = now.toISOString();

    const pageSize = 50;
    const maxPages = Math.max(1, Math.min(4, Number(options?.maxPages ?? 4) || 4));
    const stopBeforeTimestamp = options?.stopBeforeTimestamp;
    const allItems: any[] = [];

    for (let page = 0; page < maxPages; page++) {
      if (page > 0 && process.env.NODE_ENV !== 'test') {
        await new Promise((r) => setTimeout(r, 250 + Math.floor(Math.random() * 350)));
      }

      const params: Record<string, any> = {
        from: page * pageSize,
        size: pageSize,
        statuses: 'SETTLEMENT,CAPTURE',
        payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
        start_time: startTimeISO,
        end_time: endTimeISO,
      };

      if (session.merchant_id) {
        params['merchant_ids'] = session.merchant_id;
      }

      let res;
      try {
        res = await axios.get(GoBizClient.TRANSACTIONS_URL, {
          headers: GoBizClient.getHeaders(session),
          params,
          timeout: 10000,
        });
      } catch (axiosErr: any) {
        const { status, errorCode, retryAfterMs } = extractAxiosErrorInfo(axiosErr);
        if (status) axiosErr.status = status;
        if (errorCode) axiosErr.errorCode = errorCode;
        if (retryAfterMs) axiosErr.retryAfterMs = retryAfterMs;
        axiosErr.isRateLimited = status === 429 || (status === 403 && !PERMANENT_ERROR_CODES.has(errorCode));
        throw axiosErr;
      }

      const pageItems = res.data?.data?.transactions || res.data?.transactions || res.data?.data || [];
      if (!Array.isArray(pageItems) || pageItems.length === 0) {
        break;
      }
      allItems.push(...pageItems);
      if (pageItems.length < pageSize) {
        break;
      }

      if (stopBeforeTimestamp !== undefined) {
        const timestamps = pageItems
          .map((tx: any) => Date.parse(tx.transaction_time || tx.settlement_time || tx.created_at || ''))
          .filter((ms: number) => Number.isFinite(ms));
        if (timestamps.length > 0 && Math.min(...timestamps) <= stopBeforeTimestamp) {
          break;
        }
      }
    }

    return allItems.map((tx: any) => {
      const parsedAmount = parseFloat(
        tx.gross_amount ||
        tx.real_gross_amount ||
        tx.amount?.value ||
        tx.amount ||
        tx.total_amount ||
        0
      );
      const rawAmount = Number.isFinite(parsedAmount) ? parsedAmount : 0;
      // Gojek Wallstreet API stores gross_amount in minor currency units (sen / cents, e.g. 100000 sen = Rp 1.000)
      const isWallstreet = tx.wallstreet_transaction_id || tx.channel_type === 'STATIC_QR' || tx.service_type === 'QRIS';
      const amount = isWallstreet && (tx.currency === 'IDR' || !tx.currency)
        ? rawAmount / 100
        : rawAmount;

      const rawStatus = (tx.transaction_status || tx.status || '').toUpperCase();
      let txStatus: 'COMPLETED' | 'PENDING' | 'FAILED' = 'PENDING';
      if (['SUCCESS', 'SETTLEMENT', 'CAPTURE', 'COMPLETED'].includes(rawStatus)) {
        txStatus = 'COMPLETED';
      } else if (['REFUND', 'PARTIAL_REFUND', 'FAILED', 'CANCELLED', 'VOID', 'EXPIRED'].includes(rawStatus)) {
        txStatus = 'FAILED';
      }

      const timestamp = tx.transaction_time || tx.settlement_time || tx.created_at || new Date().toISOString();
      const description = tx.qris_provider_aspi_issuer
        ? `QRIS ${tx.qris_provider_aspi_issuer}`
        : tx.description || tx.payment_type || tx.type || 'GoPay Transaction';
      const upstreamId = tx.id || tx.order_id || tx.transaction_id || tx.wallstreet_transaction_id;
      const id = upstreamId
        ? String(upstreamId)
        : 'tx_' +
          crypto
            .createHash('sha256')
            .update(JSON.stringify([rawAmount, timestamp, description, tx.reference_id || '']))
            .digest('hex')
            .slice(0, 16);

      return {
        id,
        amount,
        description,
        timestamp,
        status: txStatus,
        raw: tx,
      };
    });
  }

  async fetchUserProfile(session: Partial<SessionData>): Promise<{
    phone_number?: string;
    merchant_id?: string;
    outlet_name?: string;
    owner_name?: string;
    outlet_address?: string;
    kyc_status?: string;
    features?: Array<{ product_name: string; product_type: string; status: string }>;
  } | null> {
    if (!session?.access_token) return null;
    try {
      const res = await axios.get(GoBizClient.USER_CONFIG_URL, {
        headers: GoBizClient.getHeaders(session),
        timeout: 12000,
      });
      const data = res.data?.data || res.data || {};
      const userObj = data.user || {};
      const merchantObj = data.merchant || {};
      const featuresRaw = Array.isArray(data.features) ? data.features : [];

      const features = featuresRaw.map((f: any) => ({
        product_name: f.product_name || f.app_feature_name || 'GoPay',
        product_type: f.product_type || 'QRIS',
        status: f.status || 'active',
      }));

      return {
        phone_number: userObj.phone || session.phone_number || undefined,
        owner_name: userObj.full_name || undefined,
        merchant_id: merchantObj.id || undefined,
        outlet_name: merchantObj.outlet_name || merchantObj.name || undefined,
        outlet_address: merchantObj.outlet_address || undefined,
        kyc_status: merchantObj.kyc_status || undefined,
        features,
      };
    } catch {
      return null;
    }
  }
}

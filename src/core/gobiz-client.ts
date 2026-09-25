import axios from 'axios';
import { SessionData, TransactionData } from './storage/storage.interface';

// Permanent failure: server explicitly rejects token (not a transient network error).
// These error codes indicate re-login is needed, not just a retry.
const PERMANENT_ERROR_CODES = new Set([
  'goid:error:unauthorized',
  'goid:error:token_expired',
  'goid:error:invalid_token',
  'goid:error:revoked_token',
]);

export class GoBizClient {
  private static REQUEST_OTP_URL = 'https://api.gobiz.co.id/goid/login/request';
  private static VERIFY_OTP_URL = 'https://api.gobiz.co.id/goid/token';
  private static USER_CONFIG_URL = 'https://api.gobiz.co.id/goresto/v5/public/users/config';
  private static TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';

  // Rotate between realistic browser fingerprints to avoid pattern detection.
  // Each entry matches a real browser + OS combination that GoBiz supports.
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

  private static pickUA() {
    return GoBizClient.UA_POOL[Math.floor(Math.random() * GoBizClient.UA_POOL.length)];
  }

  static getHeaders(session?: SessionData | null) {
    const fp = GoBizClient.UA_POOL[0];
    const headers: Record<string, string> = {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'id',
      'content-type': 'application/json',
      'origin': 'https://portal.gofoodmerchant.co.id',
      'referer': 'https://portal.gofoodmerchant.co.id/',
      'user-agent': fp.ua,
      'gojek-country-code': 'ID',
      'gojek-timezone': 'Asia/Jakarta',
      'x-appid': 'go-biz-web-dashboard',
      'x-appversion': 'platform-v3.125.0-e1923971',
      'x-deviceos': 'Web',
      'x-phonemake': fp.make,
      'x-phonemodel': fp.model,
      'x-platform': 'Web',
      'x-user-locale': 'id-ID',
      'x-user-type': 'merchant',
    };
    if (session?.access_token) {
      headers['authorization'] = `Bearer ${session.access_token}`;
      headers['authentication-type'] = 'go-id';
      headers['cookie'] = session.cookie || `access_token=${session.access_token}; refresh_token=${session.refresh_token}; auth_method=goid`;
    }
    return headers;
  }

  async requestOTP(phone: string): Promise<{ otpToken: string; expiry: number; otpLength?: number; channel?: string }> {
    const formattedPhone = phone.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    const res = await axios.post(
      GoBizClient.REQUEST_OTP_URL,
      { client_id: 'go-biz-web', phone_number: formattedPhone, country_code: '62' },
      { headers: GoBizClient.getHeaders(), timeout: 15000 }
    );
    const data = res.data?.data || res.data;
    return {
      otpToken: data.otp_token || data.token || '',
      expiry: data.expiry || 720,
      otpLength: data.otp_length || 4,
      channel: data.channel || data.otp_channels?.[0]?.channel || 'SMS',
    };
  }

  async verifyOTP(phone: string, otp: string, otpToken: string): Promise<SessionData> {
    const formattedPhone = phone.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    const res = await axios.post(
      GoBizClient.VERIFY_OTP_URL,
      {
        client_id: 'go-biz-web',
        grant_type: 'otp',
        data: { otp, otp_token: otpToken },
      },
      { headers: GoBizClient.getHeaders(), timeout: 15000 }
    );
    const data = res.data?.data || res.data;
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;

    let merchantId = null;
    let outletName = null;
    let ownerName = null;
    let outletAddress = null;
    let kycStatus = null;
    let features = null;

    try {
      const profile = await this.fetchUserProfile({ access_token: accessToken, refresh_token: refreshToken });
      if (profile) {
        merchantId = profile.merchant_id || null;
        outletName = profile.outlet_name || null;
        ownerName = profile.owner_name || null;
        outletAddress = profile.outlet_address || null;
        kycStatus = profile.kyc_status || null;
        features = profile.features || null;
      }
    } catch {}

    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

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
      cookie: `access_token=${accessToken}; refresh_token=${refreshToken}; auth_method=goid`,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
  }

  async refreshToken(session: SessionData): Promise<SessionData> {
    if (!session.refresh_token || !session.refresh_token.trim()) {
      const err = new Error('NO_REFRESH_TOKEN');
      (err as any).isPermanent = true;
      throw err;
    }

    // Random jitter 200-900ms — avoids fixed-interval fingerprinting by GoBiz rate limiter.
    await new Promise((r) => setTimeout(r, 200 + Math.floor(Math.random() * 700)));

    const fp = GoBizClient.pickUA();

    let res;
    try {
      res = await axios.post(
        'https://api.gobiz.co.id/goid/token',
        {
          client_id: 'go-biz-web-new',
          grant_type: 'refresh_token',
          refresh_token: session.refresh_token,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'id',
            'Authentication-Type': 'go-id',
            'Origin': 'https://app.gobiz.co.id',
            'Referer': 'https://app.gobiz.co.id/',
            'X-User-Locale': 'id-ID',
            'X-AppVersion': 'platform-v3.125.0-e1923971',
            'Gojek-Country-Code': 'ID',
            'Gojek-Timezone': 'Asia/Jakarta',
            'X-Platform': 'Web',
            'X-User-Type': 'merchant',
            'x-appId': 'go-biz-web-dashboard',
            'x-DeviceOS': 'Web',
            'x-PhoneMake': fp.make,
            'x-PhoneModel': fp.model,
            'User-Agent': fp.ua,
            'Cookie': session.cookie || `access_token=${session.access_token}; refresh_token=${session.refresh_token}; auth_method=goid`,
          },
          timeout: 15000,
        }
      );
    } catch (axiosErr: any) {
      const status = axiosErr.response?.status;
      const errCode: string = axiosErr.response?.data?.errors?.[0]?.code || '';

      // 401/403 with a known permanent code = token is dead, re-login required.
      // Do NOT retry these — it wastes requests and risks rate-limit / account flag.
      if ((status === 401 || status === 403) && PERMANENT_ERROR_CODES.has(errCode)) {
        const permanent = new Error(`PERMANENT_AUTH_FAILURE: ${errCode}`);
        (permanent as any).isPermanent = true;
        (permanent as any).status = status;
        throw permanent;
      }

      // 401 without a recognised code — GoBiz also returns generic 401 for expired tokens.
      if (status === 401) {
        const permanent = new Error('PERMANENT_AUTH_FAILURE: token expired or revoked');
        (permanent as any).isPermanent = true;
        (permanent as any).status = 401;
        throw permanent;
      }

      // Everything else (5xx, network timeout) = transient, let SessionManager retry later.
      throw axiosErr;
    }

    const data = res.data?.data || res.data;
    const newAccessToken = data.access_token || session.access_token;
    const newRefreshToken = data.refresh_token || session.refresh_token;
    const expirySeconds = Number(data.expires_in) || 86400;
    const expiresAt = new Date(Date.now() + expirySeconds * 1000).toISOString();

    console.log(`[KaiGoBiz Auth] Auto-refresh session berhasil! Masa berlaku hingga ${expiresAt}`);

    return {
      ...session,
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      cookie: `access_token=${newAccessToken}; refresh_token=${newRefreshToken}; auth_method=goid`,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
  }

  async fetchTransactions(session: SessionData, hoursBack = 72): Promise<TransactionData[]> {
    const now = new Date();
    const startTimeISO = new Date(now.getTime() - hoursBack * 3600 * 1000).toISOString();
    const endTimeISO = now.toISOString();

    const params: Record<string, any> = {
      from: 0,
      size: 50,
      statuses: 'SETTLEMENT,CAPTURE,REFUND,PARTIAL_REFUND',
      payment_types: 'QRIS,GOPAY,OFFLINE_CREDIT_CARD,OFFLINE_DEBIT_CARD,CREDIT_CARD',
      start_time: startTimeISO,
      end_time: endTimeISO,
    };

    if (session.merchant_id) {
      params['merchant_ids'] = session.merchant_id;
    }

    const res = await axios.get(GoBizClient.TRANSACTIONS_URL, {
      headers: GoBizClient.getHeaders(session),
      params,
      timeout: 10000,
    });

    const items = res.data?.data?.transactions || res.data?.transactions || res.data?.data || [];
    return items.map((tx: any) => {
      const rawAmount = parseFloat(
        tx.gross_amount ||
        tx.real_gross_amount ||
        tx.amount?.value ||
        tx.amount ||
        tx.total_amount ||
        0
      );
      // Gojek Wallstreet API stores gross_amount in minor currency units (sen / cents, e.g. 100000 sen = Rp 1.000)
      const isWallstreet = tx.wallstreet_transaction_id || tx.channel_type === 'STATIC_QR' || tx.service_type === 'QRIS';
      const amount = isWallstreet && (tx.currency === 'IDR' || !tx.currency)
        ? rawAmount / 100
        : rawAmount;

      const rawStatus = (tx.transaction_status || tx.status || '').toUpperCase();
      const isCompleted = ['SUCCESS', 'SETTLEMENT', 'CAPTURE', 'COMPLETED'].includes(rawStatus);
      const timestamp = tx.transaction_time || tx.settlement_time || tx.created_at || new Date().toISOString();
      const description = tx.qris_provider_aspi_issuer
        ? `QRIS ${tx.qris_provider_aspi_issuer}`
        : tx.description || tx.payment_type || tx.type || 'GoPay Transaction';
      const id = tx.id || tx.order_id || tx.transaction_id || tx.wallstreet_transaction_id || `tx_${Date.now()}`;

      return {
        id: String(id),
        amount,
        description,
        timestamp,
        status: isCompleted ? ('COMPLETED' as const) : ('PENDING' as const),
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
        headers: GoBizClient.getHeaders(session as SessionData),
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

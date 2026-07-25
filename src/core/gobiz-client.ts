import axios from 'axios';
import { SessionData, TransactionData } from './storage/storage.interface';

export class GoBizClient {
  private static REQUEST_OTP_URL = 'https://api.gobiz.co.id/goid/login/request';
  private static VERIFY_OTP_URL = 'https://api.gobiz.co.id/goid/token';
  private static USER_CONFIG_URL = 'https://api.gobiz.co.id/goresto/v5/public/users/config';
  private static TRANSACTIONS_URL = 'https://api.gojekapi.com/merchant-analytics/v2/merchants/transactions';

  static getHeaders(session?: SessionData | null) {
    const headers: Record<string, string> = {
      'accept': 'application/json',
      'accept-language': 'id',
      'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'x-appid': 'go-biz-web',
      'x-appversion': '3.111.0',
      'x-platform': 'Web',
    };
    if (session?.access_token) {
      headers['authorization'] = `Bearer ${session.access_token}`;
    }
    return headers;
  }

  async requestOTP(phone: string): Promise<{ otpToken: string; expiry: number }> {
    const formattedPhone = phone.replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    const res = await axios.post(
      GoBizClient.REQUEST_OTP_URL,
      { client_id: 'go-biz-web', phone_number: formattedPhone, country_code: '62' },
      { headers: GoBizClient.getHeaders() }
    );
    const data = res.data?.data || res.data;
    return {
      otpToken: data.otp_token || data.token || '',
      expiry: data.expiry || 720,
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
      { headers: GoBizClient.getHeaders() }
    );
    const data = res.data?.data || res.data;
    const accessToken = data.access_token;
    const refreshToken = data.refresh_token;

    // Fetch user config
    let merchantId = null;
    let outletName = null;
    try {
      const configRes = await axios.get(GoBizClient.USER_CONFIG_URL, {
        headers: GoBizClient.getHeaders({ access_token: accessToken, refresh_token: refreshToken }),
      });
      const configData = configRes.data?.data || {};
      merchantId = configData.merchant?.id || null;
      outletName = configData.merchant?.name || null;
    } catch {}

    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    return {
      phone_number: formattedPhone,
      merchant_id: merchantId,
      outlet_name: outletName,
      access_token: accessToken,
      refresh_token: refreshToken,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
  }

  async refreshToken(session: SessionData): Promise<SessionData> {
    const formattedPhone = (session.phone_number || '').replace(/\D/g, '').replace(/^62/, '').replace(/^0/, '');
    const res = await axios.post(
      GoBizClient.VERIFY_OTP_URL,
      {
        grant_type: 'refresh_token',
        client_id: 'go-biz-web',
        data: {
          client_id: 'go-biz-web',
          phone_number: formattedPhone,
          country_code: '62',
        },
      },
      {
        headers: {
          ...GoBizClient.getHeaders(session),
          'authentication-type': 'refresh_token',
        },
      }
    );

    const data = res.data?.data || res.data;
    const newAccessToken = data.access_token || session.access_token;
    const newRefreshToken = data.refresh_token || session.refresh_token;
    const expiresAt = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

    return {
      ...session,
      access_token: newAccessToken,
      refresh_token: newRefreshToken,
      updated_at: new Date().toISOString(),
      expires_at: expiresAt,
    };
  }

  async fetchTransactions(session: SessionData): Promise<TransactionData[]> {
    const res = await axios.get(GoBizClient.TRANSACTIONS_URL, {
      headers: GoBizClient.getHeaders(session),
    });
    const items = res.data?.data?.transactions || res.data?.transactions || [];
    return items.map((tx: any) => ({
      id: tx.id || tx.transaction_id,
      amount: parseFloat(tx.amount || tx.total_amount || 0),
      description: tx.description || tx.type || 'GoPay Transaction',
      timestamp: tx.created_at || new Date().toISOString(),
      status: tx.status === 'SUCCESS' ? 'COMPLETED' : 'PENDING',
      raw: tx,
    }));
  }
}

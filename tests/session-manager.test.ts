import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import { SessionManager } from '../src/core/session-manager';
import { FileStorageAdapter } from '../src/core/storage/file-storage';
import { SqliteStorageAdapter } from '../src/core/storage/sqlite-storage';
import { SessionData } from '../src/core/storage/storage.interface';
import {
  GoBizClient,
  parseJwtTimestamps,
  computeTokenExpiry,
  mergeCookieHeader,
  parseRetryAfterMs,
} from '../src/core/gobiz-client';
import { checkOtpRequestAllowed, recordOtpRequest } from '../src/core/otp-guard';
import { syncGoBizTransactions, resetGoBizSyncState } from '../src/core/gobiz-sync';
import fs from 'fs';
import path from 'path';

function makeJwt(payload: Record<string, any>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.signature`;
}

describe('SessionManager', () => {
  const testDir = path.join(__dirname, 'temp_session');
  let storage: FileStorageAdapter;
  let manager: SessionManager;

  beforeEach(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    storage = new FileStorageAdapter({
      sessionFile: path.join(testDir, 'session.json'),
    });
    manager = new SessionManager(storage);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect expired session correctly', () => {
    const pastSession: SessionData = {
      access_token: 'abc',
      refresh_token: 'def',
      expires_at: new Date(Date.now() - 10000).toISOString(),
    };
    expect(manager.isExpired(pastSession)).toBe(true);

    const futureSession: SessionData = {
      access_token: 'abc',
      refresh_token: 'def',
      expires_at: new Date(Date.now() + 7200000).toISOString(),
    };
    expect(manager.isExpired(futureSession)).toBe(false);

    expect(manager.isExpired(null)).toBe(true);
    expect(manager.isExpired(undefined)).toBe(true);
  });

  it('should return null when refreshIfNeeded is called on non-existent session', async () => {
    const result = await manager.refreshIfNeeded();
    expect(result).toBeNull();
  });

  it('should return valid session without calling refresh when not expired', async () => {
    const validSession: SessionData = {
      access_token: 'valid_token',
      refresh_token: 'ref_token',
      expires_at: new Date(Date.now() + 7200000).toISOString(),
    };
    await manager.saveSession(validSession);
    const session = await manager.refreshIfNeeded();
    expect(session).toEqual(validSession);
  });

  it('should refresh token when session is expired', async () => {
    const expiredSession: SessionData = {
      phone_number: '8123456789',
      access_token: 'old_access',
      refresh_token: 'old_refresh',
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    await manager.saveSession(expiredSession);

    const mockClient = new GoBizClient();
    const refreshedSession: SessionData = {
      ...expiredSession,
      access_token: 'new_access',
      refresh_token: 'new_refresh',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };

    vi.spyOn(mockClient, 'refreshToken').mockResolvedValue(refreshedSession);

    const customManager = new SessionManager(storage, mockClient);
    const result = await customManager.refreshIfNeeded();

    expect(result?.access_token).toBe('new_access');
    expect(result?.refresh_token).toBe('new_refresh');
    const stored = await storage.getSession();
    expect(stored?.access_token).toBe('new_access');
  });

  it('should coalesce concurrent refreshIfNeeded calls into single refreshToken request', async () => {
    const expiredSession: SessionData = {
      phone_number: '8123456789',
      access_token: 'old_access',
      refresh_token: 'old_refresh',
      expires_at: new Date(Date.now() - 60000).toISOString(),
    };
    await manager.saveSession(expiredSession);

    const mockClient = new GoBizClient();
    const refreshedSession: SessionData = {
      ...expiredSession,
      access_token: 'single_access',
      refresh_token: 'single_refresh',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };

    const spy = vi.spyOn(mockClient, 'refreshToken').mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 30));
      return refreshedSession;
    });

    const customManager = new SessionManager(storage, mockClient);
    const results = await Promise.all([
      customManager.refreshIfNeeded(),
      customManager.refreshIfNeeded(),
      customManager.refreshIfNeeded(),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r?.access_token).toBe('single_access');
    }
  });

  it('should trigger refresh on 401 via handleAuthError and reset state on clearSession', async () => {
    const validSession: SessionData = {
      access_token: 'acc_1',
      refresh_token: 'ref_1',
      expires_at: new Date(Date.now() + 7200000).toISOString(),
    };
    await manager.saveSession(validSession);

    const mockClient = new GoBizClient();
    const err401: any = new Error('Unauthorized');
    err401.response = { status: 401 };

    const spy = vi.spyOn(mockClient, 'refreshToken').mockResolvedValue({
      ...validSession,
      access_token: 'acc_2',
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    });

    const customManager = new SessionManager(storage, mockClient);
    const refreshed = await customManager.handleAuthError(err401);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(refreshed?.access_token).toBe('acc_2');

    await customManager.clearSession();
    expect(customManager.needsRelogin).toBe(false);
    expect(await customManager.getSession()).toBeNull();
  });

  it('should parse JWT exp/iat, expires_in fallback, cookies, and Retry-After headers', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = makeJwt({ iat: nowSec, exp: nowSec + 3600 });

    const parsed = parseJwtTimestamps(jwt);
    expect(parsed?.iat).toBe(nowSec);
    expect(parsed?.exp).toBe(nowSec + 3600);
    expect(parseJwtTimestamps('opaque-token')).toBeNull();

    const jwtExpiry = computeTokenExpiry(jwt, 86400, nowSec * 1000);
    expect(jwtExpiry.ttlSeconds).toBe(3600);
    expect(jwtExpiry.expiresAt).toBe(new Date((nowSec + 3600) * 1000).toISOString());

    const expiresInOnly = computeTokenExpiry('opaque-token', 7200, 1_700_000_000_000);
    expect(expiresInOnly.ttlSeconds).toBe(7200);
    expect(expiresInOnly.expiresAt).toBe(new Date(1_700_000_000_000 + 7200_000).toISOString());

    const merged = mergeCookieHeader(
      'cf_clearance=cf_keep; browser_id=dev-1; access_token=old_a; refresh_token=old_r',
      ['refresh_token=rotated_ref; Path=/; HttpOnly; Secure', '__cf_bm=bm_new; Path=/'],
      { accessToken: 'new_acc' }
    );
    expect(merged.refreshToken).toBe('rotated_ref');
    expect(merged.cookie).toContain('cf_clearance=cf_keep');
    expect(merged.cookie).toContain('browser_id=dev-1');
    expect(merged.cookie).toContain('__cf_bm=bm_new');
    expect(merged.cookie).toContain('access_token=new_acc');
    expect(merged.cookie).toContain('refresh_token=rotated_ref');
    expect(merged.cookie).toContain('auth_method=goid');

    expect(parseRetryAfterMs('120')).toBe(120_000);
    const futureDate = new Date(Date.now() + 45_000).toUTCString();
    const parsedDateMs = parseRetryAfterMs(futureDate);
    expect(parsedDateMs).toBeGreaterThanOrEqual(40_000);
    expect(parsedDateMs).toBeLessThanOrEqual(46_000);
  });

  it('GoBizClient should keep pinned fingerprint, capture Set-Cookie refresh_token, and fallback payload only on 400/422', async () => {
    const client = new GoBizClient();
    const baseSession: SessionData = {
      phone_number: '6281234567890',
      access_token: 'old_acc',
      refresh_token: 'old_ref',
      cookie: 'cf_clearance=keep_me; access_token=old_acc; refresh_token=old_ref',
    };

    const h1 = GoBizClient.getHeaders(baseSession);
    const h2 = GoBizClient.getHeaders(baseSession);
    expect(h1['origin']).toBe('https://portal.gofoodmerchant.co.id');
    expect(h1['x-uniqueid']).toBe(h2['x-uniqueid']);
    expect(h1['user-agent']).toBe(h2['user-agent']);

    const nowSec = Math.floor(Date.now() / 1000);
    const newJwt = makeJwt({ iat: nowSec, exp: nowSec + 3600 });

    const postSpy = vi
      .spyOn(axios, 'post')
      .mockRejectedValueOnce({ response: { status: 400, data: { message: 'invalid schema' } } })
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { access_token: newJwt } },
        headers: { 'set-cookie': ['refresh_token=cookie_rotated_ref; Path=/; HttpOnly'] },
      });

    try {
      const updated = await client.refreshToken(baseSession);
      expect(postSpy).toHaveBeenCalledTimes(2);
      expect((postSpy.mock.calls[0][1] as any).client_id).toBe('go-biz-web-new');
      expect((postSpy.mock.calls[0][1] as any).data.phone_number).toBe('81234567890');
      expect((postSpy.mock.calls[1][1] as any).refresh_token).toBe('old_ref');
      expect(updated.refresh_token).toBe('cookie_rotated_ref');
      expect(updated.cookie).toContain('cf_clearance=keep_me');
      expect(updated.device_id).toBe(h1['x-uniqueid']);
      expect(updated.token_ttl_seconds).toBe(3600);

      // Must NOT retry flat payload on 401 or 429
      postSpy.mockReset();
      postSpy.mockRejectedValueOnce({
        response: { status: 429, headers: { 'retry-after': '180' }, data: {} },
      });
      await expect(client.refreshToken(baseSession)).rejects.toMatchObject({
        isRateLimited: true,
        isPermanent: false,
        retryAfterMs: 180_000,
      });
      expect(postSpy).toHaveBeenCalledTimes(1);
    } finally {
      postSpy.mockRestore();
    }
  });

  it('GoBizClient.fetchTransactions should stop early when stopBeforeTimestamp is reached', async () => {
    const client = new GoBizClient();
    const session: SessionData = {
      phone_number: '6281234567890',
      merchant_id: 'M123',
      access_token: 'acc',
      refresh_token: 'ref',
    };

    const page1 = Array.from({ length: 50 }, (_, idx) => ({
      id: `tx_${idx}`,
      gross_amount: 1000000,
      service_type: 'QRIS',
      transaction_status: 'SETTLEMENT',
      transaction_time: new Date(Date.now() - idx * 60_000).toISOString(),
    }));

    const getSpy = vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: { data: { transactions: page1 } },
    });

    try {
      const stopBeforeTimestamp = Date.now() - 10 * 60_000;
      const txs = await client.fetchTransactions(session, 24, { maxPages: 4, stopBeforeTimestamp });
      expect(getSpy).toHaveBeenCalledTimes(1);
      expect(txs).toHaveLength(50);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('SessionManager should adapt expiry buffer, persist guard state, backoff on 429, and use browser refresh fallback', async () => {
    const shortLivedSession: SessionData = {
      access_token: 'short_jwt',
      refresh_token: 'ref_1',
      token_ttl_seconds: 3600,
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    };
    expect(manager.isExpired(shortLivedSession)).toBe(false);
    expect(
      manager.isExpired({
        ...shortLivedSession,
        expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
      })
    ).toBe(true);

    // Use SQLite storage to verify guard persistence across SessionManager restarts
    const sqlite = new SqliteStorageAdapter({ dbPath: ':memory:', autoMigrateJson: false });
    try {
      const expired: SessionData = {
        phone_number: '6281234567890',
        access_token: 'acc_old',
        refresh_token: 'ref_old',
        expires_at: new Date(Date.now() - 60_000).toISOString(),
      };
      await sqlite.saveSession(expired);

      // 1) HTTP 429 triggers persisted backoff without marking permanentlyInvalid
      const client429 = new GoBizClient();
      vi.spyOn(client429, 'refreshToken').mockRejectedValue({
        isRateLimited: true,
        isPermanent: false,
        status: 429,
        retryAfterMs: 120_000,
        message: 'RATE_LIMITED_429',
      });
      const mgr429 = new SessionManager(sqlite, client429, { silentRefreshFn: null });
      const res429 = await mgr429.refreshIfNeeded();
      expect(res429).toBeNull();
      expect(mgr429.needsRelogin).toBe(false);
      expect(await mgr429.isApiRateLimited()).toBe(true);

      // Simulated restart still sees active rate-limit backoff and does not hit GoBiz
      const clientAfterRestart = new GoBizClient();
      const restartSpy = vi.spyOn(clientAfterRestart, 'refreshToken');
      const mgrRestart = new SessionManager(sqlite, clientAfterRestart, { silentRefreshFn: null });
      expect(await mgrRestart.isApiRateLimited()).toBe(true);
      await mgrRestart.refreshIfNeeded();
      expect(restartSpy).not.toHaveBeenCalled();

      // 2) Silent browser refresh rescues 401 permanent failure (new login clears prior 429 guard state)
      const client401 = new GoBizClient();
      vi.spyOn(client401, 'refreshToken').mockRejectedValue({
        isPermanent: true,
        isAuthFailure: true,
        canTryBrowserFallback: true,
        status: 401,
        message: 'PERMANENT_AUTH_FAILURE',
      });
      const silentSpy = vi.fn().mockResolvedValue({
        status: 'success',
        session: {
          ...expired,
          access_token: 'browser_rescued_acc',
          refresh_token: 'browser_rescued_ref',
          expires_at: new Date(Date.now() + 7200_000).toISOString(),
        },
      });
      const mgrRescue = new SessionManager(sqlite, client401, { silentRefreshFn: silentSpy });
      await mgrRescue.saveSession(expired);
      const rescued = await mgrRescue.refreshIfNeeded();
      expect(silentSpy).toHaveBeenCalledTimes(1);
      expect(rescued?.access_token).toBe('browser_rescued_acc');
      expect(mgrRescue.needsRelogin).toBe(false);

      // 3) relogin_required from browser fallback persists permanentlyInvalid across restarts
      const silentRelogin = vi.fn().mockResolvedValue({ status: 'relogin_required' });
      const mgrDead = new SessionManager(sqlite, client401, { silentRefreshFn: silentRelogin });
      await mgrDead.saveSession(expired);
      expect(await mgrDead.refreshIfNeeded()).toBeNull();
      expect(mgrDead.needsRelogin).toBe(true);

      const clientDeadRestart = new GoBizClient();
      const deadSpy = vi.spyOn(clientDeadRestart, 'refreshToken');
      const mgrDeadRestart = new SessionManager(sqlite, clientDeadRestart, { silentRefreshFn: silentRelogin });
      expect(await mgrDeadRestart.refreshIfNeeded()).toBeNull();
      expect(mgrDeadRestart.needsRelogin).toBe(true);
      expect(deadSpy).not.toHaveBeenCalled();
    } finally {
      sqlite.close();
    }
  });

  it('otp-guard and gobiz-sync should enforce OTP caps and shared rate-limit circuit breaker', async () => {
    const sqlite = new SqliteStorageAdapter({ dbPath: ':memory:', autoMigrateJson: false });
    resetGoBizSyncState();
    try {
      const baseNow = 1_700_000_000_000;
      const phone = '081262345678';

      await recordOtpRequest(sqlite, phone, baseNow);
      const cooldownDeny = await checkOtpRequestAllowed(sqlite, phone, baseNow + 10_000, {
        cooldownMs: 60_000,
        maxPerHour: 3,
        maxPerDay: 5,
      });
      expect(cooldownDeny.allowed).toBe(false);
      expect(cooldownDeny.scope).toBe('cooldown');

      await recordOtpRequest(sqlite, phone, baseNow + 70_000);
      await recordOtpRequest(sqlite, phone, baseNow + 140_000);
      const hourlyDeny = await checkOtpRequestAllowed(sqlite, phone, baseNow + 210_000, {
        cooldownMs: 60_000,
        maxPerHour: 3,
        maxPerDay: 5,
      });
      expect(hourlyDeny.allowed).toBe(false);
      expect(hourlyDeny.scope).toBe('hourly');

      // New day? Still within 24h after 5 requests across separate hours -> daily cap
      await recordOtpRequest(sqlite, phone, baseNow + 4_000_000);
      await recordOtpRequest(sqlite, phone, baseNow + 8_000_000);
      const dailyDeny = await checkOtpRequestAllowed(sqlite, phone, baseNow + 12_000_000, {
        cooldownMs: 60_000,
        maxPerHour: 3,
        maxPerDay: 5,
      });
      expect(dailyDeny.allowed).toBe(false);
      expect(dailyDeny.scope).toBe('daily');

      // gobiz-sync should skip upstream fetch when manager is rate limited
      await sqlite.saveSession({
        access_token: 'acc',
        refresh_token: 'ref',
        expires_at: new Date(Date.now() + 7200_000).toISOString(),
      });
      await sqlite.saveTransaction({
        id: 'cached_tx_1',
        amount: 25000,
        timestamp: new Date().toISOString(),
        status: 'COMPLETED',
      });

      const mockClient = new GoBizClient();
      const fetchSpy = vi.spyOn(mockClient, 'fetchTransactions');
      const mgr = new SessionManager(sqlite, mockClient, { silentRefreshFn: null });
      await mgr.recordApiRateLimit({ retryAfterMs: 60_000, message: '429 test' });

      const synced = await syncGoBizTransactions(sqlite, mgr, mockClient);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(synced.some((tx) => tx.id === 'cached_tx_1')).toBe(true);
    } finally {
      resetGoBizSyncState();
      sqlite.close();
    }
  });
});

import { StorageAdapter, SessionData } from './storage/storage.interface';
import { GoBizClient } from './gobiz-client';
import { runSilentCamoufoxRefresh, SilentRefreshResult } from './browser-refresh';

export type SilentRefreshFn = (session: SessionData) => Promise<SilentRefreshResult>;

export interface SessionManagerOptions {
  silentRefreshFn?: SilentRefreshFn | null;
}

export interface AuthHealthSnapshot {
  needs_relogin: boolean;
  rate_limited_until: number | null;
  backoff_until: number | null;
  consecutive_failures: number;
  rate_limit_hits: number;
  last_refresh_at: number | null;
  last_error: string | null;
  token_ttl_seconds: number | null;
  expires_in_seconds: number | null;
}

interface PersistedGuardState {
  permanentlyInvalid: boolean;
  consecutiveFailures: number;
  backoffUntil: number;
  rateLimitedUntil: number;
  rateLimitHits: number;
  lastRefreshAt: number;
  lastSilentRefreshAt: number;
  lastError: string | null;
}

const AUTH_GUARD_CONFIG_KEY = 'authGuardState';
const BACKOFF_SCHEDULE_MS = [60_000, 180_000, 600_000, 1800_000, 3600_000];
const SILENT_REFRESH_COOLDOWN_MS = 15 * 60_000;

function computeBackoffMs(consecutiveFailures: number): number {
  const idx = Math.min(Math.max(0, consecutiveFailures - 1), BACKOFF_SCHEDULE_MS.length - 1);
  const base = BACKOFF_SCHEDULE_MS[idx];
  const jitter = process.env.NODE_ENV === 'test' ? 1 : 0.85 + Math.random() * 0.3;
  return Math.round(base * jitter);
}

export class SessionManager {
  private client: GoBizClient;
  private silentRefreshFn: SilentRefreshFn | null;
  private inFlightRefresh: Promise<SessionData | null> | null = null;
  private guardLoaded = false;
  private guardLoadPromise: Promise<void> | null = null;

  private permanentlyInvalid = false;
  private consecutiveFailures = 0;
  private backoffUntil = 0;
  private rateLimitedUntil = 0;
  private rateLimitHits = 0;
  private lastRefreshAt = 0;
  private lastSilentRefreshAt = 0;
  private lastError: string | null = null;

  constructor(private storage: StorageAdapter, client?: GoBizClient, options?: SessionManagerOptions) {
    this.client = client || new GoBizClient();
    if (options && 'silentRefreshFn' in options) {
      this.silentRefreshFn = options.silentRefreshFn || null;
    } else if (process.env.NODE_ENV !== 'test' && process.env.KAIGOBIZ_DISABLE_BROWSER_REFRESH !== 'true') {
      this.silentRefreshFn = runSilentCamoufoxRefresh;
    } else {
      this.silentRefreshFn = null;
    }
  }

  private async ensureGuardStateLoaded(): Promise<void> {
    if (this.guardLoaded) return;
    if (this.guardLoadPromise) {
      await this.guardLoadPromise;
      return;
    }

    this.guardLoadPromise = (async () => {
      if (this.storage.getConfig) {
        try {
          const cfg = await this.storage.getConfig();
          const raw = cfg?.[AUTH_GUARD_CONFIG_KEY];
          if (raw) {
            const parsed: Partial<PersistedGuardState> = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (parsed && typeof parsed === 'object') {
              this.permanentlyInvalid = Boolean(parsed.permanentlyInvalid);
              this.consecutiveFailures = Number(parsed.consecutiveFailures) || 0;
              this.backoffUntil = Number(parsed.backoffUntil) || 0;
              this.rateLimitedUntil = Number(parsed.rateLimitedUntil) || 0;
              this.rateLimitHits = Number(parsed.rateLimitHits) || 0;
              this.lastRefreshAt = Number(parsed.lastRefreshAt) || 0;
              this.lastSilentRefreshAt = Number(parsed.lastSilentRefreshAt) || 0;
              this.lastError = typeof parsed.lastError === 'string' ? parsed.lastError : null;
            }
          }
        } catch {}
      }
      this.guardLoaded = true;
      this.guardLoadPromise = null;
    })();

    await this.guardLoadPromise;
  }

  private async persistGuardState(): Promise<void> {
    if (!this.storage.setConfig) return;
    const hasState =
      this.permanentlyInvalid ||
      this.consecutiveFailures > 0 ||
      this.backoffUntil > 0 ||
      this.rateLimitedUntil > 0 ||
      this.rateLimitHits > 0 ||
      this.lastRefreshAt > 0 ||
      this.lastSilentRefreshAt > 0 ||
      this.lastError !== null;

    try {
      if (!hasState) {
        await this.storage.setConfig({ [AUTH_GUARD_CONFIG_KEY]: null });
        return;
      }
      const snapshot: PersistedGuardState = {
        permanentlyInvalid: this.permanentlyInvalid,
        consecutiveFailures: this.consecutiveFailures,
        backoffUntil: this.backoffUntil,
        rateLimitedUntil: this.rateLimitedUntil,
        rateLimitHits: this.rateLimitHits,
        lastRefreshAt: this.lastRefreshAt,
        lastSilentRefreshAt: this.lastSilentRefreshAt,
        lastError: this.lastError,
      };
      await this.storage.setConfig({ [AUTH_GUARD_CONFIG_KEY]: JSON.stringify(snapshot) });
    } catch {}
  }

  private resetFailureCounters(keepSilentTimestamp = false) {
    this.permanentlyInvalid = false;
    this.consecutiveFailures = 0;
    this.backoffUntil = 0;
    this.rateLimitHits = 0;
    this.rateLimitedUntil = 0;
    this.lastError = null;
    if (!keepSilentTimestamp) {
      this.lastSilentRefreshAt = 0;
    }
  }

  async getSession(): Promise<SessionData | null> {
    await this.ensureGuardStateLoaded();
    return await this.storage.getSession();
  }

  async saveSession(session: SessionData): Promise<boolean> {
    this.guardLoaded = true;
    this.resetFailureCounters();
    this.lastRefreshAt = 0;
    await this.persistGuardState();
    return await this.storage.saveSession(session);
  }

  async clearSession(): Promise<boolean> {
    this.guardLoaded = true;
    this.resetFailureCounters();
    this.lastRefreshAt = 0;
    this.inFlightRefresh = null;
    await this.persistGuardState();
    if (this.storage.clearSession) {
      return await this.storage.clearSession();
    }
    return true;
  }

  get needsRelogin(): boolean {
    return this.permanentlyInvalid;
  }

  isHardExpired(session?: SessionData | null): boolean {
    if (!session || !session.access_token) return true;
    if (!session.expires_at) return false;
    const expiryTime = new Date(session.expires_at).getTime();
    if (!Number.isFinite(expiryTime)) return false;
    return expiryTime <= Date.now();
  }

  private getRefreshBufferMs(session: SessionData): number {
    if (typeof session.token_ttl_seconds === 'number' && Number.isFinite(session.token_ttl_seconds) && session.token_ttl_seconds > 0) {
      return Math.min(60 * 60 * 1000, Math.max(2 * 60 * 1000, Math.floor(session.token_ttl_seconds * 1000 * 0.2)));
    }
    return 60 * 60 * 1000;
  }

  isExpired(session?: SessionData | null): boolean {
    if (!session || !session.access_token) return true;
    if (!session.expires_at) return false;
    const expiryTime = new Date(session.expires_at).getTime();
    if (!Number.isFinite(expiryTime)) return false;
    return expiryTime - Date.now() < this.getRefreshBufferMs(session);
  }

  async isApiRateLimited(): Promise<boolean> {
    await this.ensureGuardStateLoaded();
    return Date.now() < this.rateLimitedUntil;
  }

  async recordApiRateLimit(err: any): Promise<void> {
    await this.ensureGuardStateLoaded();
    const now = Date.now();
    this.rateLimitHits += 1;
    const expMs = Math.min(30 * 60_000, 120_000 * Math.pow(2, this.rateLimitHits - 1));
    const waitMs = Math.max(Number(err?.retryAfterMs) || 0, expMs);
    this.rateLimitedUntil = Math.max(this.rateLimitedUntil, now + waitMs);
    this.lastError = err?.message || 'Rate limited by GoBiz';
    await this.persistGuardState();
  }

  async getAuthHealth(): Promise<AuthHealthSnapshot> {
    await this.ensureGuardStateLoaded();
    const session = await this.storage.getSession();
    const now = Date.now();
    const expiresMs = session?.expires_at ? new Date(session.expires_at).getTime() : NaN;
    const expiresInSeconds = Number.isFinite(expiresMs) ? Math.max(0, Math.floor((expiresMs - now) / 1000)) : null;

    return {
      needs_relogin: this.permanentlyInvalid,
      rate_limited_until: this.rateLimitedUntil > now ? this.rateLimitedUntil : null,
      backoff_until: this.backoffUntil > now ? this.backoffUntil : null,
      consecutive_failures: this.consecutiveFailures,
      rate_limit_hits: this.rateLimitHits,
      last_refresh_at: this.lastRefreshAt > 0 ? this.lastRefreshAt : null,
      last_error: this.lastError,
      token_ttl_seconds: session?.token_ttl_seconds ?? null,
      expires_in_seconds: expiresInSeconds,
    };
  }

  private async trySilentBrowserRefresh(session: SessionData, now: number): Promise<SilentRefreshResult | null> {
    if (!this.silentRefreshFn) return null;
    if (this.lastSilentRefreshAt > 0 && now - this.lastSilentRefreshAt < SILENT_REFRESH_COOLDOWN_MS) {
      return null;
    }
    this.lastSilentRefreshAt = now;
    await this.persistGuardState();
    return await this.silentRefreshFn(session);
  }

  async refreshIfNeeded(forceRefresh = false): Promise<SessionData | null> {
    await this.ensureGuardStateLoaded();
    const session = await this.storage.getSession();
    if (!session) return null;

    if (this.permanentlyInvalid) return null;

    if (this.inFlightRefresh) {
      return await this.inFlightRefresh;
    }

    if (!forceRefresh && !this.isExpired(session)) {
      return session;
    }

    const now = Date.now();
    if (now < this.rateLimitedUntil || now < this.backoffUntil) {
      return this.isHardExpired(session) ? null : session;
    }

    if (!forceRefresh && this.lastRefreshAt > 0 && process.env.NODE_ENV !== 'test' && now - this.lastRefreshAt < 60_000) {
      return this.isHardExpired(session) ? null : session;
    }

    this.inFlightRefresh = (async () => {
      try {
        const refreshed = await this.client.refreshToken(session);
        this.resetFailureCounters(true);
        this.lastRefreshAt = Date.now();
        await this.persistGuardState();
        await this.storage.saveSession(refreshed);
        return refreshed;
      } catch (err: any) {
        const errTime = Date.now();

        if (err?.isRateLimited) {
          this.rateLimitHits += 1;
          const expMs = Math.min(30 * 60_000, 120_000 * Math.pow(2, this.rateLimitHits - 1));
          const waitMs = Math.max(Number(err.retryAfterMs) || 0, expMs);
          this.rateLimitedUntil = errTime + waitMs;
          this.lastError = err.message || 'Rate limited by GoBiz';

          if (err.canTryBrowserFallback) {
            const browserRes = await this.trySilentBrowserRefresh(session, errTime);
            if (browserRes?.status === 'success') {
              this.resetFailureCounters(true);
              this.lastRefreshAt = Date.now();
              await this.persistGuardState();
              await this.storage.saveSession(browserRes.session);
              return browserRes.session;
            }
          }

          await this.persistGuardState();
          console.warn(`[KaiGoBiz SessionManager] GoBiz rate limit / WAF guard active (${Math.ceil(waitMs / 1000)}s): ${this.lastError}`);
          return this.isHardExpired(session) ? null : session;
        }

        if (err?.isPermanent) {
          if (err.canTryBrowserFallback !== false) {
            const browserRes = await this.trySilentBrowserRefresh(session, errTime);
            if (browserRes?.status === 'success') {
              this.resetFailureCounters(true);
              this.lastRefreshAt = Date.now();
              await this.persistGuardState();
              await this.storage.saveSession(browserRes.session);
              console.log('[KaiGoBiz SessionManager] Sesi dipulihkan via silent browser refresh tanpa OTP.');
              return browserRes.session;
            }
            if (browserRes?.status === 'error') {
              this.consecutiveFailures += 1;
              this.backoffUntil = errTime + computeBackoffMs(this.consecutiveFailures);
              this.lastError = browserRes.message || err.message || 'Silent browser refresh temporarily failed';
              await this.persistGuardState();
              console.warn(`[KaiGoBiz SessionManager] Silent browser refresh tertunda, akan dicoba lagi nanti: ${this.lastError}`);
              return this.isHardExpired(session) ? null : session;
            }
          }

          this.permanentlyInvalid = true;
          this.lastError = err.message || 'PERMANENT_AUTH_FAILURE';
          await this.persistGuardState();
          console.warn(`[KaiGoBiz SessionManager] Token permanently invalid - re-login required. (${this.lastError})`);
          return null;
        }

        this.consecutiveFailures += 1;
        const backoffMs = computeBackoffMs(this.consecutiveFailures);
        this.backoffUntil = errTime + backoffMs;
        this.lastError = err?.message || 'Transient refresh error';
        await this.persistGuardState();
        console.warn(`[KaiGoBiz SessionManager] Transient refresh error (backoff ${Math.ceil(backoffMs / 1000)}s): ${this.lastError}`);
        return this.isHardExpired(session) ? null : session;
      } finally {
        this.inFlightRefresh = null;
      }
    })();

    return await this.inFlightRefresh;
  }

  async handleAuthError(err: any): Promise<SessionData | null> {
    const status = err?.response?.status ?? err?.status;
    if (status === 429 || (status === 403 && !err?.errorCode && err?.isRateLimited)) {
      await this.recordApiRateLimit(err);
      return null;
    }
    if (status === 401 || status === 403) {
      return await this.refreshIfNeeded(true);
    }
    return null;
  }
}

let defaultManager: SessionManager | null = null;
let defaultManagerStorage: StorageAdapter | null = null;

export function getSessionManager(storage: StorageAdapter): SessionManager {
  if (!defaultManager || defaultManagerStorage !== storage) {
    defaultManager = new SessionManager(storage);
    defaultManagerStorage = storage;
  }
  return defaultManager;
}

export function resetDefaultSessionManager(): void {
  defaultManager = null;
  defaultManagerStorage = null;
}

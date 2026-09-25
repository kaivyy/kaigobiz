import { StorageAdapter, SessionData } from './storage/storage.interface';
import { GoBizClient } from './gobiz-client';

export class SessionManager {
  private client: GoBizClient;
  private lastFailedRefreshTime = 0;
  private permanentlyInvalid = false;

  constructor(private storage: StorageAdapter, client?: GoBizClient) {
    this.client = client || new GoBizClient();
  }

  async getSession(): Promise<SessionData | null> {
    return await this.storage.getSession();
  }

  async saveSession(session: SessionData): Promise<boolean> {
    this.permanentlyInvalid = false;
    return await this.storage.saveSession(session);
  }

  // Returns true if a permanent auth failure has been detected (token dead, re-login needed).
  get needsRelogin(): boolean {
    return this.permanentlyInvalid;
  }

  isExpired(session?: SessionData | null): boolean {
    if (!session || !session.access_token) return true;
    if (!session.expires_at) return false;
    const expiryTime = new Date(session.expires_at).getTime();
    return expiryTime - Date.now() < 60 * 60 * 1000; // 1 hour buffer for safe renewal
  }

  async refreshIfNeeded(): Promise<SessionData | null> {
    const session = await this.getSession();
    if (!session) return null;

    // Token known to be permanently dead — skip network call entirely.
    if (this.permanentlyInvalid) return null;

    if (this.isExpired(session)) {
      // Transient failure cooldown: wait 60s before retrying network errors.
      if (Date.now() - this.lastFailedRefreshTime < 60 * 1000) {
        return null;
      }
      try {
        const refreshed = await this.client.refreshToken(session);
        this.lastFailedRefreshTime = 0;
        await this.storage.saveSession(refreshed);
        return refreshed;
      } catch (err: any) {
        // Permanent failure (401 token expired/revoked): mark as dead, never retry.
        // This prevents hammering GoBiz API every 60s with a dead token.
        if (err.isPermanent) {
          this.permanentlyInvalid = true;
          console.warn(`[KaiGoBiz SessionManager] Token permanently invalid — re-login required. (${err.message})`);
          return null;
        }
        // Transient failure: retry after 60s cooldown.
        this.lastFailedRefreshTime = Date.now();
        console.warn(`[KaiGoBiz SessionManager] Transient refresh error, will retry in 60s: ${err.message}`);
        return null;
      }
    }
    return session;
  }
}

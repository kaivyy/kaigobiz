import { StorageAdapter, SessionData } from './storage/storage.interface';
import { GoBizClient } from './gobiz-client';

export class SessionManager {
  private client: GoBizClient;
  private lastFailedRefreshTime = 0;

  constructor(private storage: StorageAdapter, client?: GoBizClient) {
    this.client = client || new GoBizClient();
  }

  async getSession(): Promise<SessionData | null> {
    return await this.storage.getSession();
  }

  async saveSession(session: SessionData): Promise<boolean> {
    return await this.storage.saveSession(session);
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
    if (this.isExpired(session)) {
      if (Date.now() - this.lastFailedRefreshTime < 60 * 1000) {
        return null;
      }
      try {
        const refreshed = await this.client.refreshToken(session);
        this.lastFailedRefreshTime = 0;
        await this.saveSession(refreshed);
        return refreshed;
      } catch (err: any) {
        this.lastFailedRefreshTime = Date.now();
        console.warn(`[KaiGoBiz SessionManager] Failed to auto-refresh token: ${err.message}`);
        return null;
      }
    }
    return session;
  }
}

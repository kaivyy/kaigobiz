import { StorageAdapter, SessionData } from './storage/storage.interface';
import { GoBizClient } from './gobiz-client';

export class SessionManager {
  private client: GoBizClient;

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
    return expiryTime - Date.now() < 5 * 60 * 1000; // 5 mins buffer
  }

  async refreshIfNeeded(): Promise<SessionData | null> {
    const session = await this.getSession();
    if (!session) return null;
    if (this.isExpired(session)) {
      try {
        const refreshed = await this.client.refreshToken(session);
        await this.saveSession(refreshed);
        return refreshed;
      } catch (err) {
        return null;
      }
    }
    return session;
  }
}

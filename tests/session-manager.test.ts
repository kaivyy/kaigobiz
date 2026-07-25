import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionManager } from '../src/core/session-manager';
import { FileStorageAdapter } from '../src/core/storage/file-storage';
import { SessionData } from '../src/core/storage/storage.interface';
import { GoBizClient } from '../src/core/gobiz-client';
import fs from 'fs';
import path from 'path';

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
      expires_at: new Date(Date.now() + 3600000).toISOString(),
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
      expires_at: new Date(Date.now() + 3600000).toISOString(),
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
});

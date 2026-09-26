export * from './storage.interface';
export * from './sqlite-storage';
export * from './file-storage';

import { SqliteStorageAdapter } from './sqlite-storage';
import { StorageAdapter } from './storage.interface';

let defaultStorage: StorageAdapter | null = null;

export function getStorage(dbPath?: string): StorageAdapter {
  if (!defaultStorage || dbPath) {
    const storage = new SqliteStorageAdapter(dbPath ? { dbPath } : undefined);
    if (!dbPath) {
      defaultStorage = storage;
    }
    return storage;
  }
  return defaultStorage;
}

export function resetDefaultStorage(): void {
  if (defaultStorage) {
    try { defaultStorage.close?.(); } catch {}
    defaultStorage = null;
  }
}

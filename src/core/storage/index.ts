export * from './storage.interface';
export * from './sqlite-storage';
export * from './file-storage';

import path from 'path';
import { SqliteStorageAdapter } from './sqlite-storage';
import { StorageAdapter } from './storage.interface';

let defaultStorage: StorageAdapter | null = null;

export function getStorage(dbPath?: string): StorageAdapter {
  if (!defaultStorage || dbPath) {
    const resolvedPath =
      dbPath ||
      process.env.SQLITE_DB_PATH ||
      (process.env.NODE_ENV === 'test' ? ':memory:' : undefined);
    const storage = new SqliteStorageAdapter(resolvedPath ? { dbPath: resolvedPath } : undefined);
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

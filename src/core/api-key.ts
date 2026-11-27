import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { StorageAdapter } from './storage/storage.interface';

export interface ApiKeyInitResult {
  key: string;
  source: 'env' | 'storage' | 'generated' | 'disabled';
  generated: boolean;
}

export function generateApiKey(): string {
  return 'kgb_' + crypto.randomBytes(24).toString('hex');
}

export function maskApiKey(key: string): string {
  const trimmed = String(key || '').trim();
  if (!trimmed) return '';
  if (trimmed.length <= 12) return '****';
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-4)}`;
}

export function getActiveApiKey(): string {
  if (process.env.KAIGOBIZ_DISABLE_AUTH === 'true') {
    return '';
  }
  return (process.env.KAIGOBIZ_API_KEY || process.env.API_KEY || '').trim();
}

function readKeyFromEnvFile(envPath: string): string {
  if (!fs.existsSync(envPath)) return '';
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^(?:KAIGOBIZ_API_KEY|API_KEY)\s*=\s*(.+)$/);
      if (match && match[1]) {
        const cleaned = match[1].trim().replace(/^["']|["']$/g, '').trim();
        if (cleaned) return cleaned;
      }
    }
  } catch {}
  return '';
}

function writeKeyToEnvFile(envPath: string, key: string): void {
  const dir = path.dirname(envPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (fs.existsSync(envPath)) {
    const existing = fs.readFileSync(envPath, 'utf-8');
    const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(envPath, `${prefix}KAIGOBIZ_API_KEY=${key}\n`, { encoding: 'utf-8' });
  } else {
    fs.writeFileSync(envPath, `KAIGOBIZ_API_KEY=${key}\n`, { encoding: 'utf-8', mode: 0o600 });
  }
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {}
}

export async function ensureApiKeyInitialized(options?: {
  envPath?: string;
  storage?: StorageAdapter;
}): Promise<ApiKeyInitResult> {
  if (process.env.KAIGOBIZ_DISABLE_AUTH === 'true') {
    return { key: '', source: 'disabled', generated: false };
  }

  const currentEnvKey = (process.env.KAIGOBIZ_API_KEY || process.env.API_KEY || '').trim();
  if (currentEnvKey) {
    return { key: currentEnvKey, source: 'env', generated: false };
  }

  const envPath = options?.envPath || path.join(process.cwd(), '.env');
  const fileKey = readKeyFromEnvFile(envPath);
  if (fileKey) {
    process.env.KAIGOBIZ_API_KEY = fileKey;
    return { key: fileKey, source: 'env', generated: false };
  }

  if (options?.storage?.getConfig) {
    try {
      const cfg = await options.storage.getConfig();
      const storedKey = typeof cfg?.apiKey === 'string' ? cfg.apiKey.trim() : '';
      if (storedKey) {
        process.env.KAIGOBIZ_API_KEY = storedKey;
        try {
          writeKeyToEnvFile(envPath, storedKey);
        } catch {}
        return { key: storedKey, source: 'storage', generated: false };
      }
    } catch {}
  }

  const generatedKey = generateApiKey();
  process.env.KAIGOBIZ_API_KEY = generatedKey;

  try {
    writeKeyToEnvFile(envPath, generatedKey);
  } catch {}

  if (options?.storage?.setConfig) {
    try {
      await options.storage.setConfig({ apiKey: generatedKey });
    } catch {}
  }

  return { key: generatedKey, source: 'generated', generated: true };
}

import { ChildProcess, spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SessionData } from './storage/storage.interface';

export type SilentRefreshResult =
  | { status: 'success'; session: SessionData }
  | { status: 'relogin_required' }
  | { status: 'error'; message: string };

let interactiveLoginActive = false;

export function isInteractiveLoginActive(): boolean {
  return interactiveLoginActive;
}

export function setInteractiveLoginActive(active: boolean): void {
  interactiveLoginActive = active;
}

function cleanupStaleProfileLocks(profileDir: string) {
  for (const lockFile of ['.parentlock', 'lock']) {
    const lockPath = path.join(profileDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
}

export async function runSilentCamoufoxRefresh(currentSession: SessionData): Promise<SilentRefreshResult> {
  if (interactiveLoginActive) {
    return { status: 'error', message: 'interactive_login_active' };
  }

  const workerScript = path.join(process.cwd(), 'camoufox_gobiz_worker.py');
  const profileDir = path.join(process.cwd(), '.camoufox-profile');
  if (!fs.existsSync(workerScript) || !fs.existsSync(profileDir)) {
    return { status: 'error', message: 'browser_profile_unavailable' };
  }

  cleanupStaleProfileLocks(profileDir);

  const stateFile = path.join(os.tmpdir(), `kaigobiz_silent_refresh_${crypto.randomUUID()}.json`);
  const args = [workerScript, '--refresh-only', '--state-file', stateFile];
  if (currentSession.phone_number) {
    args.push('--phone', currentSession.phone_number);
  }

  let worker: ChildProcess | null = null;

  try {
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        resolve();
      };

      worker = spawn('python3', args, { stdio: 'ignore' });
      worker.on('exit', finish);
      worker.on('error', finish);

      const killTimer = setTimeout(() => {
        if (worker) {
          try {
            worker.kill('SIGTERM');
          } catch {}
          setTimeout(() => {
            try {
              if (worker && !worker.killed) worker.kill('SIGKILL');
            } catch {}
            finish();
          }, 500).unref?.();
        } else {
          finish();
        }
      }, 35_000);
      killTimer.unref?.();
    });

    if (!fs.existsSync(stateFile)) {
      return { status: 'error', message: 'silent_refresh_no_output' };
    }

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    if (state?.status === 'success' && state.session?.access_token) {
      const merged: SessionData = {
        ...currentSession,
        access_token: state.session.access_token,
        refresh_token: state.session.refresh_token || currentSession.refresh_token,
        cookie: state.session.cookie || currentSession.cookie,
        device_id: state.session.device_id || currentSession.device_id,
        user_agent: state.session.user_agent || currentSession.user_agent,
        expires_at: state.session.expires_at || currentSession.expires_at,
        token_ttl_seconds: state.session.token_ttl_seconds || currentSession.token_ttl_seconds,
        updated_at: new Date().toISOString(),
      };
      return { status: 'success', session: merged };
    }

    if (state?.status === 'relogin_required') {
      return { status: 'relogin_required' };
    }

    return { status: 'error', message: state?.message || 'silent_refresh_failed' };
  } catch (err: any) {
    return { status: 'error', message: err?.message || 'silent_refresh_exception' };
  } finally {
    if (fs.existsSync(stateFile)) {
      try {
        fs.unlinkSync(stateFile);
      } catch {}
    }
  }
}

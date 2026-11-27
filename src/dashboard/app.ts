import { KaiGoBiz } from '../widget/kaigobiz-widget';
import jsQR from 'jsqr';

interface TransactionItem {
  id: string;
  amount: number;
  description?: string;
  timestamp: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
}

interface AuthStatusResponse {
  connected: boolean;
  needs_relogin?: boolean;
  health?: {
    needs_relogin?: boolean;
    rate_limited_until?: number | null;
    backoff_until?: number | null;
    consecutive_failures?: number;
    last_error?: string | null;
    expires_in_seconds?: number | null;
  };
  session?: {
    outlet_name?: string;
    owner_name?: string;
    phone_number?: string;
    merchant_id?: string;
    outlet_address?: string;
    kyc_status?: string;
    features?: Array<{ product_name: string; product_type: string; status: string }>;
    expires_at?: string;
    updated_at?: string;
  };
}

// State
let allTransactions: TransactionItem[] = [];
let isSessionConnected: boolean = false;
let currentFilter: string = 'ALL';
let searchQuery: string = '';
let currentOtpToken = '';
let currentPhone = '';
let currentQrisPayload = '';
let currentQrisDataUrl = '';
let activeCountdownInterval: any = null;
let activePollInterval: any = null;

function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

let apiKeyModalInFlight: Promise<string | null> | null = null;

function syncApiKeyButtonState() {
  const btn = document.getElementById('api-key-config-btn');
  const label = document.getElementById('api-key-btn-label');
  const hasKey = Boolean(sessionStorage.getItem('kaigobiz_api_key')?.trim());
  if (btn) {
    btn.classList.toggle('configured', hasKey);
  }
  if (label) {
    label.textContent = hasKey ? 'API Key: Aktif' : 'API Key';
  }
}

async function openApiKeyModal(options?: {
  reason?: string;
  statusText?: string;
  statusType?: 'info' | 'error' | 'success';
  verifyOnSave?: boolean;
}): Promise<string | null> {
  if (apiKeyModalInFlight) return await apiKeyModalInFlight;

  const modal = document.getElementById('api-key-modal');
  const form = document.getElementById('api-key-modal-form') as HTMLFormElement | null;
  const input = document.getElementById('api-key-modal-input') as HTMLInputElement | null;
  const subtitle = document.getElementById('api-key-modal-subtitle');
  const statusEl = document.getElementById('api-key-modal-status');
  const toggleVisBtn = document.getElementById('api-key-toggle-vis') as HTMLButtonElement | null;
  const clearBtn = document.getElementById('api-key-clear-btn') as HTMLButtonElement | null;
  const cancelBtn = document.getElementById('api-key-cancel-btn') as HTMLButtonElement | null;
  const closeBtn = document.getElementById('api-key-modal-close') as HTMLButtonElement | null;
  const saveBtn = document.getElementById('api-key-save-btn') as HTMLButtonElement | null;

  if (!modal || !form || !input) return null;

  const prevFocused = document.activeElement as HTMLElement | null;

  const setInlineStatus = (text: string | null, type: 'info' | 'error' | 'success' = 'info') => {
    if (!statusEl) return;
    if (!text) {
      statusEl.hidden = true;
      statusEl.textContent = '';
      statusEl.className = 'modal-inline-status';
      return;
    }
    statusEl.hidden = false;
    statusEl.textContent = text;
    statusEl.className = `modal-inline-status ${type}`;
  };

  if (subtitle) {
    subtitle.textContent =
      options?.reason || 'Masukkan KAIGOBIZ_API_KEY untuk mengakses endpoint admin dan mutasi.';
  }
  input.value = sessionStorage.getItem('kaigobiz_api_key') || '';
  input.type = 'password';
  if (toggleVisBtn) toggleVisBtn.textContent = 'Lihat';
  if (clearBtn) clearBtn.style.display = input.value ? 'inline-flex' : 'none';
  setInlineStatus(options?.statusText || null, options?.statusType || 'info');

  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => input.focus());

  apiKeyModalInFlight = new Promise<string | null>((resolve) => {
    let settled = false;

    const closeModal = (result: string | null) => {
      if (settled) return;
      settled = true;
      modal.hidden = true;
      modal.setAttribute('aria-hidden', 'true');
      if (saveBtn) saveBtn.disabled = false;
      form.removeEventListener('submit', onSubmit);
      clearBtn?.removeEventListener('click', onClear);
      cancelBtn?.removeEventListener('click', onCancel);
      closeBtn?.removeEventListener('click', onCancel);
      toggleVisBtn?.removeEventListener('click', onToggleVis);
      modal.removeEventListener('click', onBackdropClick);
      document.removeEventListener('keydown', onKeyDown);
      apiKeyModalInFlight = null;
      prevFocused?.focus?.();
      resolve(result);
    };

    const onCancel = () => closeModal(null);

    const onBackdropClick = (e: MouseEvent) => {
      if (e.target === modal) closeModal(null);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeModal(null);
      }
    };

    const onToggleVis = () => {
      const nextHidden = input.type !== 'password';
      input.type = nextHidden ? 'password' : 'text';
      if (toggleVisBtn) toggleVisBtn.textContent = nextHidden ? 'Lihat' : 'Sembunyikan';
      input.focus();
    };

    const onClear = async () => {
      sessionStorage.removeItem('kaigobiz_api_key');
      syncApiKeyButtonState();
      input.value = '';
      if (clearBtn) clearBtn.style.display = 'none';
      setInlineStatus('API key dihapus dari sesi browser ini.', 'info');
      await checkStatus();
      await fetchTransactions();
    };

    const onSubmit = async (e: Event) => {
      e.preventDefault();
      const trimmed = input.value.trim();
      if (!trimmed) {
        setInlineStatus('Masukkan KAIGOBIZ_API_KEY terlebih dahulu, atau klik Hapus Kunci.', 'error');
        input.focus();
        return;
      }

      if (options?.verifyOnSave) {
        if (saveBtn) saveBtn.disabled = true;
        setInlineStatus('Memeriksa kecocokan API key dengan server...', 'info');
        try {
          const checkRes = await fetch('/api/v1/auth/status', {
            headers: { 'X-API-Key': trimmed },
          });
          if (checkRes.status === 401) {
            if (saveBtn) saveBtn.disabled = false;
            setInlineStatus('API key ditolak server. Periksa nilai KAIGOBIZ_API_KEY di file .env.', 'error');
            input.focus();
            return;
          }
          sessionStorage.setItem('kaigobiz_api_key', trimmed);
          syncApiKeyButtonState();
          setInlineStatus('API key valid dan tersimpan di sesi browser ini.', 'success');
          await checkStatus();
          await fetchTransactions();
          setTimeout(() => closeModal(trimmed), 600);
        } catch {
          if (saveBtn) saveBtn.disabled = false;
          setInlineStatus('Gagal menghubungi server untuk memverifikasi API key.', 'error');
        }
        return;
      }

      sessionStorage.setItem('kaigobiz_api_key', trimmed);
      syncApiKeyButtonState();
      closeModal(trimmed);
    };

    form.addEventListener('submit', onSubmit);
    clearBtn?.addEventListener('click', onClear);
    cancelBtn?.addEventListener('click', onCancel);
    closeBtn?.addEventListener('click', onCancel);
    toggleVisBtn?.addEventListener('click', onToggleVis);
    modal.addEventListener('click', onBackdropClick);
    document.addEventListener('keydown', onKeyDown);
  });

  return await apiKeyModalInFlight;
}

async function promptForApiKey(): Promise<string | null> {
  return await openApiKeyModal({
    reason: 'Server membutuhkan KAIGOBIZ_API_KEY untuk mengakses endpoint admin dan mutasi.',
    statusText: sessionStorage.getItem('kaigobiz_api_key')
      ? 'API key sebelumnya ditolak server. Masukkan kunci terbaru dari file .env.'
      : undefined,
    statusType: 'error',
    verifyOnSave: false,
  });
}

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const buildHeaders = () => {
    const headers = new Headers(init.headers || {});
    const storedKey = sessionStorage.getItem('kaigobiz_api_key');
    if (storedKey) {
      headers.set('X-API-Key', storedKey);
    }
    return headers;
  };

  let res = await fetch(input, { ...init, headers: buildHeaders() });
  if (res.status === 401) {
    try {
      const errBody = await res.clone().json();
      if (errBody?.code === 'API_KEY_REQUIRED') {
        const entered = await promptForApiKey();
        if (entered) {
          res = await fetch(input, { ...init, headers: buildHeaders() });
        }
      }
    } catch {}
  }
  return res;
}

/* ==========================================================================
   Toast Notification System
   ========================================================================== */
function showToast(message: string, type: 'success' | 'error' | 'info' = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.add('show');
  });

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentElement) {
        toast.parentElement.removeChild(toast);
      }
    }, 200);
  }, 3500);
}

/* ==========================================================================
   Tab Navigation (QRIS Studio is default front tab)
   ========================================================================== */
function switchTab(tabId: string) {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.nav-tab');
  const tabPanels = document.querySelectorAll<HTMLElement>('.tab-panel');

  tabButtons.forEach((btn) => {
    const isTarget = btn.getAttribute('data-tab') === tabId;
    btn.classList.toggle('active', isTarget);
    btn.setAttribute('aria-selected', isTarget ? 'true' : 'false');
  });

  tabPanels.forEach((panel) => {
    const isTarget = panel.id === `panel-${tabId}`;
    panel.classList.toggle('active', isTarget);
  });
}

function initTabs() {
  const tabButtons = document.querySelectorAll<HTMLButtonElement>('.nav-tab');

  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      if (tabId) {
        switchTab(tabId);
        window.location.hash = tabId;
      }
    });
  });

  // Check initial hash, default to 'qris'
  const initialHash = window.location.hash.replace('#', '');
  if (['qris', 'transactions', 'session'].includes(initialHash)) {
    switchTab(initialHash);
  } else {
    switchTab('qris');
  }
}

/* ==========================================================================
   System Status & Session Info
   ========================================================================== */
async function checkStatus() {
  const badge = document.getElementById('system-status-badge');
  const badgeText = document.getElementById('system-status-text');
  const sessionStatStatus = document.getElementById('stat-session-status');
  const sessionStatOutlet = document.getElementById('stat-outlet-name');
  const sessionInfoContainer = document.getElementById('session-info-details');

  try {
    const startTime = performance.now();
    const res = await apiFetch('/api/v1/auth/status');
    const latency = Math.round(performance.now() - startTime);

    const latencyEl = document.getElementById('stat-gateway-latency');
    if (latencyEl) {
      latencyEl.textContent = `${latency} ms`;
    }

    const data: AuthStatusResponse = await res.json();
    isSessionConnected = Boolean(data.connected && data.session);

    if (isSessionConnected && data.session) {
      if (badge && badgeText) {
        badge.className = 'status-pill online';
        badgeText.textContent = 'GoBiz Aktif';
      }
      if (sessionStatStatus) sessionStatStatus.textContent = 'Aktif';
      if (sessionStatOutlet) sessionStatOutlet.textContent = data.session.outlet_name || 'Merchant GoBiz';

      if (sessionInfoContainer) {
        const outlet = data.session.outlet_name || 'Merchant GoBiz';
        const owner = data.session.owner_name || '-';
        const phone = data.session.phone_number || '-';
        const merchantId = data.session.merchant_id || '-';
        const address = data.session.outlet_address || '-';
        const kyc = data.session.kyc_status ? `${data.session.kyc_status.toUpperCase()} (Terverifikasi)` : 'Terverifikasi';
        const featureList = (data.session.features || []).map((f: any) => f.product_type || f.product_name).join(', ') || 'GO-PAY STATIC QR';
        const expiresAt = data.session.expires_at
          ? new Date(data.session.expires_at).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' })
          : '-';

        sessionInfoContainer.innerHTML = `
          <div class="session-stat-grid">
            <div class="stat-item">
              <span class="stat-label">Nama Toko / Outlet</span>
              <span class="stat-value" style="color: #38bdf8; font-weight: 700;">${escapeHtml(outlet)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Pemilik Akun</span>
              <span class="stat-value">${escapeHtml(owner)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Merchant ID</span>
              <span class="stat-value" style="font-family: var(--font-mono);">${escapeHtml(merchantId)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Nomor Terdaftar</span>
              <span class="stat-value">${escapeHtml(phone)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Status KYC</span>
              <span class="stat-value" style="color: #34d399;">${escapeHtml(kyc)}</span>
            </div>
            <div class="stat-item">
              <span class="stat-label">Layanan Pembayaran</span>
              <span class="stat-value">${escapeHtml(featureList)}</span>
            </div>
            <div class="stat-item full-width">
              <span class="stat-label">Alamat Outlet</span>
              <span class="stat-value" style="font-size: 12px; font-weight: normal; color: var(--text-muted); line-height: 1.4;">${escapeHtml(address)}</span>
            </div>
            <div class="stat-item full-width">
              <span class="stat-label">Kedaluwarsa Sesi</span>
              <span class="stat-value">${escapeHtml(expiresAt)}</span>
            </div>
          </div>

          <div class="session-actions-row">
            <button type="button" class="btn outline small" id="btn-refresh-session-token">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
              </svg>
              <span>Perbarui Token</span>
            </button>

            <button type="button" class="btn outline small" id="btn-refresh-session-profile">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                <path d="M21 3v5h-5"/>
                <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                <path d="M8 16H3v5"/>
              </svg>
              <span>Segarkan Data GoBiz</span>
            </button>

            <button type="button" class="btn danger-outline small" id="btn-logout-session">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" x2="9" y1="12" y2="12"/>
              </svg>
              <span>Putuskan Sesi</span>
            </button>
          </div>
          ${
            data.health?.rate_limited_until && data.health.rate_limited_until > Date.now()
              ? `<p style="margin-top: 10px; font-size: 12px; color: var(--warning, #fbbf24);">Jeda anti-ban GoBiz aktif sementara hingga ${escapeHtml(new Date(data.health.rate_limited_until).toLocaleTimeString('id-ID'))} untuk melindungi akun.</p>`
              : ''
          }
        `;

        const btnRefreshToken = document.getElementById('btn-refresh-session-token');
        btnRefreshToken?.addEventListener('click', async () => {
          btnRefreshToken.setAttribute('disabled', 'true');
          btnRefreshToken.textContent = 'Memperbarui...';
          try {
            const r = await apiFetch('/api/v1/auth/refresh', { method: 'POST' });
            const d = await r.json();
            if (r.ok && d.success) {
              showToast('Token sesi GoBiz berhasil diperbarui tanpa OTP', 'success');
              await checkStatus();
            } else {
              showToast(d.error || 'Gagal memperbarui token sesi', 'error');
            }
          } catch {
            showToast('Gangguan jaringan saat memperbarui token', 'error');
          } finally {
            btnRefreshToken?.removeAttribute('disabled');
          }
        });

        const btnRefreshProfile = document.getElementById('btn-refresh-session-profile');
        btnRefreshProfile?.addEventListener('click', async () => {
          btnRefreshProfile.setAttribute('disabled', 'true');
          btnRefreshProfile.textContent = 'Menyinkronkan...';
          try {
            const r = await apiFetch('/api/v1/auth/refresh-profile', { method: 'POST' });
            const d = await r.json();
            if (r.ok && d.success) {
              showToast('Data merchant GoBiz berhasil diperbarui', 'success');
              await checkStatus();
            } else {
              showToast(d.error || 'Gagal menyinkronkan profil', 'error');
            }
          } catch {
            showToast('Gangguan jaringan saat menyinkronkan', 'error');
          } finally {
            btnRefreshProfile?.removeAttribute('disabled');
          }
        });

        const btnLogout = document.getElementById('btn-logout-session');
        btnLogout?.addEventListener('click', async () => {
          if (!confirm('Apakah Anda yakin ingin memutuskan sesi GoBiz ini?')) return;
          try {
            const r = await apiFetch('/api/v1/auth/logout', { method: 'POST' });
            if (r.ok) {
              showToast('Sesi GoBiz berhasil diputuskan', 'info');
              await checkStatus();
            }
          } catch {
            showToast('Gagal memutuskan sesi', 'error');
          }
        });
      }
    } else {
      const needsRelogin = Boolean((data as any).needs_relogin);

      if (badge && badgeText) {
        badge.className = needsRelogin ? 'status-pill warning' : 'status-pill offline';
        badgeText.textContent = needsRelogin ? 'Perlu Login Ulang' : 'Belum Terhubung';
      }
      if (sessionStatStatus) sessionStatStatus.textContent = needsRelogin ? 'Sesi Kedaluwarsa' : 'Offline';
      if (sessionStatOutlet) sessionStatOutlet.textContent = needsRelogin ? 'Perlu Login Ulang' : 'Belum Terhubung';

      if (sessionInfoContainer) {
        if (needsRelogin) {
          sessionInfoContainer.innerHTML = `
            <div class="template-banner warning" style="margin: 0 0 16px; border-radius: 8px;">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
              <div class="template-banner-text">
                <strong>Sesi GoBiz Kedaluwarsa</strong><br>
                Token otentikasi sudah tidak valid dan tidak dapat diperbarui otomatis. Silakan login ulang menggunakan nomor GoBiz Anda di formulir di bawah ini.
              </div>
            </div>
            <div class="empty-state" style="padding: 8px 12px;">
              <p style="color: var(--text-muted); font-size: 13px;">
                Masukkan nomor handphone GoBiz Anda untuk menghubungkan ulang akun, atau coba pulihkan sesi dari profil browser terlebih dahulu.
              </p>
              <button type="button" class="btn outline small" id="btn-recover-session-token" style="margin-top: 8px;">
                <span>Coba Pulihkan Tanpa OTP</span>
              </button>
            </div>
          `;

          const btnRecoverToken = document.getElementById('btn-recover-session-token');
          btnRecoverToken?.addEventListener('click', async () => {
            btnRecoverToken.setAttribute('disabled', 'true');
            btnRecoverToken.textContent = 'Memulihkan sesi...';
            try {
              const r = await apiFetch('/api/v1/auth/refresh', { method: 'POST' });
              const d = await r.json();
              if (r.ok && d.success) {
                showToast('Sesi GoBiz berhasil dipulihkan tanpa OTP', 'success');
                await checkStatus();
                await fetchTransactions();
              } else {
                showToast(d.error || 'Sesi tidak dapat dipulihkan otomatis, silakan login via OTP', 'error');
              }
            } catch {
              showToast('Gangguan jaringan saat memulihkan sesi', 'error');
            } finally {
              btnRecoverToken?.removeAttribute('disabled');
            }
          });
        } else {
          sessionInfoContainer.innerHTML = `
            <div class="empty-state" style="padding: 24px 12px;">
              <p style="color: var(--text-muted); font-size: 13px;">
                Sesi merchant GoBiz belum terhubung. Masukkan nomor handphone di formulir sebelah untuk menghubungkan akun GoBiz Anda.
              </p>
            </div>
          `;
        }
      }
    }
  } catch {
    isSessionConnected = false;
    if (badge && badgeText) {
      badge.className = 'status-pill offline';
      badgeText.textContent = 'Server Offline';
    }
    if (sessionStatStatus) sessionStatStatus.textContent = 'Gangguan';
    if (sessionStatOutlet) sessionStatOutlet.textContent = 'Server Offline';

    if (sessionInfoContainer) {
      sessionInfoContainer.innerHTML = `
        <div class="empty-state" style="padding: 24px 12px;">
          <p style="color: var(--danger);">Tidak dapat terhubung ke server API KaiGoBiz.</p>
        </div>
      `;
    }
  }
}

/* ==========================================================================
   Metrics Ribbon (Real Data Only - Zero Mock)
   ========================================================================== */
function updateMetrics() {
  const volumeEl = document.getElementById('stat-total-volume');
  const txCountEl = document.getElementById('stat-tx-count');
  const badgeCountEl = document.getElementById('tx-count-badge');
  const ratioEl = document.getElementById('stat-success-ratio');

  const completed = allTransactions.filter((tx) => tx.status === 'COMPLETED');
  const totalVolume = completed.reduce((sum, tx) => sum + (Number(tx.amount) || 0), 0);

  if (volumeEl) {
    volumeEl.textContent = `Rp ${totalVolume.toLocaleString('id-ID')}`;
  }

  if (txCountEl) {
    txCountEl.textContent = allTransactions.length.toString();
  }

  if (badgeCountEl) {
    badgeCountEl.textContent = allTransactions.length.toString();
  }

  if (ratioEl) {
    ratioEl.textContent = `${completed.length} Berhasil`;
  }
}

/* ==========================================================================
   Transactions Ledger Table & Real Data Rendering
   ========================================================================== */
function renderTransactions() {
  const container = document.getElementById('tx-table-container');
  if (!container) return;

  const filtered = allTransactions.filter((tx) => {
    const matchesFilter = currentFilter === 'ALL' || tx.status === currentFilter;
    const query = searchQuery.toLowerCase();
    const matchesSearch =
      !query ||
      tx.id.toLowerCase().includes(query) ||
      (tx.description && tx.description.toLowerCase().includes(query));
    return matchesFilter && matchesSearch;
  });

  if (filtered.length === 0) {
    const isSearching = searchQuery.trim().length > 0 || currentFilter !== 'ALL';

    if (isSearching) {
      container.innerHTML = `
        <div class="empty-state">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="8"/>
            <path d="m21 21-4.3-4.3"/>
          </svg>
          <p>Tidak ditemukan mutasi yang cocok dengan kriteria pencarian.</p>
        </div>
      `;
      return;
    }

    if (!isSessionConnected) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 40px 24px;">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-dim);" aria-hidden="true">
            <rect width="18" height="18" x="3" y="3" rx="2"/>
            <path d="M9 9h6"/>
            <path d="M9 13h6"/>
            <path d="M9 17h4"/>
          </svg>
          <p style="font-weight: 600; color: var(--text-main); font-size: 15px; margin-top: 4px;">Sesi GoBiz Belum Terhubung</p>
          <p style="max-width: 440px; font-size: 13px; color: var(--text-muted); line-height: 1.6;">
            Mutasi transaksi ditarik langsung secara riil dari akun GoBiz aktif. Masuk ke akun GoBiz Anda pada tab Sesi GoBiz untuk mulai menyinkronkan data mutasi riil.
          </p>
          <button type="button" class="btn primary small" id="btn-goto-session" style="margin-top: 10px;">
            <span>Hubungkan Sesi GoBiz</span>
          </button>
        </div>
      `;
      document.getElementById('btn-goto-session')?.addEventListener('click', () => {
        switchTab('session');
        window.location.hash = 'session';
      });
      return;
    }

    container.innerHTML = `
      <div class="empty-state">
        <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect width="18" height="18" x="3" y="3" rx="2"/>
          <path d="M9 9h6"/>
          <path d="M9 13h6"/>
          <path d="M9 17h4"/>
        </svg>
        <p style="font-weight: 600; color: var(--text-main);">Belum Ada Riwayat Mutasi</p>
        <p style="max-width: 380px; font-size: 13px; color: var(--text-muted);">
          Sesi GoBiz aktif. Mutasi akan muncul secara otomatis saat pembayaran QRIS pelanggan berhasil diterima.
        </p>
      </div>
    `;
    return;
  }

  const rowsHtml = filtered
    .map((tx) => {
      const safeStatus = String(tx.status || 'PENDING').toUpperCase();
      const statusClass = ['completed', 'pending', 'failed'].includes(safeStatus.toLowerCase())
        ? safeStatus.toLowerCase()
        : 'pending';
      const formattedAmount = `Rp ${Number(tx.amount).toLocaleString('id-ID')}`;
      const dateStr = tx.timestamp ? new Date(tx.timestamp).toLocaleString('id-ID') : '-';

      return `
        <tr>
          <td><span class="tx-id">${escapeHtml(tx.id)}</span></td>
          <td><span class="tx-amount">${escapeHtml(formattedAmount)}</span></td>
          <td>${escapeHtml(tx.description || 'GoPay QRIS Payment')}</td>
          <td style="color: var(--text-dim);">${escapeHtml(dateStr)}</td>
          <td><span class="tx-status-badge ${statusClass}">${escapeHtml(safeStatus)}</span></td>
        </tr>
      `;
    })
    .join('');

  container.innerHTML = `
    <table class="tx-table">
      <thead>
        <tr>
          <th>ID Transaksi</th>
          <th>Nominal</th>
          <th>Deskripsi</th>
          <th>Waktu</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
      </tbody>
    </table>
  `;
}

async function fetchTransactions() {
  const container = document.getElementById('tx-table-container');
  const refreshBtn = document.getElementById('refresh-tx-btn');
  const refreshIcon = refreshBtn?.querySelector('.icon-refresh');

  if (refreshBtn) refreshBtn.setAttribute('disabled', 'true');
  if (refreshIcon) refreshIcon.classList.add('spin');

  try {
    const res = await apiFetch('/api/v1/transactions');
    const data = await res.json();
    allTransactions = (data.transactions || []).filter((tx: TransactionItem) => !tx.id.startsWith('tx_reconcile'));
    updateMetrics();
    renderTransactions();
  } catch {
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <p style="color: var(--danger);">Gagal memuat mutasi transaksi. Pastikan koneksi ke server API aktif.</p>
        </div>
      `;
    }
  } finally {
    if (refreshBtn) refreshBtn.removeAttribute('disabled');
    if (refreshIcon) refreshIcon.classList.remove('spin');
  }
}

function initTransactionListeners() {
  const searchInput = document.getElementById('tx-search-input') as HTMLInputElement;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim();
      renderTransactions();
    });
  }

  const filterBtns = document.querySelectorAll<HTMLButtonElement>('.filter-btn');
  filterBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      filterBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-filter') || 'ALL';
      renderTransactions();
    });
  });

  document.getElementById('refresh-tx-btn')?.addEventListener('click', () => {
    fetchTransactions();
  });
}

/* ==========================================================================
   TAB 1: Dynamic QRIS Studio
   ========================================================================== */
function initQrisStudio() {
  const orderInput = document.getElementById('order-id-input') as HTMLInputElement;
  const amountInput = document.getElementById('amount-input') as HTMLInputElement;
  const expirySelect = document.getElementById('expiry-select') as HTMLSelectElement;
  const btnRandomOrder = document.getElementById('btn-random-order');
  const btnGenerate = document.getElementById('btn-generate-qris') as HTMLButtonElement;
  const btnLaunchWidget = document.getElementById('btn-launch-widget');

  const previewOrderLabel = document.getElementById('preview-order-label');
  const previewAmountLabel = document.getElementById('preview-amount-label');
  const previewQrImage = document.getElementById('preview-qr-image') as HTMLImageElement;
  const previewPlaceholder = document.getElementById('preview-qr-placeholder');
  const previewRawString = document.getElementById('preview-raw-string');
  const btnCopyPayload = document.getElementById('btn-copy-payload') as HTMLButtonElement;
  const btnDownloadQr = document.getElementById('btn-download-qr') as HTMLButtonElement;
  const previewStatusTag = document.getElementById('preview-status-tag');
  const previewTimerBadge = document.getElementById('preview-timer-badge');
  const previewTimerText = document.getElementById('preview-timer-text');
  const btnOpenCheckout = document.getElementById('btn-open-checkout') as HTMLAnchorElement;

  // Unique Code Elements
  const uniqueCodeToggle = document.getElementById('unique-code-toggle') as HTMLInputElement;
  const uniqueCodeConfig = document.getElementById('unique-code-config') as HTMLDivElement;
  const uniqueCodeTypeSelect = document.getElementById('unique-code-type') as HTMLSelectElement;
  const uniqueCodeMaxInput = document.getElementById('unique-code-max') as HTMLInputElement;
  const previewUniqueBadge = document.getElementById('preview-unique-badge') as HTMLDivElement;

  uniqueCodeToggle?.addEventListener('change', () => {
    if (uniqueCodeConfig) {
      uniqueCodeConfig.style.display = uniqueCodeToggle.checked ? 'block' : 'none';
    }
  });

  // Template Config Elements
  const templateBadge = document.getElementById('template-status-badge');
  const templateWarning = document.getElementById('template-warning-banner');
  const templateDetailsRow = document.getElementById('template-details-row');
  const tplMerchantName = document.getElementById('tpl-merchant-name');
  const tplMerchantNmid = document.getElementById('tpl-merchant-nmid');
  const tplMerchantCity = document.getElementById('tpl-merchant-city');
  const templateCollapsible = document.getElementById('template-form-collapsible');
  const btnToggleTemplate = document.getElementById('btn-toggle-template-edit');
  const templateStringInput = document.getElementById('template-string-input') as HTMLTextAreaElement;
  const qrisImageFile = document.getElementById('qris-image-file') as HTMLInputElement;
  const btnUploadQrImg = document.getElementById('btn-upload-qr-img');
  const btnSaveTemplate = document.getElementById('btn-save-template');

  async function loadTemplateInfo() {
    try {
      const res = await apiFetch('/api/v1/payment/template');
      const data = await res.json();
      if (!res.ok || !data.success) return;

      const isDefault = data.isDefault;
      const details = data.details || {};

      if (templateBadge) {
        if (isDefault) {
          templateBadge.className = 'template-badge dummy';
          templateBadge.textContent = 'Template Bawaan (Dummy)';
        } else {
          templateBadge.className = 'template-badge verified';
          templateBadge.textContent = 'QRIS Merchant Terverifikasi';
        }
      }

      if (templateWarning) {
        templateWarning.style.display = isDefault ? 'flex' : 'none';
      }

      if (templateDetailsRow) {
        if (!isDefault && details.merchantName) {
          templateDetailsRow.style.display = 'flex';
          if (tplMerchantName) tplMerchantName.textContent = `Merchant: ${details.merchantName}`;
          if (tplMerchantNmid) tplMerchantNmid.textContent = `NMID: ${details.nmid || '-'}`;
          if (tplMerchantCity) tplMerchantCity.textContent = `Kota: ${details.merchantCity || '-'}`;
        } else {
          templateDetailsRow.style.display = 'none';
        }
      }

      if (templateStringInput && !templateStringInput.value) {
        templateStringInput.value = data.template || '';
      }
    } catch {
      // ignore network errors
    }
  }

  btnToggleTemplate?.addEventListener('click', () => {
    if (!templateCollapsible) return;
    const isHidden = templateCollapsible.style.display === 'none' || !templateCollapsible.style.display;
    templateCollapsible.style.display = isHidden ? 'block' : 'none';
    if (btnToggleTemplate) {
      btnToggleTemplate.textContent = isHidden ? 'Tutup Formulir' : 'Ganti / Perbarui';
    }
  });

  /**
   * Decodes QR code using HTML5 Canvas & jsQR directly in browser (reference: verssache/qris-dinamis)
   */
  async function decodeImageWithCanvas(file: File): Promise<string | null> {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onerror = () => resolve(null);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(null);
        img.onload = () => {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) return resolve(null);

          // Pass 1: Original size
          canvas.width = img.naturalWidth || img.width;
          canvas.height = img.naturalHeight || img.height;
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          try {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, canvas.width, canvas.height, {
              inversionAttempts: 'attemptBoth',
            });
            if (code && code.data) {
              const raw = code.data.trim();
              const idx = raw.indexOf('000201');
              return resolve(idx !== -1 ? raw.substring(idx) : raw);
            }
          } catch {}

          // Pass 2: Downscale if large (> 1200px)
          const maxDim = Math.max(canvas.width, canvas.height);
          if (maxDim > 1200) {
            const scale = 1000 / maxDim;
            canvas.width = Math.floor((img.naturalWidth || img.width) * scale);
            canvas.height = Math.floor((img.naturalHeight || img.height) * scale);
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            try {
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(imageData.data, canvas.width, canvas.height, {
                inversionAttempts: 'attemptBoth',
              });
              if (code && code.data) {
                const raw = code.data.trim();
                const idx = raw.indexOf('000201');
                return resolve(idx !== -1 ? raw.substring(idx) : raw);
              }
            } catch {}
          }

          // Pass 3: Center crop for phone screenshots
          const w = canvas.width;
          const h = canvas.height;
          if (h > 1.2 * w) {
            canvas.width = w;
            canvas.height = Math.floor(h * 0.6);
            ctx.drawImage(img, 0, Math.floor(h * 0.15), w, canvas.height, 0, 0, w, canvas.height);
            try {
              const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const code = jsQR(imageData.data, canvas.width, canvas.height, {
                inversionAttempts: 'attemptBoth',
              });
              if (code && code.data) {
                const raw = code.data.trim();
                const idx = raw.indexOf('000201');
                return resolve(idx !== -1 ? raw.substring(idx) : raw);
              }
            } catch {}
          }

          resolve(null);
        };
        img.src = reader.result as string;
      };
      reader.readAsDataURL(file);
    });
  }

  async function processQrFile(file: File) {
    const origBtnHtml = btnUploadQrImg?.innerHTML || '';
    if (btnUploadQrImg) {
      btnUploadQrImg.setAttribute('disabled', 'true');
      btnUploadQrImg.innerHTML = '<span class="loading-spinner-inline" aria-hidden="true"></span> Memindai QR...';
    }

    try {
      // 1. Primary Engine: Client-Side HTML5 Canvas + jsQR (exact same approach as verssache/qris-dinamis)
      const clientQr = await decodeImageWithCanvas(file);
      if (clientQr && clientQr.length > 20) {
        if (templateStringInput) templateStringInput.value = clientQr;
        if (templateCollapsible) {
          templateCollapsible.style.display = 'block';
          if (btnToggleTemplate) btnToggleTemplate.textContent = 'Tutup Formulir';
        }
        showToast('QRIS berhasil dideteksi langsung di browser! Klik Simpan & Aktifkan.', 'success');
        if (btnUploadQrImg) {
          btnUploadQrImg.removeAttribute('disabled');
          btnUploadQrImg.innerHTML = origBtnHtml;
        }
        return;
      }

      // 2. Hardware-accelerated BarcodeDetector (Chrome/Android MLKit)
      if ('BarcodeDetector' in window) {
        try {
          const barcodeDetector = new (window as any).BarcodeDetector({ formats: ['qr_code'] });
          const imgBitmap = await createImageBitmap(file);
          const detected = await barcodeDetector.detect(imgBitmap);
          if (detected && detected.length > 0) {
            const rawVal = detected[0].rawValue || '';
            const idx = rawVal.indexOf('000201');
            const candidate = idx !== -1 ? rawVal.substring(idx) : rawVal;
            if (candidate && candidate.length > 20) {
              if (templateStringInput) templateStringInput.value = candidate;
              if (templateCollapsible) {
                templateCollapsible.style.display = 'block';
                if (btnToggleTemplate) btnToggleTemplate.textContent = 'Tutup Formulir';
              }
              showToast('QRIS berhasil dideteksi dari perangkat! Klik Simpan & Aktifkan.', 'success');
              if (btnUploadQrImg) {
                btnUploadQrImg.removeAttribute('disabled');
                btnUploadQrImg.innerHTML = origBtnHtml;
              }
              return;
            }
          }
        } catch {}
      }

      // 3. Fallback: Server-Side Multi-Engine (ZXing-CPP, PyZBar, OpenCV, pdftoppm)
      const reader = new FileReader();
      reader.onload = async () => {
        const imageBase64 = reader.result as string;
        try {
          const res = await apiFetch('/api/v1/payment/decode-qr', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imageBase64 }),
          });
          const result = await res.json();
          const decodedQr = result.qrString || result.qrisString;
          if (res.ok && result.success && decodedQr) {
            if (templateStringInput) {
              templateStringInput.value = decodedQr;
            }
            if (templateCollapsible) {
              templateCollapsible.style.display = 'block';
              if (btnToggleTemplate) btnToggleTemplate.textContent = 'Tutup Formulir';
            }
            const merchant = result.details?.merchantName ? ` (${result.details.merchantName})` : '';
            showToast(`QRIS berhasil dideteksi${merchant}! Klik Simpan & Aktifkan.`, 'success');
          } else {
            showToast(result.error || 'Gagal membaca kode QR dari gambar tersebut', 'error');
          }
        } catch {
          showToast('Terjadi kesalahan saat menghubungi server untuk memproses gambar QR', 'error');
        } finally {
          if (btnUploadQrImg) {
            btnUploadQrImg.removeAttribute('disabled');
            btnUploadQrImg.innerHTML = origBtnHtml;
          }
          if (qrisImageFile) qrisImageFile.value = '';
        }
      };
      reader.readAsDataURL(file);
    } catch {
      showToast('Gagal memproses file gambar QR', 'error');
      if (btnUploadQrImg) {
        btnUploadQrImg.removeAttribute('disabled');
        btnUploadQrImg.innerHTML = origBtnHtml;
      }
    }
  }

  btnUploadQrImg?.addEventListener('click', () => {
    qrisImageFile?.click();
  });

  qrisImageFile?.addEventListener('change', () => {
    const file = qrisImageFile.files?.[0];
    if (file) {
      processQrFile(file);
    }
  });

  // Support Drag & Drop directly onto the textarea or collapsible container
  const dropTargets = [templateStringInput, templateCollapsible].filter(Boolean) as HTMLElement[];
  dropTargets.forEach((target) => {
    target.addEventListener('dragover', (e) => {
      e.preventDefault();
      target.style.outline = '2px dashed var(--primary, #3b82f6)';
    });
    target.addEventListener('dragleave', () => {
      target.style.outline = '';
    });
    target.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      target.style.outline = '';
      const file = e.dataTransfer?.files?.[0];
      if (file) {
        showToast('File QR terdeteksi dari drag & drop, memindai...', 'info');
        processQrFile(file);
      }
    });
  });

  // Support pasting screenshot/image from clipboard (Ctrl+V) anywhere on the page
  window.addEventListener('paste', (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image') !== -1) {
        const file = items[i].getAsFile();
        if (file) {
          showToast('Gambar QR terdeteksi dari papan klip (clipboard), memindai...', 'info');
          processQrFile(file);
          break;
        }
      }
    }
  });

  btnSaveTemplate?.addEventListener('click', async () => {
    const templateVal = templateStringInput?.value.trim();
    if (!templateVal) {
      showToast('Masukkan string QRIS statis terlebih dahulu', 'error');
      return;
    }

    const origSaveText = btnSaveTemplate.textContent;
    btnSaveTemplate.setAttribute('disabled', 'true');
    btnSaveTemplate.textContent = 'Menyimpan...';

    try {
      const res = await apiFetch('/api/v1/payment/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ template: templateVal }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        showToast(data.message || 'Template QRIS berhasil diaktifkan', 'success');
        if (templateCollapsible) templateCollapsible.style.display = 'none';
        if (btnToggleTemplate) btnToggleTemplate.textContent = 'Ganti / Perbarui';
        await loadTemplateInfo();
      } else {
        showToast(data.error || 'Gagal menyimpan template QRIS', 'error');
      }
    } catch {
      showToast('Gagal menghubungi server untuk menyimpan template', 'error');
    } finally {
      btnSaveTemplate.removeAttribute('disabled');
      btnSaveTemplate.textContent = origSaveText;
    }
  });

  loadTemplateInfo();

  function generateRandomOrderId() {
    const timestamp = Date.now().toString().slice(-6);
    const rand = Math.floor(1000 + Math.random() * 9000);
    return `INV-${timestamp}-${rand}`;
  }

  // Set initial Order ID
  if (orderInput && !orderInput.value) {
    orderInput.value = generateRandomOrderId();
  }

  btnRandomOrder?.addEventListener('click', () => {
    if (orderInput) orderInput.value = generateRandomOrderId();
  });

  document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach((btn) => {
    btn.addEventListener('click', () => {
      const amount = btn.getAttribute('data-amount');
      if (amountInput && amount) {
        amountInput.value = amount;
      }
    });
  });

  function clearActivePaymentTimers() {
    if (activeCountdownInterval) {
      clearInterval(activeCountdownInterval);
      activeCountdownInterval = null;
    }
    if (activePollInterval) {
      clearInterval(activePollInterval);
      activePollInterval = null;
    }
  }

  function handlePaymentExpired() {
    clearActivePaymentTimers();
    localStorage.removeItem('kaigobiz_active_payment');

    if (previewStatusTag) {
      previewStatusTag.className = 'status-tag expired';
      previewStatusTag.textContent = 'Kedaluwarsa';
    }
    if (previewTimerBadge) {
      previewTimerBadge.style.display = 'none';
    }
    if (previewQrImage && previewPlaceholder) {
      previewQrImage.classList.remove('visible');
      previewPlaceholder.classList.remove('hidden');
      previewPlaceholder.innerHTML = `
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--danger);" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <line x1="12" y1="8" x2="12" y2="12"/>
          <line x1="12" y1="16" x2="12.01" y2="16"/>
        </svg>
        <span style="color: var(--danger); font-weight: 700;">Waktu Pembayaran Habis</span>
        <span style="font-size: 11px; color: var(--text-dim);">Kode QR telah kedaluwarsa otomatis</span>
      `;
    }
    if (btnDownloadQr) btnDownloadQr.setAttribute('disabled', 'true');
    if (btnCopyPayload) btnCopyPayload.setAttribute('disabled', 'true');
    if (btnOpenCheckout) btnOpenCheckout.style.display = 'none';
  }

  function handlePaymentPaid(data: any) {
    clearActivePaymentTimers();
    localStorage.removeItem('kaigobiz_active_payment');

    if (previewStatusTag) {
      previewStatusTag.className = 'status-tag paid';
      previewStatusTag.textContent = 'Berhasil Dibayar';
    }
    if (previewTimerBadge) {
      previewTimerBadge.style.display = 'none';
    }
    showToast(`Pembayaran Sukses: Order ${data.orderId || 'transaksi'} telah terverifikasi!`, 'success');
    fetchTransactions();
  }

  function startCountdown(expiresAtStr: string) {
    if (previewTimerBadge) previewTimerBadge.style.display = 'inline-flex';

    function tick() {
      const expiresTime = new Date(expiresAtStr).getTime();
      const diff = Math.max(0, Math.floor((expiresTime - Date.now()) / 1000));

      if (diff <= 0) {
        if (previewTimerText) previewTimerText.textContent = '00:00';
        handlePaymentExpired();
        return;
      }

      const mins = Math.floor(diff / 60).toString().padStart(2, '0');
      const secs = (diff % 60).toString().padStart(2, '0');
      if (previewTimerText) previewTimerText.textContent = `${mins}:${secs}`;

      if (diff <= 60) {
        previewTimerBadge?.classList.add('urgent');
      } else {
        previewTimerBadge?.classList.remove('urgent');
      }
    }

    tick();
    activeCountdownInterval = setInterval(tick, 1000);
  }

  function startStatusPolling(paymentId: string) {
    let pollInFlight = false;
    activePollInterval = setInterval(async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        const res = await apiFetch(`/api/v1/payment/status/${encodeURIComponent(paymentId)}`);
        const data = await res.json();
        if (data.status === 'PAID') {
          handlePaymentPaid(data);
        } else if (data.status === 'EXPIRED') {
          handlePaymentExpired();
        }
      } catch {} finally {
        pollInFlight = false;
      }
    }, 2500);
  }

  function displayPaymentInPreview(payment: {
    paymentId: string;
    orderId: string;
    amount: number;
    rawAmount?: number;
    uniqueCode?: number;
    qrisString: string;
    qrisQrUrl: string;
    expiresAt: string;
    status?: string;
  }) {
    clearActivePaymentTimers();

    currentQrisPayload = payment.qrisString;
    currentQrisDataUrl = payment.qrisQrUrl;

    if (previewOrderLabel) previewOrderLabel.textContent = payment.orderId;
    if (previewAmountLabel) previewAmountLabel.textContent = `Rp ${Number(payment.amount).toLocaleString('id-ID')}`;

    if (previewUniqueBadge) {
      if (payment.uniqueCode && payment.uniqueCode > 0) {
        const raw = payment.rawAmount || payment.amount;
        const sign = payment.amount > raw ? '+' : '-';
        previewUniqueBadge.style.display = 'inline-block';
        previewUniqueBadge.textContent = `Termasuk kode unik ${sign}${payment.uniqueCode} (Nominal dasar: Rp ${Number(raw).toLocaleString('id-ID')})`;
      } else {
        previewUniqueBadge.style.display = 'none';
      }
    }

    if (previewStatusTag) {
      previewStatusTag.className = 'status-tag pending';
      previewStatusTag.textContent = 'Siap Dipindai';
    }

    if (previewQrImage && previewPlaceholder) {
      previewQrImage.src = payment.qrisQrUrl;
      previewQrImage.classList.add('visible');
      previewPlaceholder.classList.add('hidden');
    }

    if (previewRawString) {
      previewRawString.textContent = payment.qrisString;
    }

    if (btnCopyPayload) btnCopyPayload.removeAttribute('disabled');
    if (btnDownloadQr) btnDownloadQr.removeAttribute('disabled');

    if (btnOpenCheckout) {
      btnOpenCheckout.href = `/pay/${encodeURIComponent(payment.paymentId)}`;
      btnOpenCheckout.style.display = 'inline-flex';
    }

    // Persist to localStorage so page refresh will not lose the active QR
    localStorage.setItem(
      'kaigobiz_active_payment',
      JSON.stringify({
        paymentId: payment.paymentId,
        orderId: payment.orderId,
        amount: payment.amount,
        rawAmount: payment.rawAmount,
        uniqueCode: payment.uniqueCode,
        qrisString: payment.qrisString,
        qrisQrUrl: payment.qrisQrUrl,
        expiresAt: payment.expiresAt,
      })
    );

    startCountdown(payment.expiresAt);
    startStatusPolling(payment.paymentId);
  }

  async function restoreActivePaymentFromStorage() {
    try {
      const raw = localStorage.getItem('kaigobiz_active_payment');
      if (!raw) return;

      const saved = JSON.parse(raw);
      if (!saved || !saved.paymentId || !saved.expiresAt) return;

      const expiresTime = new Date(saved.expiresAt).getTime();
      if (expiresTime <= Date.now()) {
        localStorage.removeItem('kaigobiz_active_payment');
        return;
      }

      // Verify status with server
      const res = await apiFetch(`/api/v1/payment/status/${encodeURIComponent(saved.paymentId)}`);
      const data = await res.json();

      if (data.status === 'PAID') {
        localStorage.removeItem('kaigobiz_active_payment');
        return;
      }

      if (data.status === 'EXPIRED') {
        localStorage.removeItem('kaigobiz_active_payment');
        return;
      }

      // If still pending, restore preview and countdown!
      displayPaymentInPreview({
        paymentId: saved.paymentId,
        orderId: data.orderId || saved.orderId,
        amount: data.amount || saved.amount,
        rawAmount: data.rawAmount || saved.rawAmount,
        uniqueCode: data.uniqueCode || saved.uniqueCode,
        qrisString: data.qrisString || saved.qrisString,
        qrisQrUrl: data.qrisQrUrl || saved.qrisQrUrl,
        expiresAt: data.expiresAt || saved.expiresAt,
      });
    } catch {}
  }

  const paymentForm = document.getElementById('create-payment-form') as HTMLFormElement;
  paymentForm?.addEventListener('submit', async (e) => {
    e.preventDefault();

    const orderId = orderInput?.value.trim() || generateRandomOrderId();
    const amount = Number(amountInput?.value);
    const expiry = Number(expirySelect?.value) || 5;
    const useUniqueCode = uniqueCodeToggle?.checked ?? false;
    const uniqueCodeType = (uniqueCodeTypeSelect?.value as 'ADD' | 'SUBTRACT') || 'ADD';
    const uniqueCodeMax = Number(uniqueCodeMaxInput?.value) || 250;

    if (!amount || amount <= 0) {
      showToast('Nominal harus lebih besar dari Rp 0', 'error');
      return;
    }

    if (btnGenerate) {
      btnGenerate.disabled = true;
      btnGenerate.innerHTML = '<span class="loading-spinner-inline" aria-hidden="true"></span> Menghasilkan QRIS...';
    }

    try {
      const res = await apiFetch('/api/v1/payment/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          amount,
          expiryMinutes: expiry,
          useUniqueCode,
          uniqueCodeMax,
          uniqueCodeType,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        displayPaymentInPreview({
          paymentId: data.paymentId,
          orderId: data.orderId,
          amount: data.amount,
          rawAmount: data.rawAmount,
          uniqueCode: data.uniqueCode,
          qrisString: data.qrisString,
          qrisQrUrl: data.qrisQrUrl,
          expiresAt: data.expiresAt,
        });

        const codeInfo = data.uniqueCode ? ` (Kode Unik: ${data.amount > data.rawAmount ? '+' : '-'}${data.uniqueCode})` : '';
        showToast(`QRIS dinamis berhasil dibuat untuk order ${data.orderId}${codeInfo}`, 'success');
      } else {
        showToast(data.error || 'Gagal menghasilkan QRIS', 'error');
      }
    } catch {
      showToast('Terjadi gangguan jaringan saat membuat QRIS', 'error');
    } finally {
      if (btnGenerate) {
        btnGenerate.disabled = false;
        btnGenerate.innerHTML = `
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect width="5" height="5" x="3" y="3" rx="1"/>
            <rect width="5" height="5" x="16" y="3" rx="1"/>
            <rect width="5" height="5" x="3" y="16" rx="1"/>
            <path d="M21 16h-3a2 2 0 0 0-2 2v3"/>
            <path d="M12 7v3a2 2 0 0 1-2 2H7"/>
          </svg>
          <span>Generate &amp; Perbarui Preview</span>
        `;
      }
    }
  });

  btnCopyPayload?.addEventListener('click', async () => {
    if (!currentQrisPayload) return;
    const ok = await copyTextToClipboard(currentQrisPayload);
    if (ok) {
      showToast('Payload string EMVCo berhasil disalin ke papan klip', 'success');
    } else {
      showToast('Gagal menyalin ke papan klip', 'error');
    }
  });

  btnDownloadQr?.addEventListener('click', () => {
    if (!currentQrisDataUrl) return;
    const link = document.createElement('a');
    link.download = `qris-${orderInput?.value.trim() || 'payment'}.png`;
    link.href = currentQrisDataUrl;
    link.click();
    showToast('Kode QRIS berhasil diunduh sebagai gambar PNG', 'success');
  });

  btnLaunchWidget?.addEventListener('click', () => {
    const orderId = orderInput?.value.trim() || generateRandomOrderId();
    const amount = Number(amountInput?.value);
    const expiry = Number(expirySelect?.value) || 5;
    const useUniqueCode = uniqueCodeToggle?.checked ?? false;
    const uniqueCodeType = (uniqueCodeTypeSelect?.value as 'ADD' | 'SUBTRACT') || 'ADD';
    const uniqueCodeMax = Number(uniqueCodeMaxInput?.value) || 250;

    if (!amount || amount <= 0) {
      showToast('Masukkan nominal pembayaran yang valid terlebih dahulu', 'error');
      return;
    }

    KaiGoBiz.checkout({
      endpoint: window.location.origin,
      orderId,
      amount,
      expiryMinutes: expiry,
      useUniqueCode,
      uniqueCodeMax,
      uniqueCodeType,
      onSuccess: (res) => {
        showToast(`Pembayaran Sukses: Order ${res.orderId || orderId}`, 'success');
        fetchTransactions();
      },
      onExpired: () => {
        showToast('Masa berlaku pembayaran telah berakhir', 'info');
      },
      onError: (err) => {
        showToast(`Gagal memproses widget: ${err.error || 'Terjadi kesalahan'}`, 'error');
      },
    });
  });

  // Restore any pending payment upon load/refresh so QR and countdown do not disappear
  restoreActivePaymentFromStorage();
}

/* ==========================================================================
   TAB 3: GoBiz Session & OTP Authentication
   ========================================================================== */
function initSessionTab() {
  const otpMessage = document.getElementById('otp-message');
  const otpRequestForm = document.getElementById('otp-request-form') as HTMLFormElement;
  const otpVerifyForm = document.getElementById('otp-verify-form') as HTMLFormElement;
  const phoneInput = document.getElementById('phone-input') as HTMLInputElement;
  const otpInput = document.getElementById('otp-input') as HTMLInputElement;
  const btnRequestOtp = document.getElementById('btn-request-otp') as HTMLButtonElement;
  const btnVerifyOtp = document.getElementById('btn-verify-otp') as HTMLButtonElement;
  const btnCancelOtp = document.getElementById('btn-cancel-otp');

  function showOtpMessage(text: string, type: 'info' | 'error' | 'success') {
    if (otpMessage) {
      otpMessage.className = `message-banner ${type}`;
      otpMessage.textContent = text;
      otpMessage.style.display = 'block';
    }
  }

  function hideOtpMessage() {
    if (otpMessage) {
      otpMessage.style.display = 'none';
    }
  }

  otpRequestForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideOtpMessage();

    const phone = phoneInput?.value.trim();
    if (!phone) {
      showOtpMessage('Nomor handphone wajib diisi', 'error');
      return;
    }

    if (btnRequestOtp) {
      btnRequestOtp.disabled = true;
      btnRequestOtp.innerHTML = '<span class="loading-spinner-inline" aria-hidden="true"></span> Memproses pengiriman OTP...';
    }

    try {
      const res = await apiFetch('/api/v1/auth/request-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });

      const data = await res.json();

      if (res.ok && data.success && data.alreadyAuthenticated) {
        showToast(data.message || 'Sesi GoBiz dipulihkan tanpa OTP', 'success');
        showOtpMessage(data.message || 'Sesi GoBiz berhasil dipulihkan dari profil browser tanpa perlu OTP.', 'success');
        if (otpVerifyForm) otpVerifyForm.style.display = 'none';
        if (otpInput) otpInput.value = '';
        await checkStatus();
        await fetchTransactions();
      } else if (res.ok && data.success && data.otpToken) {
        currentOtpToken = data.otpToken;
        currentPhone = phone;
        const channelText = data.channel ? ` melalui ${data.channel}` : '';
        const lengthText = data.otpLength ? ` (${data.otpLength} digit)` : '';
        showOtpMessage(`Kode OTP telah dikirimkan${channelText} ke nomor ${phone}${lengthText}. Masukkan kode verifikasi pada kolom berikut.`, 'success');
        if (otpInput && data.otpLength) {
          otpInput.placeholder = data.otpLength === 4 ? '1911' : '123456';
          otpInput.minLength = data.otpLength;
          otpInput.maxLength = data.otpLength;
        }
        if (otpVerifyForm) otpVerifyForm.style.display = 'block';
        if (otpInput) otpInput.focus();
      } else {
        showOtpMessage(data.error || 'Gagal mengirimkan kode OTP', 'error');
      }
    } catch {
      showOtpMessage('Terjadi gangguan jaringan saat menghubungi server autentikasi', 'error');
    } finally {
      if (btnRequestOtp) {
        btnRequestOtp.disabled = false;
        btnRequestOtp.innerHTML = '<span>Minta Kode OTP</span>';
      }
    }
  });

  otpVerifyForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideOtpMessage();

    const otp = otpInput?.value.trim();
    if (!otp || otp.length < 4 || otp.length > 6) {
      showOtpMessage('Masukkan kode OTP yang valid (4-6 digit angka)', 'error');
      return;
    }

    if (btnVerifyOtp) {
      btnVerifyOtp.disabled = true;
      btnVerifyOtp.innerHTML = '<span class="loading-spinner-inline" aria-hidden="true"></span> Memverifikasi sesi...';
    }

    try {
      const res = await apiFetch('/api/v1/auth/verify-otp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: currentPhone,
          otp,
          otpToken: currentOtpToken,
        }),
      });

      const data = await res.json();

      if (res.ok && data.success) {
        showToast('Sesi merchant GoBiz berhasil terhubung dan tersimpan', 'success');
        showOtpMessage('Sesi GoBiz berhasil terverifikasi dan aktif.', 'success');
        if (otpVerifyForm) otpVerifyForm.style.display = 'none';
        if (otpInput) otpInput.value = '';
        await checkStatus();
        await fetchTransactions();
      } else {
        showOtpMessage(data.error || 'Verifikasi OTP tidak berhasil. Periksa kembali kode Anda.', 'error');
      }
    } catch {
      showOtpMessage('Terjadi gangguan jaringan saat memverifikasi kode OTP', 'error');
    } finally {
      if (btnVerifyOtp) {
        btnVerifyOtp.disabled = false;
        btnVerifyOtp.innerHTML = '<span>Verifikasi &amp; Simpan Sesi</span>';
      }
    }
  });

  btnCancelOtp?.addEventListener('click', () => {
    if (otpVerifyForm) otpVerifyForm.style.display = 'none';
    hideOtpMessage();
  });
}

/* ==========================================================================
   Header Utilities (Copy Widget Script Tag)
   ========================================================================== */
async function copyTextToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    textArea.setAttribute('readonly', '');
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    if (successful) return true;
  } catch {}

  return false;
}

function initHeaderControls() {
  const copyBtn = document.getElementById('copy-widget-url-btn');
  copyBtn?.addEventListener('click', async () => {
    const scriptTag = `<script src="${window.location.origin}/kaigobiz.js"></script>`;
    const ok = await copyTextToClipboard(scriptTag);
    if (ok) {
      showToast('Tag script widget <script> berhasil disalin', 'success');
    } else {
      showToast('Gagal menyalin tag script. Silakan salin manual: ' + scriptTag, 'error');
    }
  });

  syncApiKeyButtonState();
  const apiKeyBtn = document.getElementById('api-key-config-btn');
  apiKeyBtn?.addEventListener('click', async () => {
    await openApiKeyModal({ verifyOnSave: true });
  });
}

/* ==========================================================================
   Initialization
   ========================================================================== */
document.addEventListener('DOMContentLoaded', async () => {
  initTabs();
  initHeaderControls();
  initTransactionListeners();
  initQrisStudio();
  initSessionTab();

  await checkStatus();
  await fetchTransactions();
});

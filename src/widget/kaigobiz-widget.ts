import './widget-style.css';

export interface CheckoutOptions {
  endpoint: string;
  orderId: string;
  amount: number;
  callbackUrl?: string;
  expiryMinutes?: number;
  useUniqueCode?: boolean;
  uniqueCodeMin?: number;
  uniqueCodeMax?: number;
  uniqueCodeType?: 'ADD' | 'SUBTRACT';
  onSuccess?: (res: any) => void;
  onPending?: (res: any) => void;
  onExpired?: () => void;
  onError?: (err: any) => void;
}

export class KaiGoBiz {
  static async checkout(options: CheckoutOptions) {
    try {
      const baseEndpoint = (options.endpoint || '').replace(/\/+$/, '');
      const res = await fetch(`${baseEndpoint}/api/v1/payment/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: options.orderId,
          amount: options.amount,
          callbackUrl: options.callbackUrl,
          expiryMinutes: options.expiryMinutes,
          useUniqueCode: options.useUniqueCode,
          uniqueCodeMin: options.uniqueCodeMin,
          uniqueCodeMax: options.uniqueCodeMax,
          uniqueCodeType: options.uniqueCodeType,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        if (options.onError) options.onError(data);
        return;
      }

      KaiGoBiz.showModal(data, options, baseEndpoint);
    } catch (err) {
      if (options.onError) options.onError(err);
    }
  }

  private static showModal(paymentData: any, options: CheckoutOptions, endpoint: string) {
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let timerInterval: ReturnType<typeof setInterval> | null = null;

    const overlay = document.createElement('div');
    overlay.className = 'kaigobiz-modal-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'kaigobiz-modal-title');

    overlay.innerHTML = `
      <div class="kaigobiz-modal-card">
        <div class="kaigobiz-modal-header">
          <h3 id="kaigobiz-modal-title" class="kaigobiz-title">Pembayaran QRIS</h3>
          <span id="kaigobiz-order-id" class="kaigobiz-order-id"></span>
        </div>
        <div class="kaigobiz-amount">Rp ${Number(paymentData.amount).toLocaleString('id-ID')}</div>
        <div class="kaigobiz-qr-box">
          <img src="${paymentData.qrisQrUrl}" alt="Kode QRIS Pembayaran" width="200" height="200" style="display:block;" />
        </div>
        <p class="kaigobiz-instructions">Pindai kode QRIS di atas dengan aplikasi perbankan atau dompet digital Anda.</p>
        <div class="kaigobiz-timer-box">
          <span class="kaigobiz-timer-label">Sisa Waktu</span>
          <span class="kaigobiz-timer" id="kaigobiz-timer">05:00</span>
        </div>
        <button id="kaigobiz-close-btn" class="kaigobiz-close-button" type="button">Tutup Pembayaran</button>
      </div>
    `;

    // Safely assign text content to prevent XSS
    const orderIdEl = overlay.querySelector('#kaigobiz-order-id');
    if (orderIdEl) {
      orderIdEl.textContent = `Order: ${paymentData.orderId}`;
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeModal();
      }
    };

    const closeModal = () => {
      window.removeEventListener('keydown', onKeyDown);
      if (pollInterval) clearInterval(pollInterval);
      if (timerInterval) clearInterval(timerInterval);
      if (overlay.parentNode) {
        overlay.parentNode.removeChild(overlay);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector('#kaigobiz-close-btn') as HTMLButtonElement | null;
    closeBtn?.addEventListener('click', closeModal);
    closeBtn?.focus();

    const expiresAt = new Date(paymentData.expiresAt).getTime();
    const timerEl = overlay.querySelector('#kaigobiz-timer');

    timerInterval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
      const secs = String(remaining % 60).padStart(2, '0');
      if (timerEl) timerEl.textContent = `${mins}:${secs}`;

      if (remaining <= 0) {
        closeModal();
        if (options.onExpired) options.onExpired();
      }
    }, 1000);

    pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch(`${endpoint}/api/v1/payment/status/${paymentData.paymentId}`);
        const statusData = await statusRes.json();
        if (statusData.status === 'PAID') {
          closeModal();
          if (options.onSuccess) options.onSuccess(statusData);
        } else if (statusData.status === 'EXPIRED') {
          closeModal();
          if (options.onExpired) options.onExpired();
        }
      } catch {
        // Network polling error; retry next interval
      }
    }, 3000);
  }
}

// Global window attachment for UMD/Script tag
if (typeof window !== 'undefined') {
  (window as any).KaiGoBiz = KaiGoBiz;
}

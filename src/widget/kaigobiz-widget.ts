import './widget-style.css';

export interface CheckoutOptions {
  endpoint: string;
  orderId: string;
  amount: number;
  onSuccess?: (res: any) => void;
  onPending?: (res: any) => void;
  onExpired?: () => void;
  onError?: (err: any) => void;
}

export class KaiGoBiz {
  static async checkout(options: CheckoutOptions) {
    try {
      const res = await fetch(`${options.endpoint}/api/v1/payment/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: options.orderId,
          amount: options.amount,
        }),
      });

      const data = await res.json();
      if (!data.success) {
        if (options.onError) options.onError(data);
        return;
      }

      KaiGoBiz.showModal(data, options);
    } catch (err) {
      if (options.onError) options.onError(err);
    }
  }

  private static showModal(paymentData: any, options: CheckoutOptions) {
    const overlay = document.createElement('div');
    overlay.className = 'kaigobiz-modal-overlay';
    overlay.innerHTML = `
      <div class="kaigobiz-modal-card">
        <h3 style="margin:0;font-size:18px;">Pembayaran QRIS</h3>
        <p style="margin:4px 0;font-size:12px;color:#94a3b8;">Order: ${paymentData.orderId}</p>
        <div class="kaigobiz-amount">Rp ${Number(paymentData.amount).toLocaleString('id-ID')}</div>
        <div class="kaigobiz-qr-box">
          <img src="${paymentData.qrisQrUrl}" alt="QRIS QR Code" style="width:200px;height:200px;display:block;" />
        </div>
        <div class="kaigobiz-timer" id="kaigobiz-timer">Batas Waktu: 05:00</div>
        <button id="kaigobiz-close-btn" style="margin-top:16px;background:#334155;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;">Batal</button>
      </div>
    `;

    document.body.appendChild(overlay);

    const closeBtn = overlay.querySelector('#kaigobiz-close-btn');
    closeBtn?.addEventListener('click', () => {
      clearInterval(pollInterval);
      clearInterval(timerInterval);
      document.body.removeChild(overlay);
    });

    // Timer countdown
    const expiresAt = new Date(paymentData.expiresAt).getTime();
    const timerEl = overlay.querySelector('#kaigobiz-timer');

    const timerInterval = setInterval(() => {
      const remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
      const mins = String(Math.floor(remaining / 60)).padStart(2, '0');
      const secs = String(remaining % 60).padStart(2, '0');
      if (timerEl) timerEl.textContent = `Batas Waktu: ${mins}:${secs}`;

      if (remaining <= 0) {
        clearInterval(timerInterval);
        clearInterval(pollInterval);
        if (options.onExpired) options.onExpired();
        document.body.removeChild(overlay);
      }
    }, 1000);

    // Poll status
    const pollInterval = setInterval(async () => {
      try {
        const statusRes = await fetch(`${options.endpoint}/api/v1/payment/status/${paymentData.paymentId}`);
        const statusData = await statusRes.json();
        if (statusData.status === 'PAID') {
          clearInterval(pollInterval);
          clearInterval(timerInterval);
          if (options.onSuccess) options.onSuccess(statusData);
          document.body.removeChild(overlay);
        }
      } catch {}
    }, 3000);
  }
}

// Global window attachment for UMD/Script tag
if (typeof window !== 'undefined') {
  (window as any).KaiGoBiz = KaiGoBiz;
}

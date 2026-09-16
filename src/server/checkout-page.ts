import { PaymentOrder } from '../core/storage/storage.interface';

export function renderCheckoutPage(order: PaymentOrder, merchantName: string = 'Merchant GoBiz'): string {
  const formattedAmount = `Rp ${Number(order.amount).toLocaleString('id-ID')}`;
  const orderJson = JSON.stringify({
    paymentId: order.paymentId,
    orderId: order.orderId,
    amount: order.amount,
    status: order.status,
    expiresAt: order.expiresAt,
    callbackUrl: order.callbackUrl || null,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pembayaran QRIS: ${escapeHtml(order.orderId)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #111827;
      --card-border: #1f293d;
      --card-hover: #1e293b;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #00880c;
      --primary-hover: #00700a;
      --primary-light: rgba(0, 136, 12, 0.12);
      --danger: #ef4444;
      --danger-light: rgba(239, 68, 68, 0.12);
      --warning: #f59e0b;
      --warning-light: rgba(245, 158, 11, 0.12);
      --font: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      font-family: var(--font);
      background-color: var(--bg);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 20px 16px;
      line-height: 1.5;
    }

    .checkout-container {
      width: 100%;
      max-width: 440px;
    }

    .checkout-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      overflow: hidden;
      box-shadow: 0 20px 40px -15px rgba(0, 0, 0, 0.5);
    }

    /* Header */
    .card-header {
      padding: 20px 24px 16px;
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .merchant-brand {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .merchant-avatar {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      background: var(--primary-light);
      color: #10b981;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      border: 1px solid rgba(16, 185, 129, 0.25);
    }

    .merchant-info h1 {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .verified-icon {
      color: #10b981;
    }

    .order-badge {
      font-size: 12px;
      font-family: var(--font-mono);
      background: #1e293b;
      color: var(--text-muted);
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--card-border);
    }

    /* Amount Section */
    .amount-section {
      padding: 20px 24px;
      text-align: center;
      background: rgba(15, 23, 42, 0.4);
      border-bottom: 1px solid var(--card-border);
    }

    .amount-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 4px;
      font-weight: 600;
    }

    .amount-value {
      font-size: 32px;
      font-weight: 800;
      color: #ffffff;
      letter-spacing: -0.02em;
    }

    /* Timer Banner */
    .timer-banner {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 10px 16px;
      background: var(--warning-light);
      color: #fbbf24;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 1px solid rgba(245, 158, 11, 0.2);
      transition: all 0.3s ease;
    }

    .timer-banner.urgent {
      background: var(--danger-light);
      color: #f87171;
      border-bottom-color: rgba(239, 68, 68, 0.25);
    }

    .timer-clock {
      font-family: var(--font-mono);
      font-weight: 700;
      font-size: 15px;
    }

    /* QR Code Area */
    .card-body {
      padding: 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .qris-canvas-wrapper {
      background: #ffffff;
      padding: 16px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
      margin-bottom: 16px;
      display: flex;
      flex-direction: column;
      align-items: center;
      width: 250px;
    }

    .qris-top-logo {
      font-weight: 800;
      font-size: 18px;
      color: #e11d48;
      letter-spacing: 0.1em;
      margin-bottom: 10px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .qris-top-logo span {
      font-size: 9px;
      color: #64748b;
      letter-spacing: 0.05em;
      font-weight: 600;
    }

    .qris-image {
      width: 218px;
      height: 218px;
      display: block;
      border-radius: 4px;
    }

    .supported-wallets {
      font-size: 11px;
      color: var(--text-muted);
      text-align: center;
      margin-top: 6px;
      line-height: 1.4;
      max-width: 280px;
    }

    /* Action Buttons */
    .action-row {
      display: flex;
      gap: 10px;
      width: 100%;
      margin-top: 16px;
    }

    .btn {
      flex: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease, border-color 0.15s ease;
      min-height: 44px;
      border: 1px solid transparent;
    }

    .btn:focus-visible {
      outline: 2px solid #3b82f6;
      outline-offset: 2px;
    }

    .btn-secondary {
      background: #1e293b;
      color: var(--text-main);
      border-color: var(--card-border);
    }

    .btn-secondary:hover {
      background: var(--card-hover);
      border-color: #334155;
    }

    .btn-primary {
      background: var(--primary);
      color: #ffffff;
    }

    .btn-primary:hover {
      background: var(--primary-hover);
    }

    /* Polling Status Pill */
    .polling-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-top: 16px;
      font-size: 12px;
      color: var(--text-muted);
    }

    .pulse-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      animation: pulse 1.8s infinite;
    }

    @keyframes pulse {
      0% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      }
      70% {
        transform: scale(1);
        box-shadow: 0 0 0 8px rgba(16, 185, 129, 0);
      }
      100% {
        transform: scale(0.95);
        box-shadow: 0 0 0 0 rgba(16, 185, 129, 0);
      }
    }

    /* State Screens: Success & Expired */
    .state-screen {
      display: none;
      padding: 36px 24px;
      text-align: center;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }

    .state-screen.active {
      display: flex;
    }

    .state-icon-circle {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 16px;
    }

    .state-icon-circle.success {
      background: rgba(16, 185, 129, 0.15);
      color: #10b981;
      border: 2px solid rgba(16, 185, 129, 0.3);
    }

    .state-icon-circle.expired {
      background: rgba(239, 68, 68, 0.15);
      color: #ef4444;
      border: 2px solid rgba(239, 68, 68, 0.3);
    }

    .state-title {
      font-size: 20px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    .state-desc {
      font-size: 13px;
      color: var(--text-muted);
      max-width: 320px;
      margin-bottom: 20px;
      line-height: 1.5;
    }

    .footer-note {
      text-align: center;
      margin-top: 16px;
      font-size: 11px;
      color: #64748b;
    }

    .footer-note strong {
      color: #94a3b8;
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 24px;
      background: #1e293b;
      color: #f8fafc;
      padding: 10px 18px;
      border-radius: 8px;
      border: 1px solid #334155;
      font-size: 13px;
      box-shadow: 0 10px 25px rgba(0, 0, 0, 0.4);
      opacity: 0;
      transform: translateY(10px);
      transition: all 0.2s ease;
      pointer-events: none;
      z-index: 100;
    }

    .toast.show {
      opacity: 1;
      transform: translateY(0);
    }
  </style>
</head>
<body>
  <main class="checkout-container">
    <div class="checkout-card" id="main-card">
      <!-- Card Header -->
      <header class="card-header">
        <div class="merchant-brand">
          <div class="merchant-avatar" aria-hidden="true">${escapeHtml(merchantName.charAt(0).toUpperCase())}</div>
          <div class="merchant-info">
            <h1>
              <span>${escapeHtml(merchantName)}</span>
              <svg class="verified-icon" width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-label="Terverifikasi">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
              </svg>
            </h1>
          </div>
        </div>
        <span class="order-badge">${escapeHtml(order.orderId)}</span>
      </header>

      <!-- Amount Section -->
      <section class="amount-section">
        <div class="amount-label">Total Pembayaran</div>
        <div class="amount-value">${escapeHtml(formattedAmount)}</div>
      </section>

      <!-- Timer Banner -->
      <div class="timer-banner" id="timer-banner" role="timer" aria-live="polite">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <span>Selesaikan dalam <span class="timer-clock" id="countdown-display">--:--</span></span>
      </div>

      <!-- Active QR Body -->
      <div class="card-body" id="qr-active-view">
        <div class="qris-canvas-wrapper">
          <div class="qris-top-logo">
            QRIS <span>STANDAR NASIONAL</span>
          </div>
          <img class="qris-image" id="qris-img" src="${escapeHtml(order.qrisQrUrl || '')}" alt="QRIS Pembayaran" />
        </div>

        <p class="supported-wallets">
          Scan dengan BCA Mobile, GoPay, ShopeePay, Dana, OVO, Livin Mandiri, atau aplikasi perbankan apa saja.
        </p>

        <div class="action-row">
          <button type="button" class="btn btn-secondary" id="btn-copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
            </svg>
            <span>Salin Kode</span>
          </button>

          <button type="button" class="btn btn-secondary" id="btn-download">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" x2="12" y1="15" y2="3"/>
            </svg>
            <span>Unduh PNG</span>
          </button>
        </div>

        <div class="polling-pill" id="polling-status">
          <span class="pulse-dot" aria-hidden="true"></span>
          <span>Menunggu pembayaran otomatis...</span>
        </div>
      </div>

      <!-- Success Screen -->
      <div class="state-screen" id="state-success">
        <div class="state-icon-circle success" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h2 class="state-title">Pembayaran Berhasil!</h2>
        <p class="state-desc" id="success-message">
          Transaksi sebesar ${escapeHtml(formattedAmount)} telah terverifikasi secara otomatis. Terima kasih!
        </p>
        <button type="button" class="btn btn-primary" id="btn-success-action" style="width: 100%;">
          <span>Selesai</span>
        </button>
      </div>

      <!-- Expired Screen -->
      <div class="state-screen" id="state-expired">
        <div class="state-icon-circle expired" aria-hidden="true">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" x2="9" y1="9" y2="15"/>
            <line x1="9" x2="15" y1="9" y2="15"/>
          </svg>
        </div>
        <h2 class="state-title">Batas Waktu Berakhir</h2>
        <p class="state-desc">
          Kode QRIS ini telah kedaluwarsa demi keamanan. Silakan buat pesanan baru untuk melanjutkan pembayaran.
        </p>
        <button type="button" class="btn btn-secondary" id="btn-expired-action" style="width: 100%;">
          <span>Tutup</span>
        </button>
      </div>
    </div>

    <footer class="footer-note">
      Diproses aman oleh <strong>KaiGoBiz</strong> Gateway
    </footer>
  </main>

  <div class="toast" id="toast" role="status" aria-live="polite"></div>

  <script>
    (function() {
      const order = ${orderJson};
      const rawQris = ${JSON.stringify(order.qrisString || '')};

      const qrActiveView = document.getElementById('qr-active-view');
      const timerBanner = document.getElementById('timer-banner');
      const countdownDisplay = document.getElementById('countdown-display');
      const stateSuccess = document.getElementById('state-success');
      const stateExpired = document.getElementById('state-expired');
      const toast = document.getElementById('toast');
      const btnCopy = document.getElementById('btn-copy');
      const btnDownload = document.getElementById('btn-download');
      const btnSuccessAction = document.getElementById('btn-success-action');
      const btnExpiredAction = document.getElementById('btn-expired-action');

      let timerInterval = null;
      let pollInterval = null;
      let isCompleted = false;

      function showToast(msg) {
        if (!toast) return;
        toast.textContent = msg;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2500);
      }

      function showSuccessScreen(paidAt) {
        if (isCompleted) return;
        isCompleted = true;
        clearInterval(timerInterval);
        clearInterval(pollInterval);

        if (timerBanner) timerBanner.style.display = 'none';
        if (qrActiveView) qrActiveView.style.display = 'none';
        if (stateExpired) stateExpired.classList.remove('active');
        if (stateSuccess) stateSuccess.classList.add('active');

        if (order.callbackUrl && /^https?:\/\//i.test(order.callbackUrl)) {
          setTimeout(() => {
            window.location.href = order.callbackUrl;
          }, 3000);
        }
      }

      function showExpiredScreen() {
        if (isCompleted) return;
        isCompleted = true;
        clearInterval(timerInterval);
        clearInterval(pollInterval);

        if (timerBanner) timerBanner.style.display = 'none';
        if (qrActiveView) qrActiveView.style.display = 'none';
        if (stateSuccess) stateSuccess.classList.remove('active');
        if (stateExpired) stateExpired.classList.add('active');
      }

      function updateCountdown() {
        if (isCompleted) return;
        const expiresTime = new Date(order.expiresAt).getTime();
        const now = Date.now();
        const diffSeconds = Math.max(0, Math.floor((expiresTime - now) / 1000));

        if (diffSeconds <= 0) {
          if (countdownDisplay) countdownDisplay.textContent = '00:00';
          showExpiredScreen();
          return;
        }

        const mins = Math.floor(diffSeconds / 60).toString().padStart(2, '0');
        const secs = (diffSeconds % 60).toString().padStart(2, '0');
        if (countdownDisplay) countdownDisplay.textContent = mins + ':' + secs;

        if (diffSeconds <= 60 && timerBanner) {
          timerBanner.classList.add('urgent');
        }
      }

      async function checkPaymentStatus() {
        if (isCompleted) return;
        try {
          const res = await fetch('/api/v1/payment/status/' + encodeURIComponent(order.paymentId));
          const data = await res.json();
          if (data.status === 'PAID') {
            showSuccessScreen(data.paidAt);
          } else if (data.status === 'EXPIRED') {
            showExpiredScreen();
          }
        } catch {}
      }

      // Initial state check
      if (order.status === 'PAID') {
        showSuccessScreen();
      } else if (order.status === 'EXPIRED') {
        showExpiredScreen();
      } else {
        updateCountdown();
        timerInterval = setInterval(updateCountdown, 1000);
        pollInterval = setInterval(checkPaymentStatus, 2500);
      }

      function copyTextToClipboard(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          return navigator.clipboard.writeText(text);
        }
        return new Promise(function(resolve, reject) {
          var textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.top = '0';
          textArea.style.left = '0';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          try {
            var successful = document.execCommand('copy');
            document.body.removeChild(textArea);
            if (successful) resolve();
            else reject(new Error('execCommand failed'));
          } catch (err) {
            document.body.removeChild(textArea);
            reject(err);
          }
        });
      }

      btnCopy?.addEventListener('click', async () => {
        if (!rawQris) return;
        try {
          await copyTextToClipboard(rawQris);
          showToast('Kode QRIS berhasil disalin ke papan klip');
        } catch {
          showToast('Gagal menyalin kode QRIS');
        }
      });

      btnDownload?.addEventListener('click', () => {
        const img = document.getElementById('qris-img');
        if (!img || !img.src) return;
        const a = document.createElement('a');
        a.href = img.src;
        a.download = 'qris-' + order.orderId + '.png';
        a.click();
        showToast('Gambar QRIS berhasil diunduh');
      });

      btnSuccessAction?.addEventListener('click', () => {
        if (order.callbackUrl && /^https?:\/\//i.test(order.callbackUrl)) {
          window.location.href = order.callbackUrl;
        } else {
          window.close();
        }
      });

      btnExpiredAction?.addEventListener('click', () => {
        window.history.back();
      });
    })();
  </script>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

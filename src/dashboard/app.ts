import { KaiGoBiz } from '../widget/kaigobiz-widget';

interface TransactionItem {
  id: string;
  amount: number;
  description?: string;
  timestamp: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
}

let currentOtpToken = '';
let currentPhone = '';

async function checkStatus() {
  const badge = document.getElementById('status-badge');
  const sessionInfo = document.getElementById('session-info');

  try {
    const res = await fetch('/api/v1/auth/status');
    const data = await res.json();

    if (data.connected && data.session) {
      if (badge) {
        badge.className = 'badge online';
        badge.innerHTML = '<span class="dot"></span><span class="text">Online</span>';
      }
      if (sessionInfo) {
        const outlet = data.session.outlet_name || 'Merchant GoBiz';
        const phone = data.session.phone_number || '-';
        const merchantId = data.session.merchant_id || '-';
        const expiresAt = data.session.expires_at ? new Date(data.session.expires_at).toLocaleString('id-ID') : '-';

        sessionInfo.innerHTML = `
          <div><strong>Outlet:</strong> ${outlet}</div>
          <div><strong>No. Handphone:</strong> ${phone}</div>
          <div><strong>Merchant ID:</strong> ${merchantId}</div>
          <div><strong>Berlaku Hingga:</strong> ${expiresAt}</div>
        `;
      }
    } else {
      if (badge) {
        badge.className = 'badge offline';
        badge.innerHTML = '<span class="dot"></span><span class="text">Offline</span>';
      }
      if (sessionInfo) {
        sessionInfo.innerHTML = 'Sesi GoBiz belum terhubung. Silakan minta & verifikasi kode OTP di bawah.';
      }
    }
  } catch (err) {
    if (badge) {
      badge.className = 'badge offline';
      badge.innerHTML = '<span class="dot"></span><span class="text">Server Offline</span>';
    }
    if (sessionInfo) {
      sessionInfo.innerHTML = 'Gagal terhubung ke API KaiGoBiz Server.';
    }
  }
}

function showMessage(text: string, type: 'info' | 'error' | 'success') {
  const msgEl = document.getElementById('otp-message');
  if (msgEl) {
    msgEl.className = `message-banner ${type}`;
    msgEl.textContent = text;
    msgEl.style.display = 'block';
  }
}

function hideMessage() {
  const msgEl = document.getElementById('otp-message');
  if (msgEl) {
    msgEl.style.display = 'none';
  }
}

// Form Handlers: OTP Request
document.getElementById('otp-request-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage();

  const phoneInput = document.getElementById('phone-input') as HTMLInputElement;
  const btnSubmit = document.getElementById('btn-request-otp') as HTMLButtonElement;
  const verifyForm = document.getElementById('otp-verify-form');

  if (!phoneInput || !btnSubmit) return;
  const phone = phoneInput.value.trim();

  if (!phone) {
    showMessage('Nomor handphone harus diisi', 'error');
    return;
  }

  btnSubmit.disabled = true;
  btnSubmit.innerHTML = '<span class="loading-spinner"></span> Memproses...';

  try {
    const res = await fetch('/api/v1/auth/request-otp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });

    const data = await res.json();

    if (res.ok && data.success && data.otpToken) {
      currentOtpToken = data.otpToken;
      currentPhone = phone;
      showMessage(`Kode OTP telah dikirim ke ${phone}. Silakan masukkan kode OTP di bawah.`, 'success');
      if (verifyForm) verifyForm.style.display = 'flex';
    } else {
      showMessage(data.error || 'Gagal mengirim OTP', 'error');
    }
  } catch (err: any) {
    showMessage(err.message || 'Terjadi kesalahan jaringan', 'error');
  } finally {
    btnSubmit.disabled = false;
    btnSubmit.innerHTML = '<span>Kirim Kode OTP</span><span class="arrow">→</span>';
  }
});

// Form Handlers: OTP Verify
document.getElementById('otp-verify-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  hideMessage();

  const otpInput = document.getElementById('otp-input') as HTMLInputElement;
  const btnVerify = document.getElementById('btn-verify-otp') as HTMLButtonElement;
  const verifyForm = document.getElementById('otp-verify-form');

  if (!otpInput || !btnVerify) return;
  const otp = otpInput.value.trim();

  if (!otp) {
    showMessage('Kode OTP harus diisi', 'error');
    return;
  }

  btnVerify.disabled = true;
  btnVerify.innerHTML = '<span class="loading-spinner"></span> Memverifikasi...';

  try {
    const res = await fetch('/api/v1/auth/verify-otp', {
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
      showMessage('Berhasil terhubung dengan sesi GoBiz!', 'success');
      if (verifyForm) verifyForm.style.display = 'none';
      otpInput.value = '';
      await checkStatus();
      await fetchTransactions();
    } else {
      showMessage(data.error || 'Verifikasi OTP gagal', 'error');
    }
  } catch (err: any) {
    showMessage(err.message || 'Terjadi kesalahan jaringan', 'error');
  } finally {
    btnVerify.disabled = false;
    btnVerify.textContent = 'Verifikasi OTP';
  }
});

// Cancel OTP
document.getElementById('btn-cancel-otp')?.addEventListener('click', () => {
  const verifyForm = document.getElementById('otp-verify-form');
  if (verifyForm) verifyForm.style.display = 'none';
  hideMessage();
});

// Preset Buttons
document.querySelectorAll('.btn-preset').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    const amount = (e.currentTarget as HTMLElement).getAttribute('data-amount');
    const amountInput = document.getElementById('amount-input') as HTMLInputElement;
    if (amountInput && amount) {
      amountInput.value = amount;
    }
  });
});

// Payment Form Submit (Test Checkout Widget)
document.getElementById('create-payment-form')?.addEventListener('submit', (e) => {
  e.preventDefault();

  const orderIdInput = document.getElementById('order-id-input') as HTMLInputElement;
  const amountInput = document.getElementById('amount-input') as HTMLInputElement;

  if (!orderIdInput || !amountInput) return;

  const orderId = orderIdInput.value.trim() || `INV-${Date.now()}`;
  const amount = Number(amountInput.value);

  if (!amount || amount <= 0) {
    alert('Nominal harus lebih besar dari 0');
    return;
  }

  KaiGoBiz.checkout({
    endpoint: window.location.origin,
    orderId,
    amount,
    onSuccess: (res) => {
      alert(`Pembayaran Sukses! (Order ID: ${res.orderId || orderId})`);
      fetchTransactions();
    },
    onExpired: () => {
      alert('Batas waktu pembayaran telah habis (Expired).');
    },
    onError: (err) => {
      alert('Gagal memproses pembayaran: ' + (err.error || JSON.stringify(err)));
    },
  });
});

// Fetch Transactions Table
async function fetchTransactions() {
  const container = document.getElementById('tx-table-container');
  const refreshBtn = document.getElementById('refresh-tx-btn');

  if (refreshBtn) {
    refreshBtn.classList.add('loading');
  }

  if (container) {
    container.innerHTML = `
      <div class="loading-state">
        <div class="spinner"></div>
        <span>Mengambil mutasi transaksi terbaru...</span>
      </div>
    `;
  }

  try {
    const res = await fetch('/api/v1/transactions');
    const data = await res.json();

    const items: TransactionItem[] = data.transactions || [];

    if (!container) return;

    if (items.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div style="font-size:32px;">📭</div>
          <p>Belum ada riwayat mutasi transaksi.</p>
        </div>
      `;
      return;
    }

    const tableRows = items.map((item) => {
      const statusClass = (item.status || 'PENDING').toLowerCase();
      const formattedAmount = `Rp ${Number(item.amount).toLocaleString('id-ID')}`;
      const dateStr = item.timestamp ? new Date(item.timestamp).toLocaleString('id-ID') : '-';

      return `
        <tr>
          <td><code style="color:#38bdf8;">${item.id}</code></td>
          <td style="font-weight:700;">${formattedAmount}</td>
          <td>${item.description || 'GoPay Dynamic QRIS'}</td>
          <td style="color:#94a3b8;">${dateStr}</td>
          <td><span class="tx-status-badge ${statusClass}">${item.status}</span></td>
        </tr>
      `;
    }).join('');

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
          ${tableRows}
        </tbody>
      </table>
    `;
  } catch (err) {
    if (container) {
      container.innerHTML = `
        <div class="empty-state">
          <div style="font-size:32px;color:#f87171;">⚠️</div>
          <p>Gagal memuat transaksi. Pastikan server API berjalan.</p>
        </div>
      `;
    }
  } finally {
    if (refreshBtn) {
      refreshBtn.classList.remove('loading');
    }
  }
}

// Refresh button listener
document.getElementById('refresh-tx-btn')?.addEventListener('click', () => {
  fetchTransactions();
});

// Initial load
document.addEventListener('DOMContentLoaded', () => {
  checkStatus();
  fetchTransactions();
});

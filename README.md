# KaiGoBiz Payment Gateway & Scraper

High-performance TypeScript GoBiz and GoPay Payment Gateway, Scraper, and Dynamic QRIS Generator. Built with Hono.js, EMVCo CRC16 engine, real-time GoBiz Journal mutasi reconciliation, embeddable checkout widget (`kaigobiz.js`), and hosted payment page.

---

## Key Highlights

- **Dynamic QRIS Generator**: Generates custom-amount QRIS payments instantly from any static GoBiz QRIS template using EMVCo Tag 54 injection and CRC16 CCITT recalculation.
- **Auto Reconciliation**: Background reconciler polls the GoBiz Wallstreet Journal API, matches transactions, normalizes Gojek sen units (minor currency x100), and marks payments as `PAID`.
- **Three Integration Modes**:
  1. **Hosted Checkout Page** (`/pay/:paymentId`): Pre-built responsive payment page with QRIS code, live countdown, auto-polling, and direct banking app deep links.
  2. **Embeddable Modal Widget** (`kaigobiz.js`): Lightweight (~15KB) modal popup script that works on any website with a single `<script>` tag.
  3. **Headless REST API**: Full JSON API for custom mobile apps, e-commerce backends, and headless checkouts.
- **Webhook Dispatcher**: Instant HTTP POST notifications to your backend or e-commerce store when a customer completes payment.
- **QRIS Studio**: Extract your merchant QRIS template directly via client-side `jsQR` (HTML5 Canvas), clipboard paste (`Ctrl+V`), camera scanner, or multi-engine server upload (`zxingcpp`, `pyzbar`, `OpenCV`, and PDF posters via `pdftoppm`).
- **Modern Dashboard**: Manage GoBiz SMS OTP login, test payments, monitor live mutasi transactions, and configure webhooks with dark mode glassmorphism UI.

---

## Architecture & Payment Flow

```
Customer                    Your Web Store / App               KaiGoBiz Server                   GoBiz / GoPay
   |                                 |                                |                                |
   | 1. Checkout (Rp 50.000)        |                                |                                |
   |-------------------------------->|                                |                                |
   |                                 | 2. POST /api/v1/payment/create |                                |
   |                                 |------------------------------->|                                |
   |                                 |                                | Generate Dynamic QRIS (CRC16)  |
   |                                 | 3. Returns paymentId & URL     | Save order (status: PENDING)   |
   |                                 |<-------------------------------|                                |
   | 4. Show Widget or Redirect to   |                                |                                |
   |    /pay/:paymentId              |                                |                                |
   |<--------------------------------|                                |                                |
   |                                                                  |                                |
   | 5. Scans QRIS & Pays via GoPay / BCA / Dana / ShopeePay / etc.  |                                |
   |=================================================================>|                                |
   |                                                                  | 6. Background Reconciler polls  |
   |                                                                  |    Wallstreet Journal API      |
   |                                                                  |<==============================>|
   |                                                                  | Match amount & timestamp       |
   |                                                                  | Mark order as PAID             |
   | 7. UI updates to "PAID" instantly (via auto-polling)             |                                |
   |<-----------------------------------------------------------------|                                |
   |                                 | 8. Webhook POST (payment.paid) |                                |
   |                                 |<-------------------------------|                                |
```

---

## Requirements

- **Node.js**: v18.0.0 or higher
- **Package Manager**: `npm` or `pnpm`
- **Python 3** (optional, used for server-side QR image and PDF extraction fallback):
  - `pip3 install zxing-cpp pyzbar opencv-python-headless pillow pillow-heif numpy`
  - `apt-get install -y poppler-utils` (for GoBiz PDF poster decoding)

---

## Quick Start

### Option A: 1-Click Automated Installer (Recommended for VPS)

Run the installer script to automatically install all system packages, Python QR engines, Node dependencies, build the frontend, and start PM2:

```bash
# Direct run from cloned folder
./install.sh

# Or 1-line install directly from GitHub
curl -fsSL https://raw.githubusercontent.com/kaivyy/kaigobiz/main/install.sh | bash
```

---

### Option B: Manual Installation

#### 1. Clone & Install Dependencies

```bash
git clone https://github.com/kaivyy/kaigobiz.git
cd kaigobiz
npm install
```

#### 2. Configuration (`.env`)

Create a `.env` file in the root directory:

```env
PORT=3636
NODE_ENV=production
# Optional default webhook URL
WEBHOOK_URL=https://your-domain.com/api/payment-webhook
# Optional default QRIS template (can also be configured via Dashboard)
STATIC_QRIS_TEMPLATE=00020101021126610014COM.GO-JEK.WWW...6304EB1B
```

### 3. Build & Run

```bash
# Build frontend dashboard and embeddable widget
npm run build

# Start the server (development or test run)
npm run server

# Or run continuously in background via PM2
pm2 start "npm run server" --name kaigobiz
```

Access the Web Dashboard at: `http://localhost:3636`

---

## Merchant Setup & QRIS Studio

1. Open the Dashboard at `http://localhost:3636`.
2. **Login to GoBiz**:
   - Go to **Akun GoBiz**.
   - Enter your registered GoBiz phone number (e.g., `08123456789`).
   - Submit the SMS OTP received on your device.
   - Sesi and token are saved securely in `.kaigobiz-session.json` and auto-refreshed in the background.
3. **Set Up QRIS Template**:
   - Go to **QRIS Studio**.
   - Either paste your static QRIS string directly, paste a screenshot with `Ctrl+V`, upload your GoBiz QRIS photo / PDF poster, or use the camera scanner.
   - Click **Simpan Template**. The template is validated and saved to `.kaigobiz-config.json`.

---

## Integration Guide

### Method 1: Hosted Checkout Page (Recommended)

Redirect customers to the pre-hosted checkout URL. This is the simplest and most secure method, similar to Midtrans Snap or Stripe Checkout.

#### 1. Create Payment on Your Backend

```bash
curl -X POST http://localhost:3636/api/v1/payment/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "INV-2026-001",
    "amount": 50000,
    "expiryMinutes": 10,
    "callbackUrl": "https://yourshop.com/webhook"
  }'
```

**Response:**
```json
{
  "success": true,
  "paymentId": "pay_1753470123456_a9b8c",
  "orderId": "INV-2026-001",
  "amount": 50000,
  "qrisString": "00020101021226610014COM.GO-JEK.WWW...540550000...6304A1B2",
  "qrisQrUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
  "checkoutUrl": "http://localhost:3636/pay/pay_1753470123456_a9b8c",
  "expiresAt": "2026-09-15T11:30:00.000Z",
  "callbackUrl": "https://yourshop.com/webhook"
}
```

#### 2. Redirect Customer

Redirect your customer's browser to `checkoutUrl`. The page handles QR code display, live countdown, auto-refreshing payment status, and audio cues upon payment completion.

---

### Method 2: Embeddable Modal Widget (`kaigobiz.js`)

Keep customers on your website with an in-page modal dialog.

Include the widget script in your HTML:

```html
<!-- Load KaiGoBiz Widget -->
<script src="http://localhost:3636/kaigobiz.js"></script>

<button id="pay-btn" type="button">Bayar Sekarang</button>

<script>
  document.getElementById('pay-btn').addEventListener('click', () => {
    KaiGoBiz.checkout({
      endpoint: "http://localhost:3636",
      orderId: "INV-2026-002",
      amount: 25000,
      onSuccess: (payment) => {
        alert("Pembayaran berhasil untuk order " + payment.orderId);
        window.location.href = "/order/thank-you";
      },
      onExpired: () => {
        alert("Waktu pembayaran telah habis. Silakan buat pesanan baru.");
      },
      onError: (err) => {
        console.error("Gagal memulai pembayaran:", err);
      }
    });
  });
</script>
```

---

### Method 3: Headless API & Custom UI (100% White-Label)

If you do not want to use the pre-built hosted checkout page or modal widget, you can render a completely custom payment UI on your own website. KaiGoBiz returns raw QR data and base64 images that you can embed anywhere.

#### Step 1: Create Payment on Backend

##### PHP / Laravel Example
```php
<?php

$payload = [
    'orderId' => 'INV-' . time(),
    'amount' => 75000,
    'expiryMinutes' => 15,
    'callbackUrl' => 'https://tokoanda.com/api/payment-callback'
];

$ch = curl_init('http://localhost:3636/api/v1/payment/create');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));

$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);

// Pass $data['paymentId'] and $data['qrisQrUrl'] to your frontend Blade view
```

##### Node.js / Express Example
```javascript
import axios from 'axios';

app.post('/api/checkout', async (req, res) => {
  try {
    const response = await axios.post('http://localhost:3636/api/v1/payment/create', {
      orderId: `ORDER-${Date.now()}`,
      amount: req.body.totalAmount,
      expiryMinutes: 10,
      callbackUrl: 'https://myshop.com/api/webhook'
    });

    res.json({
      paymentId: response.data.paymentId,
      qrisQrUrl: response.data.qrisQrUrl,
      expiresAt: response.data.expiresAt
    });
  } catch (error) {
    res.status(500).json({ error: 'Gagal membuat pembayaran' });
  }
});
```

#### Step 2: Render Custom UI & Poll Status on Frontend

Render the QR code directly using the returned `qrisQrUrl` (Base64 data URL) and poll payment status every 3 seconds:

```html
<!-- Custom Store Checkout View -->
<div class="custom-checkout-card">
  <h3>Pembayaran QRIS #INV-10023</h3>
  <div class="price">Rp 75.000</div>

  <!-- Render Base64 QRIS Image -->
  <img id="qris-img" src="" alt="Kode QRIS" width="220" />

  <p>Pindai menggunakan aplikasi GoPay, BCA, OVO, Dana, atau mobile banking apa saja.</p>
  <div id="payment-status">Menunggu pembayaran...</div>
</div>

<script>
  const paymentId = "PAYMENT_ID_FROM_BACKEND";
  const qrisQrUrl = "QRIS_QR_URL_FROM_BACKEND";

  // Display QR code image
  document.getElementById('qris-img').src = qrisQrUrl;

  // Poll status every 3 seconds
  const pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:3636/api/v1/payment/status/${paymentId}`);
      const data = await res.json();

      if (data.status === 'PAID') {
        clearInterval(pollTimer);
        document.getElementById('payment-status').textContent = 'Pembayaran Berhasil!';
        
        // Redirect to store success page
        setTimeout(() => {
          window.location.href = '/checkout/success?order=' + data.orderId;
        }, 1200);
      } else if (data.status === 'EXPIRED') {
        clearInterval(pollTimer);
        document.getElementById('payment-status').textContent = 'Waktu pembayaran telah habis.';
      }
    } catch (err) {
      console.error('Polling error:', err);
    }
  }, 3000);
</script>
```

---

## Webhook Notifications

When a payment is matched by the background reconciler, KaiGoBiz dispatches an HTTP POST webhook notification.

### Webhook Payload Format

```json
{
  "event": "payment.success",
  "paymentId": "pay_1753470123456_a9b8c",
  "orderId": "INV-2026-001",
  "amount": 50000,
  "status": "PAID",
  "paidAt": "2026-09-15T10:49:07.000Z",
  "transactionId": "tx_gopay_123456789",
  "timestamp": "2026-09-15T10:49:07.000Z"
}
```

### Webhook Handling Example (Express / Node.js)

```javascript
app.post('/api/webhook', express.json(), (req, res) => {
  const { event, orderId, amount, status } = req.body;

  if (event === 'payment.success' && status === 'PAID') {
    // Update order in your database
    console.log(`Pesanan ${orderId} lunas sebesar Rp ${amount}`);
  }

  // Respond with 200 OK to acknowledge receipt
  res.status(200).json({ received: true });
});
```

---

## REST API Reference

### Payment Endpoints

#### `POST /api/v1/payment/create`
Create a dynamic QRIS order.

- **Request Body:**
  ```json
  {
    "orderId": "INV-101",
    "amount": 10000,
    "expiryMinutes": 5,
    "callbackUrl": "https://mysite.com/callback"
  }
  ```
- **Response (200 OK):**
  ```json
  {
    "success": true,
    "paymentId": "pay_1753470000000_abc12",
    "orderId": "INV-101",
    "amount": 10000,
    "qrisString": "000201...",
    "qrisQrUrl": "data:image/png;base64,...",
    "checkoutUrl": "http://localhost:3636/pay/pay_1753470000000_abc12",
    "expiresAt": "2026-09-15T11:05:00.000Z",
    "callbackUrl": "https://mysite.com/callback"
  }
  ```

#### `GET /api/v1/payment/status/:paymentId`
Check payment status (`PENDING`, `PAID`, or `EXPIRED`).

- **Response (200 OK):**
  ```json
  {
    "success": true,
    "paymentId": "pay_1753470000000_abc12",
    "orderId": "INV-101",
    "amount": 10000,
    "status": "PAID",
    "createdAt": "2026-09-15T11:00:00.000Z",
    "expiresAt": "2026-09-15T11:05:00.000Z",
    "paidAt": "2026-09-15T11:02:14.000Z",
    "qrisString": "000201...",
    "qrisQrUrl": "data:image/png;base64,..."
  }
  ```

#### `GET /api/v1/payment/template`
Get the currently active static QRIS merchant template and parsed metadata (NMID, Merchant Name, City).

#### `POST /api/v1/payment/template`
Update the active static QRIS template.

- **Request Body:**
  ```json
  {
    "template": "00020101021126610014COM.GO-JEK.WWW..."
  }
  ```

#### `POST /api/v1/payment/decode-qr`
Server-side QR code extractor from base64 image (supports PNG, JPEG, WebP, HEIC, and PDF posters).

- **Request Body:**
  ```json
  {
    "imageBase64": "data:image/png;base64,..."
  }
  ```

---

### Authentication Endpoints

#### `GET /api/v1/auth/status`
Check GoBiz connection status and merchant profile details.

#### `POST /api/v1/auth/request-otp`
Request an SMS OTP from GoBiz.

- **Request Body:**
  ```json
  {
    "phone": "081234567890"
  }
  ```

#### `POST /api/v1/auth/verify-otp`
Verify SMS OTP code and persist session tokens.

- **Request Body:**
  ```json
  {
    "phone": "081234567890",
    "otp": "123456",
    "otpToken": "TOKEN_FROM_REQUEST_OTP"
  }
  ```

#### `POST /api/v1/auth/logout`
Clear local GoBiz session tokens.

---

### Transactions & Mutasi

#### `GET /api/v1/transactions`
Fetches live transactions directly from the GoBiz Wallstreet Journal API. Automatically converts sen amounts to standard Rupiah.

---

## GoBiz Sen Currency Normalization

Gojek Wallstreet Journal API reports amounts in minor currency units (*sen* / cents, factor of 100).
For example:
- A payment of **Rp 1.000** is reported as `100000` in the GoBiz API.
- The 0.3% MDR fee is reported as `300` (Rp 3).

KaiGoBiz handles this normalization automatically inside `GoBizClient` and `Reconciler`. Both raw units and normalized Rupiah are handled transparently, ensuring reliable matching without manual conversion on your end.

---

## Testing

Run unit and integration test suites:

```bash
npm test
```

All core components (QRIS EMVCo parser, dynamic amount injection, CRC16 verification, file storage adapter, and HTTP endpoints) are covered by Vitest tests.

---

## Production Deployment with PM2

To run KaiGoBiz 24/7 on a Linux VPS:

```bash
# 1. Install PM2 globally if not installed
npm install -g pm2

# 2. Build the production bundle
npm run build

# 3. Start process
pm2 start "npm run server" --name kaigobiz

# 4. Enable restart on system boot
pm2 save
pm2 startup
```

Check status and logs anytime:

```bash
pm2 status
pm2 logs kaigobiz
```

---

## License

MIT License (c) 2026 KaiGoBiz Team

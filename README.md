<div align="center">

# ⚡ KaiGoBiz
### High-Performance GoBiz Payment Gateway, Dynamic QRIS Generator & Mutasi Scraper

[![Version](https://img.shields.io/badge/version-v1.1.1-10b981?style=for-the-badge)](https://github.com/kaivyy/kaigobiz/releases/tag/v1.1.1)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178c6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Hono](https://img.shields.io/badge/Hono.js-Ultra--Fast-e36002?style=for-the-badge&logo=hono&logoColor=white)](https://hono.dev)
[![Tests](https://img.shields.io/badge/Tests-33%20Passing-22c55e?style=for-the-badge&logo=vitest&logoColor=white)](https://vitest.dev)
[![License](https://img.shields.io/badge/License-MIT-8b5cf6?style=for-the-badge)](LICENSE)

<p align="center">
  Turn any personal or merchant GoBiz account into an automated, zero-fee payment gateway.<br/>
  Generate dynamic QRIS codes, reconcile transactions in real time, and dispatch instant webhooks to your online store.
</p>

[Key Features](#-key-features) • [Why KaiGoBiz](#-why-kaigobiz) • [Architecture](#-architecture--payment-flow) • [Quick Start](#-quick-start) • [Integration Modes](#-integration-modes) • [API Reference](#-rest-api-reference)

</div>

---

## 🚀 Key Features

- **Dynamic QRIS Generator**: Generates custom-amount QRIS payments on the fly from any static GoBiz QRIS template using EMVCo Tag 54 injection and CRC16 CCITT recalculation.
- **Automated Background Reconciliation**: Built-in reconciler polls the GoBiz Wallstreet Journal API every 7 seconds, matches transactions by amount and timestamp, and updates orders to `PAID`.
- **GoBiz Sen Currency Normalization**: Automatically converts Gojek Wallstreet minor currency units (sen x100, e.g. 100000 sen = Rp 1.000) to standard Rupiah transparently.
- **Three Flexible Checkout Modes**:
  1. **Hosted Checkout Page** (`/pay/:paymentId`): Pre-built responsive payment page with QR code, live countdown, and audio notifications.
  2. **Embeddable Modal Widget** (`kaigobiz.js`): Lightweight (~15KB) modal popup script that works on any website with a single `<script>` tag.
  3. **Headless REST API**: Full JSON API for custom mobile apps, e-commerce backends (Laravel, Express, Django), and 100% white-label checkouts.
- **Instant Webhook Engine**: Dispatches HTTP POST notifications to your backend when customer payments settle, with support for per-order callbacks.
- **QRIS Studio**: Multi-engine QR extraction featuring client-side `jsQR` HTML5 Canvas (drag & drop, clipboard paste `Ctrl+V`, camera) and server-side Python fallback (`zxingcpp`, `pyzbar`, and PDF posters via `pdftoppm`).
- **Glassmorphism Admin Dashboard**: Manage GoBiz SMS OTP login, test payments, monitor live mutasi transactions, and configure webhooks with modern dark mode UI.

---

## 💡 Why KaiGoBiz?

| Capability | KaiGoBiz | Third-Party Gateway (Midtrans/Xendit) | Manual Bank Transfer |
| :--- | :--- | :--- | :--- |
| **Gateway Transaction Fee** | **Rp 0** (Free & Self-Hosted) | Rp 750 to Rp 4.500 + MDR per tx | Rp 0 |
| **Merchant MDR** | Standard 0.3% GoBiz official | 0.7% to 1.5% + Gateway markup | 0% |
| **Settlement Payout** | **Direct to GoBiz (H+0 / H+1)** | Held for days (H+2 to H+7 payout) | Immediate but unverified |
| **Corporate Legal Entity** | **Not Required** (Personal GoBiz OK) | Required (KTP, NPWP, SIUP, NIB) | Not Required |
| **Dynamic Amount QRIS** | **Yes** (Exact amount, zero manual input)| Yes | No (Customer types amount) |
| **Auto Verification** | **Yes** (Real-time mutasi polling) | Yes | No (Manual mutation checking) |
| **Hosted Checkout Page** | **Yes** (`/pay/:paymentId`) | Yes | No |
| **Embeddable Modal** | **Yes** (`kaigobiz.js` ~15KB) | Yes (Heavy iframe) | No |
| **Instant Webhooks** | **Yes** (HTTP POST) | Yes | No |

---

## 📐 Architecture & Payment Flow

```mermaid
sequenceDiagram
    autonumber
    actor Customer as Customer
    participant Store as Online Store
    participant Kai as KaiGoBiz Server (Port 3636)
    participant GoBiz as GoBiz Wallstreet API

    Store->>Kai: POST /api/v1/payment/create (orderId, amount, callbackUrl)
    Kai-->>Store: Returns paymentId, checkoutUrl, and QRIS Base64
    Store->>Customer: Display Modal Widget or Redirect to /pay/:paymentId
    Customer->>GoBiz: Scans QRIS & Pays via GoPay / BCA / OVO / Dana / ShopeePay
    loop Every 7s Background Reconciler
        Kai->>GoBiz: Poll Journal Transactions (normalize sen x100)
        GoBiz-->>Kai: Return verified settlement records
    end
    Kai->>Kai: Match order by amount and timestamp
    Kai->>Customer: UI updates to PAID with success chime
    Kai->>Store: Webhook POST event: payment.success
```

---

## ⚡ Quick Start

### Option A: 1-Click Automated Installer (Recommended for Linux VPS)

The installer script automatically configures OS packages, Python QR engines, Node.js 20 LTS, project dependencies, builds production assets, and launches PM2:

```bash
# Direct run from cloned folder
./install.sh

# Or one-line automated install directly from GitHub
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

#### 2. Configure Environment (`.env`)

Create a `.env` file in the root directory:

```env
PORT=3636
NODE_ENV=production
# Optional global fallback webhook URL
WEBHOOK_URL=https://your-domain.com/api/payment-webhook
# Optional default QRIS template (can also be saved via Dashboard)
STATIC_QRIS_TEMPLATE=00020101021126390013ID.GO-JEK.WWW01189360091430000000005204581253033605802ID5914KAI GOBIZ SHOP6007JAKARTA63045B63
```

#### 3. Build & Run

```bash
# Build frontend dashboard and embeddable widget
npm run build

# Start the server directly
npm run server

# Or run in background 24/7 with PM2
pm2 start "npm run server" --name kaigobiz
pm2 save
```

Access the Admin Dashboard at: `http://localhost:3636`

---

## ⚙️ Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Listening HTTP port for API, Dashboard, and Checkout | `3636` |
| `NODE_ENV` | Runtime environment (`production` or `development`) | `production` |
| `WEBHOOK_URL` | Global fallback webhook URL for payment notifications | `null` |
| `WEBHOOK_SECRET` | Secret key for generating HMAC-SHA256 signature headers | `null` |
| `STATIC_QRIS_TEMPLATE` | Fallback EMVCo static QRIS string for dynamic injection | Built-in template |

---

## 🛍️ Integration Modes

KaiGoBiz supports three distinct integration approaches depending on your application needs:

### Mode 1: Hosted Checkout Page (Recommended)

Redirect customers to a pre-built, responsive checkout page (`http://IP:3636/pay/:paymentId`). Similar to Midtrans Snap or Stripe Checkout.

#### 1. Create Payment Order from Backend

##### Standard Mode (Exact Amount):
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

##### Flash Sale / Unique Code Mode:
When selling fixed-price products to multiple buyers simultaneously, enable `useUniqueCode` so each buyer receives a distinct payable amount (e.g. Rp 50.124). This guarantees 100% collision-free automatic reconciliation.

```bash
curl -X POST http://localhost:3636/api/v1/payment/create \
  -H "Content-Type: application/json" \
  -d '{
    "orderId": "INV-2026-002",
    "amount": 50000,
    "expiryMinutes": 5,
    "callbackUrl": "https://yourshop.com/webhook",
    "useUniqueCode": true,
    "uniqueCodeMin": 1,
    "uniqueCodeMax": 250,
    "uniqueCodeType": "ADD"
  }'
```

**Response (HTTP 201 / 200):**
```json
{
  "success": true,
  "paymentId": "pay_1753470123456_a9b8c",
  "orderId": "INV-2026-002",
  "amount": 50124,
  "rawAmount": 50000,
  "uniqueCode": 124,
  "qrisString": "00020101021226610014COM.GO-JEK.WWW...540550124...6304A1B2",
  "qrisQrUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
  "checkoutUrl": "http://localhost:3636/pay/pay_1753470123456_a9b8c",
  "expiresAt": "2026-09-15T11:30:00.000Z",
  "callbackUrl": "https://yourshop.com/webhook"
}
```

#### 2. Redirect Customer

Redirect your customer's browser to `checkoutUrl`. The page manages QR display, real-time status polling, countdown timer, copy-to-clipboard for the exact payable amount, and banking app deep links automatically.

---

### Mode 2: Embeddable Modal Widget (`kaigobiz.js`)

Keep customers on your website with an in-page modal dialog. Zero page redirects.

```html
<!-- Load KaiGoBiz Widget (~15KB) -->
<script src="http://localhost:3636/kaigobiz.js"></script>

<button id="pay-btn" type="button">Bayar Sekarang</button>

<script>
  document.getElementById('pay-btn').addEventListener('click', () => {
    KaiGoBiz.checkout({
      endpoint: "http://localhost:3636",
      orderId: "INV-2026-003",
      amount: 50000,
      expiryMinutes: 10,
      callbackUrl: "https://yourshop.com/webhook",
      useUniqueCode: true,
      uniqueCodeMax: 250,
      uniqueCodeType: "ADD",
      onSuccess: (payment) => {
        alert("Pembayaran berhasil untuk order " + payment.orderId);
        window.location.href = "/order/thank-you";
      },
      onPending: (payment) => {
        console.log("Menunggu pembayaran...", payment);
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

### Mode 3: Headless API & Custom UI (100% White-Label)

Build your own customized checkout interface without any KaiGoBiz branding.

#### Step 1: Create Payment on Backend

##### PHP / Laravel
```php
<?php

$payload = [
    'orderId'        => 'INV-' . time(),
    'amount'         => 75000,
    'expiryMinutes'  => 15,
    'callbackUrl'    => 'https://tokoanda.com/api/payment-callback',
    'useUniqueCode'  => true,
    'uniqueCodeMax'  => 250,
    'uniqueCodeType' => 'ADD'
];

$ch = curl_init('http://localhost:3636/api/v1/payment/create');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));

$response = curl_exec($ch);
curl_close($ch);

$data = json_decode($response, true);
// Gunakan $data['amount'] (nominal wajib bayar), $data['paymentId'], dan $data['qrisQrUrl'] di Blade template
```

##### Node.js / Express
```javascript
import axios from 'axios';

app.post('/api/checkout', async (req, res) => {
  try {
    const response = await axios.post('http://localhost:3636/api/v1/payment/create', {
      orderId: `ORDER-${Date.now()}`,
      amount: req.body.totalAmount,
      expiryMinutes: 10,
      callbackUrl: 'https://myshop.com/api/webhook',
      useUniqueCode: true,
      uniqueCodeMax: 250,
      uniqueCodeType: 'ADD'
    });

    res.json({
      paymentId: response.data.paymentId,
      orderId: response.data.orderId,
      amount: response.data.amount,
      rawAmount: response.data.rawAmount,
      uniqueCode: response.data.uniqueCode,
      qrisQrUrl: response.data.qrisQrUrl,
      expiresAt: response.data.expiresAt
    });
  } catch (error) {
    const errMessage = error.response?.data?.error || 'Gagal membuat pembayaran';
    res.status(400).json({ error: errMessage });
  }
});
```

#### Step 2: Render Custom UI & Poll Status on Frontend

```html
<div class="custom-checkout-card">
  <h3>Pembayaran QRIS</h3>
  <div id="order-label">Order: #INV-10023</div>
  <div class="price" id="pay-amount">Rp 50.124</div>

  <!-- Render Base64 QRIS Image -->
  <img id="qris-img" src="" alt="Kode QRIS" width="220" />

  <p>Pindai menggunakan aplikasi GoPay, BCA, OVO, Dana, ShopeePay, atau mobile banking apa saja.</p>
  <div id="payment-status">Menunggu pembayaran...</div>
</div>

<script>
  const paymentId = "PAYMENT_ID_FROM_BACKEND";
  const qrisQrUrl = "QRIS_QR_URL_FROM_BACKEND";

  document.getElementById('qris-img').src = qrisQrUrl;

  // Poll status endpoint every 3 seconds
  const pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://localhost:3636/api/v1/payment/status/${paymentId}`);
      const data = await res.json();

      if (data.status === 'PAID') {
        clearInterval(pollTimer);
        document.getElementById('payment-status').textContent = 'Pembayaran Berhasil!';
        setTimeout(() => {
          window.location.href = '/checkout/success?order=' + encodeURIComponent(data.orderId);
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

## 🔔 Webhook Notifications

When a payment is matched by the background reconciler, KaiGoBiz dispatches an HTTP POST webhook notification to your configured URL.

### Security Headers

Every webhook dispatch includes standard headers and an HMAC-SHA256 signature when `WEBHOOK_SECRET` is configured:

| Header | Description | Example |
| :--- | :--- | :--- |
| `Content-Type` | MIME payload type | `application/json` |
| `User-Agent` | Webhook client identity | `KaiGoBiz-Webhook/1.0` |
| `X-KaiGoBiz-Timestamp` | ISO 8601 creation timestamp | `2026-09-16T14:05:00.000Z` |
| `X-KaiGoBiz-Signature` | HMAC-SHA256 signature (if configured) | `sha256=a1b2c3d4e5f6...` |

> [!NOTE]
> SSRF Protection: KaiGoBiz automatically verifies destination URLs and blocks deliveries targeting private networks (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`), loopback (`127.0.0.1`, `localhost`), and internal hostnames.

### Webhook Delivery & Retries

- **Timeout**: Each HTTP dispatch times out after 10 seconds.
- **Automatic Retries**: If your server returns an HTTP non-2xx status code or connection fails, the reconciler automatically retries delivery up to **5 times** with a **30-second backoff** window.

### Webhook Payload Schema

```json
{
  "event": "payment.success",
  "paymentId": "pay_1753470123456_a9b8c",
  "orderId": "INV-2026-002",
  "amount": 50124,
  "status": "PAID",
  "paidAt": "2026-09-16T14:05:00.000Z",
  "transactionId": "f4b8a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "timestamp": "2026-09-16T14:05:00.000Z"
}
```

### Webhook Verification Code Examples

#### Node.js / Express Webhook Receiver (with Signature Verification)

```javascript
import express from 'express';
import crypto from 'crypto';

const app = express();
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your-webhook-secret';

// Capture raw body string to verify HMAC signature
app.post('/api/webhook', express.json({
  verify: (req, _res, buf) => {
    req.rawBody = buf.toString();
  }
}), (req, res) => {
  const signatureHeader = req.headers['x-kaigobiz-signature'];

  // Verify HMAC-SHA256 signature if secret is active
  if (WEBHOOK_SECRET && signatureHeader) {
    const expectedSignature = 'sha256=' + crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(req.rawBody)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature);
    const signatureBuffer = Buffer.from(signatureHeader);

    if (
      expectedBuffer.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, signatureBuffer)
    ) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }
  }

  const { event, orderId, amount, transactionId, status } = req.body;

  if (event === 'payment.success' && status === 'PAID') {
    console.log(`Order ${orderId} lunas sebesar Rp ${amount}. Ref GoBiz: ${transactionId}`);
    // Update status pesanan di database Anda
  }

  return res.status(200).json({ received: true });
});
```

#### PHP / Laravel Webhook Receiver (with Signature Verification)

```php
<?php

$rawBody = file_get_contents('php://input');
$signatureHeader = $_SERVER['HTTP_X_KAIGOBIZ_SIGNATURE'] ?? null;
$webhookSecret = getenv('WEBHOOK_SECRET') ?: 'your-webhook-secret';

if ($webhookSecret && $signatureHeader) {
    $expectedSignature = 'sha256=' . hash_hmac('sha256', $rawBody, $webhookSecret);
    if (!hash_equals($expectedSignature, $signatureHeader)) {
        http_response_code(401);
        echo json_encode(['error' => 'Invalid webhook signature']);
        exit;
    }
}

$payload = json_decode($rawBody, true);

if (($payload['event'] ?? '') === 'payment.success' && ($payload['status'] ?? '') === 'PAID') {
    $orderId = $payload['orderId'];
    $amount = $payload['amount'];
    $txId = $payload['transactionId'] ?? null;

    // Tandai pesanan lunas di database Anda
}

http_response_code(200);
echo json_encode(['received' => true]);
```

---

## 📡 REST API Reference

### Overview of Endpoints

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `POST` | `/api/v1/payment/create` | Create dynamic QRIS payment with optional unique code |
| `GET` | `/api/v1/payment/status/:paymentId` | Check status with coalesced live reconciliation |
| `GET` | `/api/v1/payment/template` | Inspect current static QRIS template and merchant data |
| `POST` | `/api/v1/payment/template` | Save or update active static QRIS template |
| `POST` | `/api/v1/payment/decode-qr` | Server-side QR extraction from Base64 or image file |
| `GET` | `/api/v1/payment/webhook-config` | Retrieve global webhook URL |
| `POST` | `/api/v1/payment/webhook-config` | Update global webhook URL |
| `GET` | `/api/v1/auth/status` | Check GoBiz connection status and session token validity |
| `POST` | `/api/v1/auth/request-otp` | Request GoBiz SMS login OTP (cooldown 20s) |
| `POST` | `/api/v1/auth/verify-otp` | Verify SMS OTP and save session tokens |
| `POST` | `/api/v1/auth/logout` | Disconnect and clear GoBiz session |
| `GET` | `/api/v1/transactions` | Fetch live GoBiz transactions (sen-normalized) |
| `GET` | `/api/v1/health` | Server health check, uptime, and timestamp |
| `GET` | `/pay/:paymentId` | Customer-facing hosted checkout page |

---

### `POST /api/v1/payment/create`

Generate dynamic QRIS for a new payment order.

#### Request Parameters (JSON Body)

| Parameter | Type | Required | Default | Description |
| :--- | :--- | :--- | :--- | :--- |
| `orderId` | `string` | **Yes** | - | Unique merchant order reference (1 to 100 characters) |
| `amount` | `number` | **Yes** | - | Payable base amount in Rupiah (integer between 1 and 100.000.000) |
| `expiryMinutes` | `number` | No | `5` | Order expiration time in minutes (1 to 1440) |
| `callbackUrl` | `string` | No | `null` | Order-specific HTTP/HTTPS webhook URL (SSRF validated) |
| `useUniqueCode` | `boolean` | No | `false` | Enable automatic unique code allocation for collision avoidance |
| `uniqueCodeMin` | `number` | No | `1` | Lower boundary for random unique code (minimum: 1) |
| `uniqueCodeMax` | `number` | No | `250` | Upper boundary for random unique code (maximum: 9999) |
| `uniqueCodeType` | `string` | No | `'ADD'` | Allocation strategy: `'ADD'` (adds code to amount) or `'SUBTRACT'` (deducts code) |

#### Response Schema (HTTP 201 / 200)

```json
{
  "success": true,
  "paymentId": "pay_1753470123456_a9b8c",
  "orderId": "INV-2026-002",
  "amount": 50124,
  "rawAmount": 50000,
  "uniqueCode": 124,
  "qrisString": "00020101021226610014COM.GO-JEK.WWW...540550124...6304A1B2",
  "qrisQrUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg...",
  "checkoutUrl": "http://localhost:3636/pay/pay_1753470123456_a9b8c",
  "expiresAt": "2026-09-15T11:30:00.000Z",
  "callbackUrl": "https://yourshop.com/webhook",
  "reused": false
}
```

---

### `GET /api/v1/payment/status/:paymentId`

Retrieve current status of a payment order.

#### URL Parameters
- `paymentId` (`string`, required): Unique payment identifier returned by the creation endpoint.

#### Response Schema (HTTP 200)

```json
{
  "success": true,
  "paymentId": "pay_1753470123456_a9b8c",
  "orderId": "INV-2026-002",
  "amount": 50124,
  "status": "PAID",
  "expiresAt": "2026-09-15T11:30:00.000Z",
  "createdAt": "2026-09-15T11:20:00.000Z",
  "paidAt": "2026-09-15T11:22:15.000Z",
  "transactionId": "f4b8a1c2-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
  "qrisString": "00020101021226610014COM.GO-JEK.WWW...540550124...6304A1B2",
  "qrisQrUrl": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
}
```

---

## 🧮 GoBiz Sen Currency Normalization

Gojek Wallstreet Journal API reports transaction gross amounts in minor currency units (*sen* / cents, factor of 100):
- A payment of **Rp 1.000** is reported as `100000` in the GoBiz API.
- The 0.3% MDR fee is reported as `300` (Rp 3).

KaiGoBiz handles this normalization automatically in `GoBizClient` and `Reconciler`. Both raw minor units and normalized Rupiah values are matched with clock-skew tolerance, ensuring zero discrepancies.

---

## 🧪 Testing

Run the Vitest unit and integration test suite:

```bash
npm test
```

All core components (EMVCo parser, dynamic amount injection, CRC16 CCITT validation, storage adapters, server routes, and webhooks) are covered by automated tests.

---

## 🚢 Production PM2 Operations

Keep KaiGoBiz running 24/7 on your Linux VPS using PM2:

```bash
# Start process
pm2 start "npm run server" --name kaigobiz

# Save process list across system reboots
pm2 save
pm2 startup

# Monitor live logs
pm2 logs kaigobiz

# Restart service
pm2 restart kaigobiz

# Check status
pm2 status
```

---

## 🔒 Security & Privacy

- All GoBiz session tokens (`.kaigobiz-session.json`) and local configuration files (`.env`, `.kaigobiz-config.json`) are strictly excluded from version control via `.gitignore`.
- KaiGoBiz communicates directly with official GoBiz endpoints using native HTTPS requests.
- No intermediary proxy or third-party cloud servers have access to your credentials or transaction logs.

---

## 📄 License

MIT License (c) 2026 KaiGoBiz Team

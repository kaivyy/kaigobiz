# 🚀 KaiGoBiz Payment Gateway & Scraper

> **High-Performance TypeScript GoBiz/GoPay Payment Gateway & Scraper**  
> Built with Hono.js, Dynamic QRIS Generator (EMVCo CRC16), Pluggable Storage Adapters, Embeddable Payment Widget (`kaigobiz.js`), and Modern Glassmorphism Dashboard UI.

---

## ⚡ Features

- 🚀 **Ultra-Fast & Lightweight**: Built on Hono.js with native HTTP REST API calls (< 1ms overhead, zero browser dependency).
- 🔒 **TypeScript Native**: 100% strict type safety for APIs, Session Data, QRIS payloads, and Mutasi events.
- 💳 **Dynamic QRIS Generator**: Generates custom-amount QRIS payments using EMVCo CRC16 checksum calculation.
- 📱 **Embeddable Payment Widget**: Instant checkout modal (`kaigobiz.js` ~15KB) that integrates into any website with **just 1 line of script**.
- 🔄 **Auto Session Refresh**: Background auto-renewal of `access_token` via `refresh_token` without re-login interrupts.
- 💾 **Pluggable Storage System**:
  - `FileStorageAdapter` (Default: Local JSON / SQLite)
  - `CloudflareD1StorageAdapter` (Optional: Free Cloudflare D1 Cloud Sync)
- 🎨 **Modern Dashboard UI**: Built-in Dark Mode & Glassmorphism Web Admin to manage OTP auth, test QRIS, and view mutasi transactions.

---

## 🛠️ Tech Stack

- **Core & Server:** TypeScript 5.x, Hono.js, `@hono/node-server`, Axios, QRCode
- **Build & Bundler:** Vite, tsup, Vitest, PM2
- **UI & Widget:** HTML5, Vanilla CSS Modern (Glassmorphism, CSS Variables, Backdrop Blur)

---

## 🚀 Quick Start

### 1. Installation

```bash
cd /root/kaigobiz
npm install
```

### 2. Configuration (`.env`)

Create a `.env` file in the root directory (optional, sensible defaults provided):

```env
PORT=3000
NODE_ENV=production
STATIC_QRIS_TEMPLATE=00020101021226580014ID.GO-JEK.WWW01189360091430000000005204581253033605802ID5913KAI GOBIZ SHOP6007JAKARTA6304ABCD
```

### 3. Build & Run

```bash
# Build production bundle and widget
npm run build

# Start production server (Node.js)
npm run server

# Or run with PM2 background process
pm2 start "npm run server" --name kaigobiz
```

---

## 📱 How to Integrate Widget into Your Website

Integrating KaiGoBiz into your e-commerce or custom website takes just **1 line of JavaScript**:

```html
<!-- Include KaiGoBiz Widget Script -->
<script src="http://localhost:3000/kaigobiz.js"></script>

<script>
  // Trigger checkout modal on button click
  document.getElementById('pay-btn').addEventListener('click', () => {
    KaiGoBiz.checkout({
      endpoint: "http://localhost:3000",
      orderId: "INV-2026-001",
      amount: 50000,
      onSuccess: (payment) => {
        alert("Payment Successful! Order: " + payment.orderId);
      },
      onExpired: () => {
        alert("Payment time expired.");
      },
      onError: (err) => {
        console.error("Payment error:", err);
      }
    });
  });
</script>
```

---

## 📡 REST API Documentation

### 1. Auth & Session

#### `GET /api/v1/auth/status`
Checks current GoBiz session connection and token validity.

```json
{
  "connected": true,
  "session": {
    "phone_number": "6281234567890",
    "outlet_name": "KaiGoBiz Shop",
    "merchant_id": "M-123456",
    "expires_at": "2026-07-26T18:00:00.000Z"
  }
}
```

#### `POST /api/v1/auth/request-otp`
Requests GoBiz OTP code sent via SMS.

**Body:**
```json
{
  "phone": "081234567890"
}
```

#### `POST /api/v1/auth/verify-otp`
Verifies OTP code and initializes session.

**Body:**
```json
{
  "phone": "081234567890",
  "otp": "123456",
  "otpToken": "TOKEN_FROM_REQUEST_OTP"
}
```

---

### 2. Payment Gateway & QRIS

#### `POST /api/v1/payment/create`
Creates a dynamic QRIS payment order.

**Body:**
```json
{
  "orderId": "INV-101",
  "amount": 50000,
  "expiryMinutes": 5
}
```

**Response:**
```json
{
  "success": true,
  "paymentId": "pay_1753470000000_abc12",
  "orderId": "INV-101",
  "amount": 50000,
  "qrisString": "000201010212...63041A2B",
  "qrisQrUrl": "data:image/png;base64,...",
  "expiresAt": "2026-07-25T19:05:00.000Z"
}
```

#### `GET /api/v1/payment/status/:paymentId`
Polls payment status (`PENDING`, `PAID`, or `EXPIRED`).

---

### 3. Transactions & Mutasi

#### `GET /api/v1/transactions`
Fetches real-time GoBiz transaction history and syncs to storage.

---

## 🧪 Testing

Run unit & integration test suites powered by Vitest:

```bash
npm test
```

---

## 📄 License

MIT License © 2026 KaiGoBiz Team

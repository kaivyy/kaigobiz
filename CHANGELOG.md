# Changelog

All notable changes to the **KaiGoBiz** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.1.1] - 2026-09-16

### ✨ Added
- **Dynamic Unique Code (Kode Unik) Allocation for Flash Sales**:
  - Added optional `useUniqueCode`, `uniqueCodeMin`, `uniqueCodeMax` (default: 250), and `uniqueCodeType` (`ADD` | `SUBTRACT`) parameters to `POST /api/v1/payment/create`.
  - Ensures 100% collision-free automatic reconciliation during high-concurrency flash sales by allocating distinct payable amounts (e.g., Rp 50.124).
  - Extended response schema with `amount` (final payable amount), `rawAmount` (base price), and `uniqueCode` (allocated random code).
  - Integrated into Hosted Checkout Page, Embeddable Modal Widget (`kaigobiz.js`), and Dashboard QRIS Studio.
- **HMAC-SHA256 Webhook Signatures (`WEBHOOK_SECRET`)**:
  - Every webhook dispatch includes `X-KaiGoBiz-Signature: sha256=<hmac>` computed over the raw JSON payload when `WEBHOOK_SECRET` is configured.
  - Added `X-KaiGoBiz-Timestamp` and `User-Agent: KaiGoBiz-Webhook/1.0` headers.
  - Added signature verification examples for Node.js/Express (with timing-safe comparison) and PHP/Laravel (`hash_equals`).
- **Webhook Automatic Retries**:
  - Background reconciler automatically retries failed webhook notifications (`callbackStatus === 'FAILED'`) up to 5 times with a 30-second backoff window.
- **Server-Side Request Forgery (SSRF) Protection**:
  - Validates all callback URLs, rejecting loopback (`127.0.0.1`), RFC 1918 private subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`), and internal hostnames.
- **Interactive Kode Unik Controls in Dashboard QRIS Studio**:
  - Added checkbox toggle, allocation strategy selector (`ADD` / `SUBTRACT`), and maximum code input directly in the dashboard UI.
  - Live preview badge displays the real-time breakdown of the base amount and unique code.
- **Proactive Background Session Heartbeat**:
  - Background reconciler executes a 60-second idle token check, automatically refreshing access tokens before expiration during periods without customer transactions.
- **High-Concurrency Request Coalescing**:
  - Added `fetchTransactionsCoalesced` single-flight deduplication with a 2.5-second cooldown on GoBiz Wallstreet Journal API calls to prevent rate-limiting during traffic spikes.
- **Double-Settlement Defense**:
  - Persisted `transactionId` on `PaymentOrder` and implemented strict `getUsedTransactionIds` across reconciler and status routes to prevent duplicate settlement of orders with identical amounts.
  - Enforced chronological FIFO matching: orders are matched by `createdAt ASC` against earliest valid transaction timestamps.

### 🔒 Security & Reliability
- **Anti-Bot Jitter & Modern Fingerprinting**:
  - Replaced static 7-second polling timer with self-scheduling randomized jitter (5s - 11s, +/- 25% variation).
  - Modernized simulated client fingerprint to Windows 10 x64 Chrome 133 with valid `sec-ch-ua` headers.
- **OTP Endpoint Rate Limiting**:
  - Implemented 20-second cooldown on `POST /api/v1/auth/request-otp` returning HTTP 429 Too Many Requests.
- **Stored XSS Sanitization in Checkout Page**:
  - Sanitized embedded JSON payload (`orderJson.replace(/</g, '\\u003c')`), escaped HTML attributes on QR URL, and restricted redirect URLs to valid HTTP/HTTPS protocols.
- **Atomic File Storage (`writeAtomic`)**:
  - Replaced direct `fs.writeFileSync` in `FileStorageAdapter` with temporary file creation and atomic rename (`writeAtomic`) to eliminate JSON file corruption during abrupt server restarts.
- **Memory Exhaustion / Large Payload Protection**:
  - Enforced 10MB limit and HTTP 413 Payload Too Large protection on `POST /api/v1/payment/decode-qr`.

### 🧪 Tests & Documentation
- **Expanded Test Suite**:
  - Added comprehensive automated tests for unique code assignment, subtraction, amount boundary validations, and anti-duplicate settlements (33 passing tests).
- **Documentation Overhaul**:
  - Fully documented all three integration modes, webhook verification guides, and complete REST API parameters in `README.md`.

---

## [1.1.0] - 2026-09-15

### ✨ Added
- **Hosted Checkout Page (`/pay/:paymentId`)**:
  - Full responsive customer checkout page with live countdown, QRIS image display, auto-refresh status polling, audio payment chimes, and deep links to GoPay / banking apps.
- **Automated Background Reconciler & Webhooks (`reconciler.ts`)**:
  - Background worker that polls the GoBiz Wallstreet Journal API every 7 seconds.
  - Automatic order matching against incoming mutasi by amount and timestamp with clock-skew tolerance.
  - Instant HTTP POST webhook dispatching upon settlement with customizable `callbackUrl`.
- **Dual QR Scanning Engine & QRIS Studio**:
  - Client-side `jsQR` HTML5 Canvas scanner supporting file upload, drag and drop, clipboard paste (`Ctrl+V`), and webcam scanning.
  - Server-side Python fallback (`decode_qr.py`) powered by `zxingcpp`, `pyzbar`, `opencv-python-headless`, and `pdftoppm` for GoBiz PDF poster extraction.
- **1-Click Automated Linux VPS Installer (`install.sh`)**:
  - Unattended installation script handling OS packages, Python QR engines, Node.js 20 LTS, build assets, and PM2 deployment.
- **Headless API & Custom UI Integration Guide**:
  - End-to-end integration examples for PHP / Laravel, Node.js / Express, and white-label custom HTML / JavaScript frontend polling.
- **QRIS Template Management Endpoints**:
  - Added `GET /api/v1/payment/template` and `POST /api/v1/payment/template` for active merchant template inspection and persistence.
- **Global and Per-Order Webhook Support**:
  - Added `GET /api/v1/payment/webhook-config` and `POST /api/v1/payment/webhook-config`.

### 🔄 Changed
- **Default Port Updated to 3636**:
  - Migrated default server port from 3001 to 3636 across server core, environment config, installer, and documentation.
- **GoBiz Wallstreet Minor Currency Normalization**:
  - Transparently normalizes Gojek minor currency units (sen / cents, factor of 100) to standard Rupiah.
- **Expanded Test Suite**:
  - Added integration tests for webhooks, custom callback propagation, and reconciliation matching (26 passing tests).

### 🐛 Fixed
- **Clipboard Copying on Non-SSL HTTP**:
  - Implemented `document.execCommand('copy')` fallback in dashboard UI so script tag copying works without HTTPS.
- **Transparent PNG Decoding**:
  - Added RGBA alpha-to-white composite pre-processing to prevent QR matrix corruption on transparent PNG uploads.

---

## [1.0.0] - 2026-07-25

### ✨ Added
- **TypeScript 5.x Native Architecture**:
  - Full type safety for all GoBiz API responses, Session Data, QRIS payloads, and transaction items.
- **Hono.js REST API Server**:
  - Ultra-fast HTTP REST API endpoints (`/api/v1/auth`, `/api/v1/payment`, `/api/v1/transactions`, `/api/v1/health`).
  - Native CORS middleware support for cross-origin payment widget integration.
  - Sub-millisecond routing overhead.
- **EMVCo CRC16 Dynamic QRIS Generator (`qris-generator.ts`)**:
  - Standard EMVCo CCITT 16-bit CRC checksum calculation algorithm.
  - Dynamic amount Tag 54 injection & automatic CRC 6304 recalculation.
  - Built-in QR Code Base64 Data URL renderer using `qrcode`.
- **Session Manager & Auto-Refresh (`session-manager.ts`)**:
  - Complete OTP authentication flow (`requestOTP`, `verifyOTP`).
  - Automated background renewal of `access_token` via `refresh_token` with 5-minute expiration buffer.
- **Pluggable Storage System (`storage/`)**:
  - `StorageAdapter` TypeScript interface.
  - `FileStorageAdapter` for zero-config local JSON & SQLite file persistence (`.kaigobiz-session.json`, `.kaigobiz-tx.json`, `.kaigobiz-orders.json`).
  - Extensible design for Cloudflare D1 / PostgreSQL / Redis storage backends.
- **Embeddable Payment Widget (`kaigobiz.js`)**:
  - Single-line integration script for third-party websites (`KaiGoBiz.checkout()`).
  - Modern Glassmorphism modal popup overlay with dark mode aesthetics.
  - Real-time countdown timer & background payment status polling.
  - Bundled & minified via `tsup` into a lightweight standalone file (~15KB).
- **Modern Admin Dashboard UI (`src/dashboard`)**:
  - Responsive glassmorphism web interface.
  - Live session status badge (Online/Offline indicator).
  - Interactive OTP Login forms.
  - Dynamic QRIS Playground for testing checkouts.
  - Real-time Transaction history feed with instant refresh.
- **Comprehensive Unit & Integration Test Suite**:
  - 19 automated tests powered by `vitest` covering storage adapters, QRIS generation, session managers, and Hono server routes.

---

### 🔧 Performance & Build Optimizations
- Integrated `vite` and `tsup` for rapid development and optimized production builds.
- Added PM2 process management support for background execution.

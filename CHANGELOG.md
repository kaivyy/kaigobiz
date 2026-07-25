# Changelog

All notable changes to the **KaiGoBiz** project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

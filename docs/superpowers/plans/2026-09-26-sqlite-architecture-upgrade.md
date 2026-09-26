# SQLite Architecture Upgrade and Integration Documentation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade KaiGoBiz storage architecture from JSON flat files to high-performance SQLite WAL mode using Node 26 native `node:sqlite`, with atomic partial indexes for unique codes, seamless JSON data migration, full test coverage, and comprehensive documentation for e-commerce integration and high-scale transactions.

**Architecture:** Implement `SqliteStorageAdapter` implementing `StorageAdapter` interface using native `node:sqlite` (`DatabaseSync`). Configure `PRAGMA journal_mode = WAL`, `PRAGMA busy_timeout = 5000`, `PRAGMA synchronous = NORMAL`, and partial index `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_order_amount ON payment_orders(amount) WHERE status = 'PENDING'`. Replace `FileStorageAdapter` across routes, reconciler, and server with auto-migrating SQLite storage. Write comprehensive integration and scaling documentation.

**Tech Stack:** Node.js v26.8.2 (`node:sqlite` / `DatabaseSync`), TypeScript, Hono, Vitest.

## Global Constraints

- Use native `node:sqlite` (`DatabaseSync`) without adding external npm dependencies.
- Zero em dashes in documentation and user responses (antislop rule).
- Maintain 100% backward compatibility with existing `StorageAdapter` interface.
- Automatic migration: if `.kaigobiz-orders.json`, `.kaigobiz-tx.json`, or `.kaigobiz-session.json` exist, import data on initialization.
- All existing and new tests must pass (`npm test`).

---

### Task 1: Implement `SqliteStorageAdapter`

**Files:**
- Create: `src/core/storage/sqlite-storage.ts`
- Modify: `src/core/storage/storage.interface.ts`
- Test: `tests/sqlite-storage.test.ts`

**Interfaces:**
- Consumes: `SessionData`, `TransactionData`, `PaymentOrder`, `StorageAdapter` from `src/core/storage/storage.interface.ts`
- Produces: `SqliteStorageAdapter` class implementing `StorageAdapter` with methods:
  - `getSession(): Promise<SessionData | null>`
  - `saveSession(session: SessionData): Promise<boolean>`
  - `clearSession(): Promise<boolean>`
  - `saveTransaction(tx: TransactionData): Promise<boolean>`
  - `saveTransactions(txs: TransactionData[]): Promise<boolean>`
  - `getTransactions(): Promise<TransactionData[]>`
  - `savePaymentOrder(order: PaymentOrder): Promise<boolean>`
  - `getPaymentOrder(paymentId: string): Promise<PaymentOrder | null>`
  - `getAllPaymentOrders(): Promise<PaymentOrder[]>`
  - `backup(targetPath: string): Promise<boolean>`
  - `close(): void`

- [ ] **Step 1: Update `StorageAdapter` interface in `storage.interface.ts`**
  Add optional `clearSession?()`, `backup?(targetPath: string): Promise<boolean>`, and `close?(): void` to `StorageAdapter`.

- [ ] **Step 2: Create `src/core/storage/sqlite-storage.ts`**
  Implement `SqliteStorageAdapter` with:
  - `PRAGMA journal_mode = WAL;`
  - `PRAGMA busy_timeout = 5000;`
  - `PRAGMA synchronous = NORMAL;`
  - Table schemas: `session`, `payment_orders`, `transactions`.
  - Partial unique index: `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_order_amount ON payment_orders(amount) WHERE status = 'PENDING';`
  - Performance indexes on `(status, expires_at)` and `timestamp`.
  - Auto-migration from `.kaigobiz-orders.json`, `.kaigobiz-tx.json`, `.kaigobiz-session.json`.
  - Atomic upsert for orders and transactions.
  - Backup method using `VACUUM INTO ?`.

- [ ] **Step 3: Create tests in `tests/sqlite-storage.test.ts`**
  Write tests covering:
  - Table initialization and PRAGMA settings.
  - Session save, get, clear.
  - Transaction save and get (sorted by timestamp descending).
  - Payment order save and get.
  - Partial unique index enforcement on PENDING orders with identical amounts.
  - Re-use of identical amounts once previous order is marked PAID or EXPIRED.
  - Database backup via `backup()`.

- [ ] **Step 4: Run tests to verify**
  Run: `npx vitest run tests/sqlite-storage.test.ts`
  Expected: PASS

- [ ] **Step 5: Commit**
  Run: `git add src/core/storage/ tests/sqlite-storage.test.ts && git commit -m "feat(storage): implement SqliteStorageAdapter with WAL mode and partial index"`

---

### Task 2: Integrate `SqliteStorageAdapter` Across Server and Routes

**Files:**
- Modify: `src/server/index.ts`
- Modify: `src/server/routes/auth.ts`
- Modify: `src/server/routes/payment.ts`
- Modify: `src/server/routes/transactions.ts`
- Modify: `src/server/checkout-page.ts`

**Interfaces:**
- Consumes: `SqliteStorageAdapter` from `src/core/storage/sqlite-storage.ts`
- Produces: Server routes and reconciler using unified `SqliteStorageAdapter` instance (or default shared database file `.kaigobiz.db`).

- [ ] **Step 1: Provide shared storage instance factory or singleton**
  Export a shared `getStorageAdapter()` or default `SqliteStorageAdapter` instance in `src/core/storage/index.ts` so routes and reconciler share the same SQLite connection pool.

- [ ] **Step 2: Update `src/server/index.ts`**
  Switch from `FileStorageAdapter` to `SqliteStorageAdapter`.

- [ ] **Step 3: Update `src/server/routes/auth.ts`**
  Switch storage adapter to `SqliteStorageAdapter`.

- [ ] **Step 4: Update `src/server/routes/payment.ts`**
  Switch storage adapter to `SqliteStorageAdapter`. In `payment.post('/create')`, utilize SQLite's partial unique constraint catch block for atomic collision-free unique code assignment.

- [ ] **Step 5: Update `src/server/routes/transactions.ts`**
  Switch storage adapter to `SqliteStorageAdapter`.

- [ ] **Step 6: Update existing test suite**
  Update `tests/storage.test.ts`, `tests/server.test.ts`, and `tests/session-manager.test.ts` if needed to ensure all existing tests pass with the new storage engine.

- [ ] **Step 7: Run test suite**
  Run: `npm test`
  Expected: All tests pass.

- [ ] **Step 8: Commit**
  Run: `git add src/ tests/ && git commit -m "refactor: switch core storage from JSON files to SqliteStorageAdapter"`

---

### Task 3: Write Documentation for E-Commerce Integration & High Concurrency

**Files:**
- Create: `docs/INTEGRATION_GUIDE.md`
- Modify: `README.md`

- [ ] **Step 1: Create `docs/INTEGRATION_GUIDE.md`**
  Document:
  - Architecture overview: KaiGoBiz as payment gateway engine vs E-commerce platform.
  - Setup and configuration (QRIS static string, Webhook secret, GoBiz OTP login).
  - API reference for `POST /api/v1/payment/create` with exact parameter schemas (`orderId`, `amount`, `expiryMinutes`, `callbackUrl`, `useUniqueCode`, `uniqueCodeMin`, `uniqueCodeMax`, `uniqueCodeType`).
  - Integration options: Modal widget (`kaigobiz.js`), Redirect checkout page, and Direct headless API.
  - Webhook verification: HMAC-SHA256 signature verification code samples (Node.js, PHP, Python).
  - High concurrency & flash sale blueprint (handling hundreds of thousands of transactions):
    * High-velocity recycling: why 90-120s expiry window with immediate release upon payment scales to tens of thousands of transactions with unique code <= 250.
    * Multi-terminal / Multi-QRIS GoBiz parallelization.
    * SQLite maintenance: WAL checkpointing, online hot backup via `VACUUM INTO`, and export/import.
    * When to scale beyond SQLite (multi-writer sharding / PostgreSQL).

- [ ] **Step 2: Update `README.md`**
  Add summary of SQLite storage engine, updated performance benchmarks, and link to `docs/INTEGRATION_GUIDE.md`.

- [ ] **Step 3: Commit**
  Run: `git add docs/ README.md && git commit -m "docs: add comprehensive integration guide and high-scale architecture documentation"`

---

### Task 4: Build, Restart Server, Verify Endpoints & Deploy

**Files:**
- Build artifacts: `dist/`

- [ ] **Step 1: Build project**
  Run: `npm run build`
  Expected: Clean build without errors.

- [ ] **Step 2: Restart PM2 process**
  Run: `pm2 restart 8`
  Verify logs: `pm2 logs 8 --lines 20 --nostream`

- [ ] **Step 3: Verify live endpoints**
  Verify `GET /api/v1/health`, `GET /api/v1/auth/status`, and test payment order creation via curl.

- [ ] **Step 4: Update knowledge graph**
  Run: `graphify update .`

- [ ] **Step 5: Push to GitHub**
  Run: `git push origin main`

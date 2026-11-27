export interface SessionData {
  phone_number?: string | null;
  merchant_id?: string | null;
  outlet_name?: string | null;
  owner_name?: string | null;
  outlet_address?: string | null;
  kyc_status?: string | null;
  features?: Array<{ product_name: string; product_type: string; status: string }> | null;
  access_token: string;
  refresh_token: string;
  cookie?: string | null;
  updated_at?: string;
  expires_at?: string | null;
  device_id?: string | null;
  user_agent?: string | null;
  phone_make?: string | null;
  phone_model?: string | null;
  app_version?: string | null;
  token_ttl_seconds?: number | null;
}

export interface TransactionData {
  id: string;
  amount: number;
  description?: string;
  timestamp: string;
  status: 'COMPLETED' | 'PENDING' | 'FAILED';
  raw?: any;
}

export interface PaymentOrder {
  paymentId: string;
  orderId: string;
  amount: number;
  rawAmount?: number;
  uniqueCode?: number;
  qrisString: string;
  qrisQrUrl?: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
  callbackUrl?: string;
  returnUrl?: string;
  paidAt?: string;
  callbackStatus?: 'SUCCESS' | 'FAILED' | 'SKIPPED';
  callbackRetries?: number;
  lastCallbackAttempt?: string;
  transactionId?: string;
}

export interface StorageAdapter {
  getSession(): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<boolean>;
  clearSession?(): Promise<boolean>;
  saveTransaction(tx: TransactionData): Promise<boolean>;
  saveTransactions?(txs: TransactionData[]): Promise<boolean>;
  getTransactions(): Promise<TransactionData[]>;
  getRecentTransactions?(sinceIso: string, limit?: number): Promise<TransactionData[]>;
  savePaymentOrder(order: PaymentOrder): Promise<boolean>;
  getPaymentOrder(paymentId: string): Promise<PaymentOrder | null>;
  getAllPaymentOrders?(): Promise<PaymentOrder[]>;
  getActivePendingOrder?(orderId: string): Promise<PaymentOrder | null>;
  getActivePendingAmounts?(): Promise<Set<number>>;
  getUsedTransactionIds?(): Promise<Set<string>>;
  getPendingOrders?(): Promise<PaymentOrder[]>;
  getFailedCallbackOrders?(maxRetries: number, retryCooldownMs: number): Promise<PaymentOrder[]>;
  markOrderPaidIfPending?(paymentId: string, transactionId: string, paidAt: string): Promise<boolean>;
  updateOrderCallbackStatus?(
    paymentId: string,
    status: 'SUCCESS' | 'FAILED',
    lastAttempt: string,
    incrementRetries?: boolean
  ): Promise<boolean>;
  expireStalePendingOrders?(nowIso?: string): Promise<number>;
  getConfig?(): Promise<Record<string, any>>;
  setConfig?(patch: Record<string, any>): Promise<boolean>;
  backup?(targetPath: string): Promise<boolean>;
  close?(): void;
}

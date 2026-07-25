export interface SessionData {
  phone_number?: string | null;
  merchant_id?: string | null;
  outlet_name?: string | null;
  access_token: string;
  refresh_token: string;
  cookie?: string | null;
  updated_at?: string;
  expires_at?: string | null;
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
  qrisString: string;
  qrisQrUrl?: string;
  status: 'PENDING' | 'PAID' | 'EXPIRED';
  createdAt: string;
  expiresAt: string;
}

export interface StorageAdapter {
  getSession(): Promise<SessionData | null>;
  saveSession(session: SessionData): Promise<boolean>;
  saveTransaction(tx: TransactionData): Promise<boolean>;
  getTransactions(): Promise<TransactionData[]>;
  savePaymentOrder(order: PaymentOrder): Promise<boolean>;
  getPaymentOrder(paymentId: string): Promise<PaymentOrder | null>;
}

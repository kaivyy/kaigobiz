import fs from 'fs';
import path from 'path';
import { StorageAdapter, SessionData, TransactionData, PaymentOrder } from './storage.interface';

export interface FileStorageConfig {
  sessionFile?: string;
  txFile?: string;
  ordersFile?: string;
}

export class FileStorageAdapter implements StorageAdapter {
  private sessionFile: string;
  private txFile: string;
  private ordersFile: string;

  constructor(config?: FileStorageConfig) {
    const baseDir = process.cwd();
    this.sessionFile = config?.sessionFile || path.join(baseDir, '.kaigobiz-session.json');
    this.txFile = config?.txFile || path.join(baseDir, '.kaigobiz-tx.json');
    this.ordersFile = config?.ordersFile || path.join(baseDir, '.kaigobiz-orders.json');
  }

  private ensureDirExists(filePath: string) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async getSession(): Promise<SessionData | null> {
    try {
      if (!fs.existsSync(this.sessionFile)) return null;
      const data = fs.readFileSync(this.sessionFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async saveSession(session: SessionData): Promise<boolean> {
    try {
      this.ensureDirExists(this.sessionFile);
      fs.writeFileSync(this.sessionFile, JSON.stringify(session, null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  async clearSession(): Promise<boolean> {
    try {
      if (fs.existsSync(this.sessionFile)) {
        fs.unlinkSync(this.sessionFile);
      }
      return true;
    } catch {
      return false;
    }
  }

  async saveTransaction(tx: TransactionData): Promise<boolean> {
    return await this.saveTransactions([tx]);
  }

  async saveTransactions(txs: TransactionData[]): Promise<boolean> {
    try {
      this.ensureDirExists(this.txFile);
      const existing = await this.getTransactions();
      const existingMap = new Map(existing.map((item) => [item.id, item]));

      for (const tx of txs) {
        existingMap.set(tx.id, tx);
      }

      // Keep latest transactions first
      const merged = Array.from(existingMap.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      fs.writeFileSync(this.txFile, JSON.stringify(merged.slice(0, 500), null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  async getTransactions(): Promise<TransactionData[]> {
    try {
      if (!fs.existsSync(this.txFile)) return [];
      const data = fs.readFileSync(this.txFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }

  async savePaymentOrder(order: PaymentOrder): Promise<boolean> {
    try {
      this.ensureDirExists(this.ordersFile);
      const orders = await this.getAllOrders();
      const existingIdx = orders.findIndex((o) => o.paymentId === order.paymentId);
      if (existingIdx >= 0) {
        orders[existingIdx] = order;
      } else {
        orders.unshift(order);
      }
      fs.writeFileSync(this.ordersFile, JSON.stringify(orders.slice(0, 500), null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  async getPaymentOrder(paymentId: string): Promise<PaymentOrder | null> {
    const orders = await this.getAllOrders();
    return orders.find((o) => o.paymentId === paymentId) || null;
  }

  async getAllPaymentOrders(): Promise<PaymentOrder[]> {
    return await this.getAllOrders();
  }

  private async getAllOrders(): Promise<PaymentOrder[]> {
    try {
      if (!fs.existsSync(this.ordersFile)) return [];
      const data = fs.readFileSync(this.ordersFile, 'utf-8');
      return JSON.parse(data);
    } catch {
      return [];
    }
  }
}

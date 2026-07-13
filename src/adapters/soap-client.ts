import { logger } from "../utils/logger.js";
import { UpstreamServiceError } from "../utils/errors.js";

// ─── Type Definitions ────────────────────────────────────────

export interface SoapCustomer {
  id: string;
  name: string;
  email: string;
  accountNumber: string;
  createdAt: string;
  updatedAt: string;
}

export interface SoapInvoice {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "paid" | "overdue";
  issuedAt: string;
}

export interface SoapClientConfig {
  wsdlUrl: string;
  username: string;
  password: string;
  timeoutMs: number;
}

// ─── Mock SOAP Client ────────────────────────────────────────

const MOCK_CUSTOMERS: SoapCustomer[] = [
  {
    id: "SOAP-001",
    name: "Legacy Corp",
    email: "contact@legacycorp.com",
    accountNumber: "ACC-1001",
    createdAt: "2023-01-15T08:00:00Z",
    updatedAt: "2025-11-01T12:00:00Z",
  },
  {
    id: "SOAP-002",
    name: "Old School Inc",
    email: "info@oldschoolinc.net",
    accountNumber: "ACC-1002",
    createdAt: "2023-03-22T10:30:00Z",
    updatedAt: "2025-10-28T09:15:00Z",
  },
];

const MOCK_INVOICES: SoapInvoice[] = [
  {
    id: "INV-001",
    customerId: "SOAP-001",
    amount: 1500.0,
    currency: "USD",
    status: "paid",
    issuedAt: "2025-09-01T00:00:00Z",
  },
  {
    id: "INV-002",
    customerId: "SOAP-002",
    amount: 2750.5,
    currency: "USD",
    status: "pending",
    issuedAt: "2025-10-15T00:00:00Z",
  },
  {
    id: "INV-003",
    customerId: "SOAP-001",
    amount: 800.75,
    currency: "USD",
    status: "overdue",
    issuedAt: "2025-08-20T00:00:00Z",
  },
];

export class SoapClient {
  private config: SoapClientConfig;
  private connected = false;

  constructor(config: SoapClientConfig) {
    this.config = config;
  }

  /**
   * Simulate connecting to a legacy SOAP endpoint.
   */
  async connect(): Promise<void> {
    logger.info(
      { wsdlUrl: this.config.wsdlUrl },
      "SOAP client connecting to legacy endpoint",
    );
    // Simulate network latency
    await new Promise((r) => setTimeout(r, 100));
    this.connected = true;
    logger.info("SOAP client connected successfully");
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    logger.info("SOAP client disconnected");
  }

  /**
   * Fetch customers modified since a given timestamp.
   * In production, this would call the actual SOAP endpoint.
   */
  async getCustomers(since?: string): Promise<SoapCustomer[]> {
    this.assertConnected();
    logger.debug({ since }, "SOAP getCustomers");

    // Simulate occasional failure for testing retry logic
    if (Math.random() < 0.1) {
      throw new UpstreamServiceError("SOAP", 503, "Service temporarily unavailable");
    }

    await this.simulateLatency();
    return since
      ? MOCK_CUSTOMERS.filter((c) => c.updatedAt > since)
      : [...MOCK_CUSTOMERS];
  }

  /**
   * Fetch invoices modified since a given timestamp.
   */
  async getInvoices(since?: string): Promise<SoapInvoice[]> {
    this.assertConnected();
    logger.debug({ since }, "SOAP getInvoices");

    if (Math.random() < 0.05) {
      throw new UpstreamServiceError("SOAP", 500, "Internal server error");
    }

    await this.simulateLatency();
    return since
      ? MOCK_INVOICES.filter((i) => i.issuedAt > since)
      : [...MOCK_INVOICES];
  }

  /**
   * Create or update a customer in the legacy system.
   */
  async upsertCustomer(customer: SoapCustomer): Promise<SoapCustomer> {
    this.assertConnected();
    logger.info({ customerId: customer.id }, "SOAP upsertCustomer");
    await this.simulateLatency(200);
    return { ...customer, updatedAt: new Date().toISOString() };
  }

  /**
   * Update invoice status in the legacy system.
   */
  async updateInvoiceStatus(
    invoiceId: string,
    status: SoapInvoice["status"],
  ): Promise<void> {
    this.assertConnected();
    logger.info({ invoiceId, status }, "SOAP updateInvoiceStatus");
    await this.simulateLatency(150);
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new UpstreamServiceError("SOAP", 0, "Client not connected. Call connect() first.");
    }
  }

  private async simulateLatency(ms = 100): Promise<void> {
    const jitter = Math.random() * 50;
    await new Promise((r) => setTimeout(r, ms + jitter));
  }
}

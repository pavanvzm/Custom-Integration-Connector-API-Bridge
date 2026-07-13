import gql from "graphql-tag";

export const typeDefs = gql`
  # ─── Scalar Types ──────────────────────────────────────────────
  scalar DateTime
  scalar JSON

  # ─── Enums ─────────────────────────────────────────────────────
  enum SyncDirection {
    LEGACY_TO_SAAS
    SAAS_TO_LEGACY
    BIDIRECTIONAL
  }

  enum SyncStatus {
    SUCCESS
    CONFLICT
    FAILED
    PENDING
  }

  enum InvoiceStatus {
    pending
    paid
    overdue
  }

  # ─── Legacy System Types (SOAP) ───────────────────────────────
  type SoapCustomer {
    id: ID!
    name: String!
    email: String!
    accountNumber: String!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type SoapInvoice {
    id: ID!
    customerId: ID!
    amount: Float!
    currency: String!
    status: InvoiceStatus!
    issuedAt: DateTime!
  }

  # ─── Legacy System Types (SQL) ────────────────────────────────
  type SqlCustomer {
    id: ID!
    name: String!
    email: String!
    tier: String!
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type SqlOrder {
    id: ID!
    customerId: ID!
    total: Float!
    status: String!
    orderDate: DateTime!
  }

  # ─── Bridge / Sync Types ──────────────────────────────────────
  type SyncEvent {
    id: ID!
    entityType: String!
    entityId: String!
    direction: SyncDirection!
    status: SyncStatus!
    source: String!
    target: String!
    payload: JSON
    error: String
    timestamp: DateTime!
    retryAttempt: Int
  }

  type SyncResult {
    success: Boolean!
    event: SyncEvent
    message: String
  }

  type RateLimitStatus {
    key: String!
    allowed: Boolean!
    remaining: Int!
    resetAt: DateTime!
  }

  # ─── Queries ───────────────────────────────────────────────────
  type Query {
    """Fetch customers from the legacy SOAP system."""
    legacySoapCustomers(since: DateTime): [SoapCustomer!]!

    """Fetch invoices from the legacy SOAP system."""
    legacySoapInvoices(since: DateTime): [SoapInvoice!]!

    """Fetch customers from the legacy SQL database."""
    legacySqlCustomers(since: DateTime): [SqlCustomer!]!

    """Fetch orders from the legacy SQL database."""
    legacySqlOrders(since: DateTime): [SqlOrder!]!

    """Get rate limit status for a given key."""
    rateLimitStatus(key: String!): RateLimitStatus!

    """Get recent sync events."""
    syncEvents(limit: Int = 50): [SyncEvent!]!
  }

  # ─── Mutations ─────────────────────────────────────────────────
  type Mutation {
    """Sync data from legacy SOAP to the modern SaaS system."""
    syncFromSoap(entityType: String!, since: DateTime): SyncResult!

    """Sync data from legacy SQL to the modern SaaS system."""
    syncFromSql(tableName: String!, since: DateTime): SyncResult!

    """Push data from SaaS back to legacy SOAP system."""
    pushToSoap(customerId: ID!, data: JSON!): SyncResult!

    """Push data from SaaS back to legacy SQL database."""
    pushToSql(tableName: String!, id: ID!, data: JSON!): SyncResult!

    """Trigger a bidirectional sync for a specific entity."""
    bidirectionalSync(entityType: String!, entityId: ID!): SyncResult!

    """Clear rate limiter state for a key."""
    clearRateLimit(key: String!): Boolean!
  }

  # ─── Subscriptions ─────────────────────────────────────────────
  type Subscription {
    """Real-time updates on sync events as they happen."""
    syncEvents: SyncEvent!
  }
`;

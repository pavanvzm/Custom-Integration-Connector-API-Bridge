# Custom Integration Connector / API Bridge

A **production-ready bidirectional API Bridge** that connects legacy systems (SOAP/SQL) with modern SaaS applications. Built with Node.js/TypeScript, GraphQL, and Redis.

## Architecture

```
┌──────────────┐     ┌───────────────────┐     ┌──────────────┐
│  Legacy SOAP  │ ──▶ │                   │ ──▶ │  Modern SaaS  │
│  Web Service  │ ◀── │   API Bridge      │ ◀── │  (GraphQL)    │
└──────────────┘     │   (GraphQL API)   │     └──────────────┘
┌──────────────┐     │                   │
│  Legacy SQL   │ ──▶ │   Rate Limiter    │
│  Database     │ ◀── │   Retry Handler   │
└──────────────┘     │   Sync Engine      │
                     └───────────────────┘
```

### Data Flow

- **Legacy → SaaS**: Reads data from legacy SOAP or SQL, transforms, and pushes to your modern system
- **SaaS → Legacy**: Mutations allow pushing data back to legacy SOAP/SQL
- **Bidirectional**: Full-cycle sync with conflict detection (compares timestamps to pick the newer source)

### Key Components

| Component | Description |
|-----------|-------------|
| **GraphQL API** | Single entry point for all sync operations, with full GraphQL schema |
| **Rate Limiter** | Redis-backed sliding-window rate limiter (sorted sets) |
| **Retry Handler** | Exponential backoff with jitter, Redis-persisted state for restart safety |
| **Sync Engine** | Orchestrates data movement between legacy ↔ SaaS, includes conflict detection |
| **Structured Logger** | Pino-based with JSON output, configurable log levels |

## Prerequisites

- **Node.js** ≥ 18
- **Redis** (for rate limiter & retry state persistence)
- **npm** or **yarn**

## Getting Started

### 1. Clone and Install

```bash
git clone https://github.com/pavanvzm/Custom-Integration-Connector-API-Bridge.git
cd Custom-Integration-Connector-API-Bridge
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your Redis, SOAP, and SQL connection details
```

### 3. Start Redis (if not already running)

```bash
docker run -d -p 6379:6379 redis:7-alpine
```

### 4. Run the Bridge

```bash
npm run dev     # development with hot-reload
# or
npm run build && npm start  # production
```

The GraphQL playground will be available at **http://localhost:4000/graphql**.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `4000` | HTTP server port |
| `NODE_ENV` | `development` | Environment (development/production) |
| `REDIS_HOST` | `localhost` | Redis host |
| `REDIS_PORT` | `6379` | Redis port |
| `REDIS_PASSWORD` | — | Redis password (optional) |
| `RATE_LIMIT_WINDOW_MS` | `60000` | Rate limiter window in ms |
| `RATE_LIMIT_MAX_REQUESTS` | `100` | Max requests per window |
| `RETRY_MAX_ATTEMPTS` | `5` | Max retry attempts per operation |
| `RETRY_BASE_DELAY_MS` | `1000` | Initial backoff delay in ms |
| `RETRY_MAX_DELAY_MS` | `60000` | Maximum backoff delay in ms |
| `SOAP_WSDL_URL` | — | Legacy SOAP WSDL endpoint |
| `SOAP_USERNAME` | — | SOAP basic auth username |
| `SOAP_PASSWORD` | — | SOAP basic auth password |
| `SOAP_TIMEOUT_MS` | `10000` | SOAP request timeout |
| `SQL_CONNECTION_STRING` | — | Legacy SQL connection string |
| `SQL_SCHEMA` | `public` | Database schema |
| `SQL_TIMEOUT_MS` | `5000` | SQL query timeout |
| `SYNC_POLL_INTERVAL_MS` | `30000` | Polling interval for scheduled sync |
| `SYNC_BATCH_SIZE` | `50` | Records per sync batch |
| `LOG_LEVEL` | `info` | Pino log level (trace/debug/info/warn/error/fatal) |
| `LOG_PRETTY` | `true` | Pretty-print logs in development |

## GraphQL API

### Queries

```graphql
# Fetch customers from legacy SOAP
query { legacySoapCustomers(since: "2025-01-01T00:00:00Z") { id name email accountNumber }}

# Fetch invoices from legacy SOAP
query { legacySoapInvoices { id customerId amount status }}

# Fetch customers from legacy SQL
query { legacySqlCustomers(since: "2025-01-01T00:00:00Z") { id name tier }}

# Fetch orders from legacy SQL
query { legacySqlOrders { id customerId total status }}

# Check rate limiter status
query { rateLimitStatus(key: "mutation:sync:soap") { allowed remaining resetAt }}

# View recent sync events
query { syncEvents(limit: 20) { id entityType direction status timestamp }}
```

### Mutations

```graphql
# Sync from legacy SOAP to SaaS
mutation { syncFromSoap(entityType: "customers") { success message }}

# Sync from legacy SQL to SaaS
mutation { syncFromSql(tableName: "orders") { success message }}

# Push data back to legacy SOAP
mutation { pushToSoap(customerId: "SOAP-001", data: { name: "Updated Corp" }) { success }}

# Push data back to legacy SQL
mutation { pushToSql(tableName: "customers", id: "SQL-CUST-001", data: { tier: "enterprise" }) { success }}

# Bidirectional sync with conflict detection
mutation { bidirectionalSync(entityType: "customers", entityId: "SOAP-001") { success message }}

# Clear rate limit for a key
mutation { clearRateLimit(key: "mutation:sync:soap") }
```

## Rate Limiting

The bridge uses a **sliding-window rate limiter** backed by Redis sorted sets:

- Each API key/operation has its own counter
- Expired entries are automatically pruned on each check
- Returns `429 RateLimitError` with a `retryAfterMs` hint when exceeded
- Fails open (allows the request) if Redis is unreachable

## Retry Logic

Operations use **exponential backoff with jitter**:

- **Attempt 1**: Immediate (no delay)
- **Attempt 2**: `baseDelayMs` (~1s)
- **Attempt 3**: `baseDelayMs * 2` (~2s)
- **Attempt 4**: `baseDelayMs * 4` (~4s)
- **Attempt 5**: `baseDelayMs * 8` (~8s)
- Each delay gets up to 25% random jitter
- Retry state is persisted in Redis for restart durability
- Non-retryable 4xx errors (except 429) abort immediately

## Project Structure

```
src/
├── index.ts                    # Entry point — wires everything together
├── config/
│   └── index.ts                # Environment-aware configuration
├── adapters/
│   ├── soap-client.ts          # Mock SOAP client (swap with real SOAP client)
│   └── sql-adapter.ts          # Mock SQL adapter (swap with real DB driver)
├── middleware/
│   ├── rate-limiter.ts          # Redis-backed sliding-window rate limiter
│   └── retry.ts                 # Exponential backoff retry handler
├── graphql/
│   ├── schema.ts                # GraphQL type definitions
│   └── resolvers.ts             # GraphQL resolvers
├── bridge/
│   └── sync-engine.ts           # Bidirectional sync orchestration
└── utils/
    ├── errors.ts                # Typed error classes
    └── logger.ts                # Pino structured logger
```

## Testing

```bash
npm test                         # Run all tests
npm run test:watch               # Watch mode
npm run typecheck                # TypeScript type checking only
```

## License

MIT

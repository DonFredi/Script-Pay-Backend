# Database Design

## Overview

ScriptPay uses PostgreSQL as the primary data store with Prisma as the ORM for type-safe database access.

## Core Tables

### Users

Represents system users (merchants, admins, support staff).

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  role user_role NOT NULL DEFAULT 'merchant',
  status user_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  deleted_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_status ON users(status);
```

### Merchants

Merchant accounts and business information.

```sql
CREATE TABLE merchants (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id),
  business_name VARCHAR(255) NOT NULL,
  business_type VARCHAR(100),
  website URL,
  stripe_account_id VARCHAR(255) UNIQUE,
  status merchant_status NOT NULL DEFAULT 'pending_verification',
  verification_status verification_status NOT NULL DEFAULT 'unverified',
  live_mode BOOLEAN DEFAULT FALSE,
  api_key_live VARCHAR(255) UNIQUE,
  api_key_test VARCHAR(255) UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_merchants_user_id ON merchants(user_id);
CREATE INDEX idx_merchants_stripe_account_id ON merchants(stripe_account_id);
CREATE INDEX idx_merchants_status ON merchants(status);
```

### Transactions

Payment transactions.

```sql
CREATE TABLE transactions (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  stripe_payment_intent_id VARCHAR(255) UNIQUE,
  amount_cents BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status transaction_status NOT NULL DEFAULT 'pending',
  customer_email VARCHAR(255),
  customer_name VARCHAR(255),
  description TEXT,
  failure_reason TEXT,
  metadata JSONB,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMP
);

-- Indexes
CREATE INDEX idx_transactions_merchant_id ON transactions(merchant_id);
CREATE INDEX idx_transactions_status ON transactions(status);
CREATE INDEX idx_transactions_stripe_payment_intent_id ON transactions(stripe_payment_intent_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_merchant_created ON transactions(merchant_id, created_at DESC);
```

### PaymentMethods

Stored payment methods for customers.

```sql
CREATE TABLE payment_methods (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  stripe_payment_method_id VARCHAR(255) UNIQUE NOT NULL,
  type payment_method_type NOT NULL, -- 'card', 'bank_account', 'wallet'
  customer_email VARCHAR(255),
  last_four VARCHAR(4),
  brand VARCHAR(50), -- 'visa', 'mastercard', etc
  is_default BOOLEAN DEFAULT FALSE,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_payment_methods_merchant_id ON payment_methods(merchant_id);
CREATE INDEX idx_payment_methods_stripe_id ON payment_methods(stripe_payment_method_id);
```

### Invoices

Merchant invoices and billing records.

```sql
CREATE TABLE invoices (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  invoice_number VARCHAR(50) UNIQUE NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'USD',
  status invoice_status NOT NULL DEFAULT 'draft',
  issue_date DATE NOT NULL,
  due_date DATE,
  paid_date DATE,
  stripe_invoice_id VARCHAR(255),
  line_items JSONB,
  notes TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_invoices_merchant_id ON invoices(merchant_id);
CREATE INDEX idx_invoices_status ON invoices(status);
CREATE INDEX idx_invoices_invoice_number ON invoices(invoice_number);
```

### WebhookEvents

Outbound webhook events for merchants.

```sql
CREATE TABLE webhook_events (
  id UUID PRIMARY KEY,
  merchant_id UUID NOT NULL REFERENCES merchants(id),
  event_type webhook_event_type NOT NULL,
  resource_type VARCHAR(50) NOT NULL, -- 'transaction', 'payment', etc
  resource_id UUID NOT NULL,
  payload JSONB NOT NULL,
  retry_count INT DEFAULT 0,
  max_retries INT DEFAULT 5,
  status webhook_status NOT NULL DEFAULT 'pending',
  last_error TEXT,
  scheduled_at TIMESTAMP,
  sent_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_webhook_events_merchant_id ON webhook_events(merchant_id);
CREATE INDEX idx_webhook_events_status ON webhook_events(status);
CREATE INDEX idx_webhook_events_scheduled_at ON webhook_events(scheduled_at);
```

### AuditLogs

Activity audit trail.

```sql
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  merchant_id UUID REFERENCES merchants(id),
  action VARCHAR(100) NOT NULL,
  resource_type VARCHAR(50) NOT NULL,
  resource_id UUID,
  changes JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX idx_audit_logs_user_id ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_merchant_id ON audit_logs(merchant_id);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
```

## Enums

```sql
CREATE TYPE user_role AS ENUM ('admin', 'merchant', 'support');
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'suspended', 'deleted');
CREATE TYPE merchant_status AS ENUM ('pending_verification', 'active', 'suspended', 'archived');
CREATE TYPE verification_status AS ENUM ('unverified', 'verified', 'failed');
CREATE TYPE transaction_status AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'canceled', 'refunded');
CREATE TYPE payment_method_type AS ENUM ('card', 'bank_account', 'wallet');
CREATE TYPE invoice_status AS ENUM ('draft', 'sent', 'paid', 'overdue', 'cancelled');
CREATE TYPE webhook_status AS ENUM ('pending', 'sent', 'failed', 'cancelled');
CREATE TYPE webhook_event_type AS ENUM ('transaction.created', 'transaction.succeeded', 'transaction.failed', 'payment.refunded', 'invoice.created', 'invoice.paid');
```

## Relationships

```
Users (1) --→ (M) Merchants
Users (1) --→ (M) AuditLogs

Merchants (1) --→ (M) Transactions
Merchants (1) --→ (M) PaymentMethods
Merchants (1) --→ (M) Invoices
Merchants (1) --→ (M) WebhookEvents
Merchants (1) --→ (M) AuditLogs

Transactions (1) --→ (M) WebhookEvents
```

## Migrations

Migrations are stored in `prisma/migrations/` and managed by Prisma.

```bash
# Create a new migration
npx prisma migrate dev --name add_new_table

# Apply pending migrations
npx prisma migrate deploy

# Check migration status
npx prisma migrate status

# Reset database (dev only)
npx prisma migrate reset
```

See the `prisma/schema.prisma` file for the current schema definition.

## Performance Optimization

### Indexing Strategy

- Primary keys indexed automatically
- Foreign keys indexed for joins
- Frequently filtered columns (status, created_at) indexed
- Composite index on (merchant_id, created_at) for time-range queries

### Query Optimization

- Use Prisma's `select` to fetch only needed fields
- Eager load relationships with `include` when appropriate
- Use pagination for large result sets
- Avoid N+1 queries with proper relationship loading

### Connection Management

- Prisma connection pooling configured in `.env`
- Read replicas for analytics queries (future)
- Connection pool size: 10 (test), 20 (staging), 50 (production)

## Backup & Recovery

- PostgreSQL automated backups: daily snapshots, 30-day retention
- Point-in-time recovery enabled
- Backup restoration tested monthly
- Production backups stored in separate availability zone

## Data Retention

- Transaction records: permanent
- Deleted users: soft delete (deleted_at set), hard delete after 90 days
- Webhook events: 90-day retention
- Audit logs: 1-year retention
- Failed webhook retries: expire after 7 days

## Access Patterns

### Write-Heavy

- Transactions table (high volume)
- Webhook events (retries)

### Read-Heavy

- Analytics queries (dashboard)
- Transaction history (paginated)

### Archival

- AuditLogs (compliance)

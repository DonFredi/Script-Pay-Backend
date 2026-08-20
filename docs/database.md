# Database

PostgreSQL, accessed exclusively through Prisma (`prisma/schema.prisma` is the source of truth — this document is a guide to it, not a substitute for reading it). See `docs/architecture.md` for how these tables are used.

## Design principles (from the schema's own header comment)

- Every tenant-scoped table carries `tenantId` and is protected by Postgres RLS (see below) in addition to application-level filtering.
- Transactions are append-only where possible — state changes are recorded, not overwritten in place, to preserve an audit trail.
- Money is stored as **integer minor units** (cents), never `Float`/`Decimal`-as-JS-number, to avoid floating-point rounding errors on financial amounts.
- `WebhookEvent` is the idempotency guard: every inbound Daraja callback is recorded by its natural key **before** any processing happens.

## Enums

- `Role`: `SUPER_ADMIN` (ScriptPay staff) · `TENANT_ADMIN` (owns a tenant account) · `TENANT_STAFF` (scoped access within a tenant)
- `TransactionChannel`: `STK_PUSH` · `PAYBILL` · `TILL`
- `TransactionStatus`: `PENDING` → `PROCESSING` → `SETTLED` | `FAILED`; `SETTLED` → `REVERSED`. `FAILED`/`REVERSED` are terminal. Enforced in code by `TransactionStateMachine`'s `ALLOWED_TRANSITIONS` map, not by a DB constraint.
- `ApiKeyScope`: `PAYMENTS_INITIATE` · `PAYMENTS_READ` · `RECONCILIATION_READ` · `WEBHOOKS_MANAGE`
- `WebhookEventStatus`: `pending` · `processing` · `processed` · `failed`

## Tables

### `tenants`
A merchant account. `businessShortcode` is their Paybill/Till number. Daraja credentials are stored **encrypted at rest** (AES-256-GCM, `CredentialsEncryptionService`): `mpesaConsumerSecretEncrypted` and `mpesaPasskeyEncrypted` as `"iv:authTag:ciphertext"` hex strings. `mpesaConsumerKey` is stored in plaintext — Safaricom docs treat it like a client ID, not a secret.

### `users`
Dashboard accounts. `passwordHash` is argon2id — this backend owns password storage directly (an earlier Firebase-based flow has been removed). `tenantId` is nullable: null for `SUPER_ADMIN`, and also null for a `TENANT_ADMIN` who has signed up but not yet completed onboarding.

### `refresh_tokens`
Backend-issued session tokens, **SHA-256** hashed (not argon2 — this is a high-entropy random token, not a low-entropy password, so a fast hash is the correct and sufficient tool). Supports rotation: using a token revokes it and issues a replacement (`replacedByTokenId`); a revoked token presented again is a reuse signal.

### `email_verification_tokens`, `password_reset_tokens`
Single-use, hashed, short-lived tokens for email-link flows. Same pattern as refresh tokens: only a hash is persisted, and `usedAt` prevents replay.

### `api_keys`
Tenant-integration credentials. Only `keyHash` (argon2) is stored, never the raw key — `keyPrefix` (first 8 chars) is kept in plaintext for dashboard identification and to narrow the DB lookup before the expensive argon2 verify.

### `transactions`
The core payment record. `checkoutRequestId` (Daraja's STK Push identifier) and `mpesaReceiptNumber` are both unique — the former is the natural idempotency key for outbound STK pushes, the latter is only populated once settled and may legitimately be null on transactions settled via drift-detection before the real webhook backfills it.

### `ledger_entries`
Double-entry bookkeeping: every settlement writes a balanced pair of rows (e.g. credit `tenant_balance` / debit `pending_settlement`). This is what makes "tenant balance" a computed, auditable value rather than a mutable counter that can drift from reality.

### `webhook_events`
The idempotency + retry mechanism for inbound Daraja callbacks. Unique constraint on `(source, naturalKey)` — a duplicate Safaricom retry fails the insert, not the business logic. `status`/`attempts` back a Postgres-polling retry loop (`WebhookPollerService`, every 10s) — there is no Redis/BullMQ queue in this system; the table row **is** the queue.

### `reconciliation_records`
One row per transaction per reconciliation pass: `expectedAmount` vs `confirmedAmount`, and a `driftDetected` flag that stays `true` even after a transaction self-heals via drift detection — a rising drift rate is a signal that webhook delivery has a problem, worth tracking even when individual cases resolve fine.

### `audit_logs`
Append-only (by convention — never updated or deleted by application code) record of every sensitive action: tenant creation, API key issuance/revocation, and every outbound Daraja call and inbound callback outcome (success and failure alike).

## Row-Level Security

Prisma does not manage RLS, so it's applied via a raw SQL migration at `prisma/manual-sql/001_row_level_security.sql`:

```sql
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transactions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
-- repeated per tenant-scoped table
```

The application sets `app.current_tenant_id` per request via `PrismaService`'s tenant-context helper. This is a **second, independent layer** on top of application-level `tenantId` filtering — defense in depth against a service that forgets to filter, not the only safeguard.

## Migrations

Standard Prisma migrations live in `prisma/migrations/`. The RLS policy is a hand-written migration outside Prisma's management, applied manually:

```bash
npx prisma migrate dev
psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql
```

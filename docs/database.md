# Database — ScriptPay Backend

PostgreSQL via Prisma 6. `prisma/schema.prisma` is the source of truth; this
is a table-by-table reference plus the conventions that apply across all of
them. Verified against the schema as of 2026-08-21.

## Cross-cutting conventions

- **Money** is always an integer column of minor units (`amountMinorUnits`,
  KES cents) — never `Float`, never a `Decimal` read into a JS `number`.
- **Every tenant-scoped table carries `tenantId`** and is meant to be
  protected by Postgres Row-Level Security as a second layer of isolation on
  top of application-level `tenantId` filtering. The policy SQL is not a
  Prisma migration — see "Row-Level Security" below.
- **IDs** are UUIDs (`@default(uuid())`) everywhere.
- **Secrets are never stored in plaintext**: passwords and API keys are
  hashed (argon2id / argon2), refresh tokens and email/password-reset tokens
  are hashed (SHA-256), tenant Daraja Consumer Secret/Passkey are encrypted
  (AES-256-GCM), not hashed, because the backend needs the real value back to
  call Safaricom. See `docs/decisions.md` entries 7–8 for why each secret
  type uses a different mechanism.
- **`@@map(...)`** gives every model a `snake_case` table name in Postgres
  while the Prisma client stays `camelCase`.

## Tables

### `tenants` (`Tenant`)

The merchant account. `businessShortcode` is the Paybill/Till number.
`status` is a free-text field (`"active" | "suspended" | "pending_kyc"`,
enforced by application code, not a DB enum) defaulting to `"active"`.
Holds encrypted Daraja credentials directly:

| Column | Notes |
|---|---|
| `mpesaConsumerKey` | Plaintext — Safaricom treats this like a client ID, not a secret. |
| `mpesaConsumerSecretEncrypted` | AES-256-GCM, format `iv:authTag:ciphertext` (hex). |
| `mpesaPasskeyEncrypted` | Same format. |
| `mpesaCredentialsConfiguredAt` | Null until `POST /v1/tenants/:id/mpesa-credentials` succeeds — used to detect a tenant that hasn't configured payments yet. |
| `webhookUrl` | Where to POST settlement/failure notifications. Set via `POST /v1/tenants/webhook-config` (API-key-authenticated, `WEBHOOKS_MANAGE` scope) — a tenant integration concern, not a dashboard field. Null means no outbound notifications for this tenant (opt-in). |
| `webhookSecretEncrypted` | AES-256-GCM, same format/mechanism as the Daraja fields — decrypted only by `TenantWebhookPollerService` at delivery time to sign the HMAC. Server-generated (`whsec_<64 hex>`), never client-supplied; shown to the caller exactly once, at configuration time. |
| `webhookConfiguredAt` | Set (and overwritten) each time `configureWebhook` runs — re-registering rotates both the URL and the secret. |

Relations: `users`, `apiKeys`, `transactions`, `ledgerEntries`,
`webhookEvents`, `reconciliations`, `webhookDeliveries`.

### `users` (`User`)

Dashboard login identity. `role` is `SUPER_ADMIN | TENANT_ADMIN | TENANT_STAFF`.
`tenantId` is nullable — null for `SUPER_ADMIN`, and also null for a user who
has signed up but not yet completed tenant onboarding (`POST /v1/tenants/onboard`).
`passwordHash` is argon2id — this backend owns password storage directly now;
an earlier iteration delegated identity to Firebase (see `docs/decisions.md`
entry 1), and this column is the replacement for that.

Relations: `refreshTokens`, `emailVerificationTokens`, `passwordResetTokens`.

### `email_verification_tokens` / `password_reset_tokens`

Identical shape: single-use, hashed (`tokenHash`, unique), short-lived
(`expiresAt`), `usedAt` marks consumption so a token can never be replayed.
Same design principle as `RefreshToken` — only a hash is ever persisted.

### `refresh_tokens` (`RefreshToken`)

Backs the actual session — this, not any third-party session, is what gates
API access after login. `tokenHash` is SHA-256 (not argon2 — see
`docs/decisions.md` entry 7 for why a fast hash is correct here specifically).
`replacedByTokenId` forms a rotation chain: using a token revokes it and
issues a new one in its place. **If a `revokedAt`-set token is ever presented
again, that's a token-reuse signal** — a strong indicator of theft — and
should trigger revoking the entire chain plus the user's other active
sessions (the theft-response behavior itself lives in application code, not
the schema).

### `api_keys` (`ApiKey`)

Tenant-integration credential. `keyHash` (argon2, unique) is the only stored
form of the raw key — shown once at creation, never retrievable again.
`keyPrefix` (first 8 chars) is a plain, indexed column used to narrow
candidates before running the expensive argon2 verify on each one (see
`ApiKeyGuard` in `docs/architecture.md`). `scopes` is an array of
`ApiKeyScope` (`PAYMENTS_INITIATE | PAYMENTS_READ | RECONCILIATION_READ | WEBHOOKS_MANAGE`)
— scoping a key lets a merchant issue a read-only reporting key separately
from a payments-initiating one, containing blast radius if one leaks.
`revokedAt`/`expiresAt` are both independently nullable — a key can be
time-limited, manually revoked, or both.

### `transactions` (`Transaction`)

The core payment record. `channel` is `STK_PUSH | PAYBILL | TILL`. `status`
is `TransactionStatus` (`PENDING | PROCESSING | SETTLED | FAILED | REVERSED`)
— see `TransactionStateMachine` in `docs/architecture.md` for the enforced
transition graph; this schema does not itself constrain transitions, the
service layer does. `checkoutRequestId` (Daraja's STK Push identifier) and
`mpesaReceiptNumber` are both unique-but-nullable: `checkoutRequestId` is set
at initiation and doubles as the natural idempotency key for matching an
inbound callback back to this row; `mpesaReceiptNumber` is only populated
once settled, and is deliberately optional at the schema level because
`DriftDetectorService` can settle a transaction from an API response that
never carries one (see `docs/decisions.md` entry 5). `metadata` is
arbitrary tenant-supplied `Json`, echoed back but never used for
authorization or amount decisions.

Indexes: `(tenantId, createdAt)` for list views, `(tenantId, status)` for
status-filtered queries (e.g. `DriftDetectorService`'s stuck-transaction scan).

### `ledger_entries` (`LedgerEntry`)

Double-entry bookkeeping: every settlement writes a balanced pair
(`account: "tenant_balance"` credit + `account: "pending_settlement"` debit),
in the same DB transaction as the `Transaction` status change. `direction` is
`"debit" | "credit"` (string, not an enum). This is what makes a tenant's
balance a *computed*, auditable value rather than a mutable counter that can
silently drift from reality — see `docs/decisions.md` entry 11.

### `webhook_events` (`WebhookEvent`)

The idempotency boundary for inbound Daraja callbacks.
`@@unique([source, naturalKey])` — `source` is
`"daraja_stk_callback" | "daraja_c2b_confirmation"`, `naturalKey` is the
`CheckoutRequestID`/`TransactionID` Safaricom supplies. A row is inserted
*before* any processing happens (`processedAt: null`); a duplicate delivery
fails the insert itself rather than needing a separate dedup check. `status`
(`WebhookEventStatus`: `pending | processing | processed | failed`) and
`attempts` (capped at 5 by `WebhookPollerService`, see
`docs/decisions.md` entry 2) track the polling processor's progress.
`tenantId` is nullable — not always resolvable at ingestion time, e.g. before
the payload has been matched to a known `businessShortcode`.

### `tenant_webhook_deliveries` (`TenantWebhookDelivery`)

Outbound mirror of `webhook_events` — that one queues INBOUND Daraja
callbacks; this queues OUTBOUND settlement/failure notifications to a
tenant's own `webhookUrl`. Enqueued by `TransactionStateMachine` in the same
DB transaction as the `SETTLED`/`FAILED` transition it reports (STK-push
paths only — not C2B/Paybill-Till, see the method's own doc comment), so a
delivery is never silently missed for a transition that actually committed,
and never double-enqueued for an idempotent duplicate settlement. `payload`
is the exact `Json` body that gets POSTed (transactionId, status,
mpesaReceiptNumber, amountMinorUnits, metadata, occurredAt). `status`
(`TenantWebhookDeliveryStatus`: `PENDING | DELIVERED | FAILED`), `attempts`,
and `nextAttemptAt` track `TenantWebhookPollerService`'s retry/backoff
progress (30s/2m/10m/30m/1h, 5 attempts max, then terminal `FAILED` + a
critical alert). Only ever created for a tenant that has `webhookUrl` set at
the moment of settlement/failure — no row is queued for the majority of
tenants who haven't configured one.

Indexes: `(status, nextAttemptAt)` for the poller's own query shape (due
`PENDING` rows, oldest first), `(tenantId, createdAt)` per the standard
tenant-scoped-table convention.

### `reconciliation_records` (`ReconciliationRecord`)

One row per transaction per reconciliation pass. `@@unique` on
`transactionId` — one active record per transaction, not a full history log.
`driftDetected` stays `true` even after the transaction resolves — a
self-healing drift is still a signal that webhook delivery had a problem
*that time*, and a rising drift rate (tracked in aggregate by
`docs/reporting`) is worth alerting on even though any individual case
self-healed.

### `audit_logs` (`AuditLog`)

Append-only by convention (application code never updates or deletes a row —
an audit trail that can be edited after the fact isn't one). Covers both
admin actions (`tenant.created`, `api_key.revoked`, ...) and every outbound
Daraja interaction (`daraja.stk_push_initiated`, `daraja.callback_settled`,
...), not just inbound callbacks — `WebhookEvent` covers the raw inbound
payloads, `AuditLog` covers the business-meaningful actions taken as a
result. `actorType` is `"user" | "api_key" | "system"`; `actorId` is null for
system-initiated entries (cron jobs, drift detection).

## Row-Level Security

Not managed by Prisma. `prisma/manual-sql/001_row_level_security.sql` must be
applied by hand (`psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql`)
after every fresh database setup — it is not part of `prisma migrate`. Shape,
per tenant-scoped table:

```sql
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON transactions
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid);
```

The application is responsible for setting `app.current_tenant_id` per
request/session. This is explicitly a second, independent layer of
isolation — application-level `tenantId` filtering (visible throughout
`docs/api.md`'s controller notes) is the primary mechanism; RLS exists so a
single missed `where: { tenantId }` somewhere in a large, evolving codebase
is not, by itself, enough to leak cross-tenant data.

## Migrations

`npx prisma migrate dev` for local development;
`npm run prisma:generate` regenerates the Prisma client after any schema
change. The RLS SQL file is a manual, separate step every time the schema
changes in a way that adds a new tenant-scoped table — it is not
auto-applied by `prisma migrate`, so a new table is not RLS-protected until
someone remembers to extend that file.

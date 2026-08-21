# Architecture — ScriptPay Backend

Current-state description of how this NestJS + Prisma + PostgreSQL API works.
No aspirational content — everything here is verified against the source in
`src/` and `prisma/schema.prisma` as of 2026-08-21. See `CLAUDE.md` for the
full route table and stack list; this document is about how the pieces fit
together and why the request flows the way they do.

## System context

```
Script Pay Frontend (Next.js, separate repo)
        │  REST/HTTPS only
        ▼
ScriptPay Backend (this repo)
        │
        ├──► PostgreSQL (all state — no Redis, no Mongo)
        └──► Safaricom Daraja API (via infrastructure/daraja/DarajaClient — the
             ONLY code in this repo that talks to Safaricom)
```

Two independent trust boundaries call this API:

1. **The frontend**, on behalf of a logged-in dashboard user — cookie-based
   JWT session.
2. **A tenant's own backend**, integrating directly — `x-api-key` header.

These never share a guard. See "Auth model" below.

## Module map and dependency direction

`AppModule` (`src/app.module.ts`) only wires modules together — no business
logic lives there. Each feature module owns its controllers/services/DTOs and
exports only what another module genuinely needs:

```
PrismaModule (global)
AlertsModule (global)      — Slack webhook notifications
AuditLogModule (global)    — AuditLogService, append-only log writes
AuthModule                 — signup/login/refresh/password-reset/email-verification
TenantsModule              — tenant CRUD, encrypted Daraja credential storage
ApiKeysModule               — issue/list/revoke scoped API keys
PaymentsModule              — STK Push initiation, transaction reads, TransactionStateMachine
  └─ exports TransactionStateMachine → consumed by CallbacksModule and ReconciliationModule
CallbacksModule              — inbound Daraja webhook ingestion + Postgres-polling processor
ReconciliationModule         — DriftDetectorService, active recovery for stuck transactions
ReportingModule              — GET /v1/reporting/summary
```

`TransactionStateMachine` is the one deliberately shared piece of business
logic: both the passive webhook path (`WebhookPollerService`) and the active
reconciliation path (`DriftDetectorService`) call the *same* `transitionToSettled`
/ `transitionToFailed` methods, so a transaction can never end up "settled" by
two slightly different definitions depending on which path resolved it.

## Request flow: STK Push payment

```
Tenant's backend                 Dashboard user (via frontend)
      │ x-api-key                       │ access_token cookie
      ▼                                 ▼
ApiKeyGuard                      AccessTokenGuard
      │ (sets request.tenantId)         │ (sets request.user)
      ▼                                 ▼
TenantAwareThrottlerGuard         (dashboard-stk-push.controller.ts)
      │
POST /v1/payments/stk-push  ──┬── POST /v1/dashboard/payments/stk-push
                               │
                               ▼
                    StkPushService → DarajaClient
                               │        (OAuth token fetch, STK Push initiate,
                               │         against Safaricom's real API contract)
                               ▼
                    Transaction row created, status PENDING
                    AuditLogService records "daraja.stk_push_initiated"
```

`ApiKeyGuard` narrows candidate rows by an indexed `keyPrefix` (first 8 chars
of the raw key) before running the expensive argon2 verify against each
candidate — this avoids a full-table hash comparison on every request while
still never storing a reversible key.

## Request flow: inbound Daraja webhook

Safaricom calls back on `POST /v1/webhooks/daraja/stk-callback` (STK Push
result) or `/c2b-confirmation` (Paybill/Till). Both:

1. Are guarded only by `ThrottlerGuard` (`WebhookThrottle` tier) — no auth
   guard, since Safaricom is the caller, not a dashboard user or tenant.
2. Always return `{ ResultCode: 0, ResultDesc: "Accepted" }` with HTTP 200,
   even on internal failure — `@SkipResponseTransform()` bypasses the normal
   response envelope because Safaricom expects exactly this shape. Safaricom
   retries aggressively on anything other than 200, so failures are logged,
   not surfaced to the caller.
3. Insert into `WebhookEvent` **before** any processing happens, keyed on
   `(source, naturalKey)` (`WebhookIngestService`). A Safaricom retry of the
   same event fails the unique-constraint insert (Postgres error `P2002`),
   not the business logic — this is the actual idempotency boundary, not a
   separate dedup check.

Processing itself is decoupled from ingestion:

```
DarajaWebhookController → WebhookIngestService.ingest()
      │ writes WebhookEvent row, processedAt: null   (returns 200 immediately)
      ▼
WebhookPollerService (@Cron EVERY_10_SECONDS)
      │ SELECT ... WHERE processedAt IS NULL AND attempts < 5, take 20
      ▼
TransactionStateMachine.transitionToSettled / transitionToFailed
      │ on repeated failure past 5 attempts → AlertsService (Slack, severity critical)
```

The unprocessed `WebhookEvent` row *is* the queue — there is no separate
broker. See `docs/decisions.md` for why this replaced an earlier
Redis/BullMQ-based processor.

## Request flow: reconciliation (drift detection)

Webhooks can be lost — network blips, or this service being mid-deploy when
Safaricom calls back. `DriftDetectorService` (`@Cron EVERY_5_MINUTES`) finds
transactions stuck in `PROCESSING` for more than 15 minutes and actively
queries Daraja's STK Push Query API for each one (bounded to 100 per run),
then feeds the result through the *same* `TransactionStateMachine` methods a
real webhook would use. A `ReconciliationRecord.driftDetected` flag stays
`true` even after the transaction resolves — a self-healing drift is still a
signal that webhook delivery had a problem, and a rising drift rate is worth
alerting on.

## Auth model

Two independent guards, never combined on one route:

- **`AccessTokenGuard`** — verifies a JWT (`jose`, HS256) from the
  `access_token` httpOnly cookie (or `Authorization: Bearer`), sets
  `request.user`. Issued by `TokenService` at login/signup/refresh. The
  access token is deliberately short-lived (`JWT_ACCESS_TTL_SECONDS`, default
  900s); a `RefreshToken` (SHA-256 hash stored, rotation chain via
  `replacedByTokenId`) backs a 30-day session and lets the backend detect
  reuse of an already-rotated token as a theft signal.
- **`ApiKeyGuard`** — verifies `x-api-key` against an argon2 hash (with a
  `keyPrefix` index to narrow candidates first), checks `@RequireScopes(...)`,
  sets `request.tenantId`.

`RolesGuard` and `TenantAwareThrottlerGuard` both depend on state only an
auth guard sets (`request.user` / `request.tenantId`), so neither is
registered as a global `APP_GUARD` — NestJS runs global guards *before*
controller-level ones, and a global `RolesGuard` would always see an empty
`request.user`. Both are instead applied explicitly, per-controller, after
`AccessTokenGuard`/`ApiKeyGuard` in each controller's `@UseGuards([...])`
array. `TenantAwareThrottlerGuard` also exists because default
`@nestjs/throttler` tracks by IP alone, which is wrong for a multi-tenant
API — several tenants' integrations can share an egress IP behind a
corporate/cloud NAT, so it tracks by `tenantId` when available and falls back
to IP only for fully unauthenticated requests.

CSRF (`CsrfGuard`) is a double-submit-cookie check: the non-httpOnly
`csrf-token` cookie set at login must match an `X-CSRF-Token` header on every
state-changing request. It's skipped for `/webhooks/*` (Safaricom isn't a
browser and can't read cookies to echo the header) and for GET/HEAD/OPTIONS.

## Data model highlights

`prisma/schema.prisma` is the source of truth; summarized here:

- **Money** is `amountMinorUnits` (integer KES cents) everywhere — no
  float/Decimal-as-JS-number, so nothing ever loses precision doing payment
  arithmetic.
- **`LedgerEntry`** is double-entry: every settlement writes a balanced
  credit/debit pair (`tenant_balance` / `pending_settlement`) in the same DB
  transaction as the status change. Tenant balance is a computed, auditable
  value — never a mutable counter that can drift from reality.
- **`TransactionStateMachine`** enumerates every legal status transition
  (`PENDING → PROCESSING/FAILED`, `PROCESSING → SETTLED/FAILED`,
  `SETTLED → REVERSED`; `FAILED`/`REVERSED` are terminal). An attempt at an
  illegal transition throws instead of silently overwriting state. A settled
  transaction tolerates a missing `mpesaReceiptNumber` and backfills it later,
  because Safaricom's STK Push Query API (used by drift detection) returns a
  `ResultCode` but never a receipt number — only the async callback's
  `CallbackMetadata` carries that — so gating settlement on its presence would
  make that whole code path permanently unreachable.
- **`WebhookEvent`** is the idempotency guard for inbound callbacks —
  `@@unique([source, naturalKey])`.
- **`AuditLog`** is append-only by convention (never updated/deleted by
  application code) and records both admin actions (tenant creation, key
  issuance/revocation) and every outbound Daraja interaction, not just
  inbound callbacks.
- **Row-Level Security**: every tenant-scoped table carries `tenantId` and is
  meant to be protected by Postgres RLS as a second layer of isolation on top
  of application-level `tenantId` filtering. The policy SQL lives in
  `prisma/manual-sql/001_row_level_security.sql` and must be applied manually
  — Prisma doesn't manage RLS.

## Secrets and encryption

- **Passwords**: argon2id (`User.passwordHash`).
- **API keys**: argon2 hash of `rawKey + API_KEY_HASH_PEPPER`; only the hash
  and an 8-char `keyPrefix` (for lookup) are stored — the raw key is shown
  once, at creation.
- **Refresh tokens**: SHA-256, not argon2 — deliberately different from
  password/API-key hashing. A refresh token is already a high-entropy random
  value, not a low-entropy secret a human chose; brute-forcing a 256-bit
  random value is infeasible regardless of hash speed, so a slow hash would
  only waste CPU on every refresh request for no additional security.
- **Tenant Daraja credentials** (`mpesaConsumerSecretEncrypted`,
  `mpesaPasskeyEncrypted`): AES-256-GCM via `CredentialsEncryptionService`,
  reversible (the backend needs the real value to call Safaricom, not just
  verify it), stored as `iv:authTag:ciphertext` hex in one column.
  `mpesaConsumerKey` itself is stored in plaintext — Safaricom's own docs
  treat the Consumer Key like a client ID, not a secret.

## Retry and scheduling model

No Redis, no BullMQ, no external queue — `@nestjs/schedule` cron jobs polling
Postgres:

- `WebhookPollerService`: every 10 seconds, processes up to 20 unprocessed
  `WebhookEvent` rows (`processedAt IS NULL AND attempts < 5`), with an
  in-memory `isPolling` flag to prevent overlapping runs if one poll takes
  longer than the interval.
- `DriftDetectorService`: every 5 minutes, finds transactions stuck in
  `PROCESSING` for 15+ minutes (bounded to 100 per run) and actively resolves
  them against Daraja.

## Observability

- `nestjs-pino` for structured logs; `LoggingInterceptor` wraps every
  request.
- `@sentry/node`, reporting 5xx errors via the global `HttpExceptionFilter`.
- `AlertsService` sends Slack webhook notifications for operationally
  significant failures (webhook processing exhausted its retries, STK push
  failed at Safaricom).
- `AuditLogService` is the durable, queryable trail (`GET /v1/audit-logs`,
  `RolesGuard`-protected) — distinct from logs/Sentry/Slack, which are
  operational signals, not the system of record.

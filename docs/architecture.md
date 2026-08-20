# Architecture

## System overview

ScriptPay is a multi-tenant M-Pesa (Safaricom Daraja) payment platform for the Kenyan market. It is **two separate repositories**, not a monorepo:

- **`Script-Pay-Backend`** — a single NestJS monolith (this repo). Owns the database, all business logic, and the only code that talks to Safaricom.
- **`Script Pay Frontend`** — a Next.js 16 dashboard that merchants and ScriptPay staff use. It only talks to this backend's REST API; it never calls Daraja directly.

There is no microservices split, no GraphQL gateway, and no separate Analytics/Billing services — those appeared in an earlier generic template this repo was scaffolded from and do not reflect the real system.

```
Next.js dashboard (browser)
        │  fetch, JWT access token in Authorization header,
        │  httpOnly refresh_token + access_token cookies, CSRF token header
        ▼
NestJS API (this repo)  ──────────────►  Safaricom Daraja API (STK Push, OAuth, status query)
        │                                        │
        │                                        │ async callback (webhook)
        ▼                                        ▼
PostgreSQL (Prisma)  ◄───────────────  WebhookIngestService / WebhookPollerService
```

A merchant's own backend can also call this API directly, authenticated with an `x-api-key` header instead of a JWT — see **Auth model** below.

## Modules (`src/modules`)

| Module | Responsibility |
|---|---|
| `prisma` | `PrismaService` — the global Prisma client, plus tenant RLS context helper |
| `auth` | signup/login/refresh/password-reset/email-verification, JWT issuance (`TokenService`), refresh-token rotation |
| `tenants` | tenant CRUD, onboarding, Daraja credential storage (encrypted) |
| `api-keys` | issue/list/revoke scoped, argon2-hashed API keys for tenant integrations |
| `payments` | STK Push initiation (dashboard + API-key variants), transaction reads, `TransactionStateMachine` |
| `callbacks` | inbound Daraja webhook ingestion (`WebhookIngestService`) + async processing via Postgres polling (`WebhookPollerService`) |
| `reconciliation` | `DriftDetectorService` — actively queries Daraja for transactions stuck in `PROCESSING` past a threshold, rather than waiting indefinitely for a callback |
| `reporting` | `GET /v1/reporting/summary` — aggregated success/failure metrics via `Prisma.groupBy` |
| `audit-log` | `AuditLogService` — records every sensitive action and every outbound/inbound Daraja interaction |
| `alerts` | `AlertsService` — posts to a Slack incoming webhook on payment-initiation failures and exhausted webhook retries |

`src/infrastructure/daraja/daraja.client.ts` is the **only** code in the system that calls Safaricom: OAuth token fetch (cached per tenant's consumer key), STK Push initiation, and STK Push status query.

`src/common/` holds cross-cutting concerns: guards (`AccessTokenGuard`, `ApiKeyGuard`, `RolesGuard`, `CsrfGuard`, `TenantAwareThrottlerGuard`), decorators (`@Roles()`, `@RequireScopes()`, `@CurrentUser()`), named throttle presets (`throttle-tiers.ts`), a Zod validation pipe, the global `HttpExceptionFilter`, and `LoggingInterceptor`/`ResponseTransformInterceptor`.

## Auth model

Two independent caller types, never conflated on one route:

1. **Dashboard users** (the Next.js frontend) — email + password against this backend's own `User` table (argon2id-hashed). On success the backend issues a short-lived JWT access token (~15 min) and a long-lived refresh token, both set as httpOnly cookies (`access_token`, `refresh_token`) *and* the access token is returned in the JSON body for the frontend to hold in memory. `AccessTokenGuard` verifies the JWT (via `jose`) on every protected route. `GET /profile` resolves the current user's role/tenantId.
   - **Firebase is gone.** An earlier version of this backend verified a Firebase ID token as the primary auth mechanism (`FirebaseAuthGuard`). That guard no longer exists. It matters that this stays clear because the frontend's Edge middleware relies on being able to verify the access token itself with `jose` — that's only possible because the token is this backend's own JWT; Firebase Admin cannot run on the Edge runtime at all.
2. **Tenant integrations** (a merchant's own backend calling ScriptPay) — an `x-api-key` header, verified by `ApiKeyGuard` against an argon2 hash, scoped via `ApiKeyScope` (`PAYMENTS_INITIATE`, `PAYMENTS_READ`, `RECONCILIATION_READ`, `WEBHOOKS_MANAGE`).

**Guard ordering matters and is not automatic.** `RolesGuard` is deliberately *not* registered as a global `APP_GUARD` — NestJS runs global guards before controller-level ones, so a global `RolesGuard` would always see an empty `request.user` (populated by `AccessTokenGuard`, which is controller-level) and reject every `@Roles()`-protected route. `RolesGuard` is applied explicitly, per-controller, after the auth guard in each `@UseGuards([...])` array. Same reasoning applies to rate limiting (`TenantAwareThrottlerGuard` needs `request.tenantId`/`request.user`).

## Payment flow

**Outbound (STK Push):**
1. Dashboard or tenant-API caller hits `POST /v1/dashboard/payments/stk-push` or `POST /v1/payments/stk-push`.
2. `DarajaClient.initiateStkPush` calls Safaricom with the tenant's own (decrypted) credentials; a `Transaction` row is created `PENDING` → `PROCESSING`.
3. One of two things settles it:
   - **The normal path** — Safaricom calls back to `POST /v1/webhooks/daraja/stk-callback`. `WebhookIngestService` writes the raw event to `WebhookEvent` immediately (`processedAt: null`) — that row *is* the durable queue, inserted before any business logic runs, so a duplicate delivery fails the unique constraint on `(source, naturalKey)` instead of double-processing.
   - **The safety net** — `DriftDetectorService` runs every 5 minutes, finds transactions stuck `PROCESSING` past 15 minutes, and actively queries Daraja's STK Push Query API for a result instead of waiting indefinitely.
4. Both paths converge on `TransactionStateMachine.transitionToSettled/transitionToFailed` — the state machine is the single place that mutates transaction status, writes the double-entry `LedgerEntry` pair, and creates the `ReconciliationRecord`. `transitionToSettled`'s `mpesaReceiptNumber` is optional and supports back-filling: Safaricom's STK Push Query API (used by drift detection) never returns a receipt number — only the async callback does — so settlement cannot be gated on that field being present.

**Inbound (Paybill/Till/C2B):** the customer pays first, with no prior `PENDING` transaction of ours — `recordInboundSettlement` creates the transaction already `SETTLED` with its ledger entries in one step.

## Webhook processing: Postgres polling, not BullMQ

Webhook processing is **not** queue-backed by Redis/BullMQ. An earlier version used a BullMQ/Redis-backed `WebhookProcessor`; that has been removed. `WebhookIngestService` writes every inbound event to `WebhookEvent` synchronously; `WebhookPollerService` runs every 10 seconds (`@Cron`), picks up unprocessed rows (`processedAt: null`, `attempts < 5`), and processes them directly. The Postgres row itself is the queue — this removes the Redis dependency at the cost of up to a ~10-second processing delay, which is an accepted tradeoff at current volume.

## Multi-tenancy

Every tenant-scoped table carries `tenantId` and is filtered at the application layer. On top of that, Postgres Row-Level Security is applied via a raw SQL migration (`prisma/manual-sql/001_row_level_security.sql`, since Prisma doesn't manage RLS directly) as defense-in-depth — a second isolation layer independent of any single service correctly remembering to filter by tenant.

## Cross-cutting concerns

- **Logging**: `nestjs-pino` (structured JSON logs) plus a custom `LoggingInterceptor`.
- **Errors**: global `HttpExceptionFilter` reports every 5xx to Sentry; 4xx is treated as expected traffic, not incidents.
- **Response shape**: `ResponseTransformInterceptor` wraps every successful response as `{ success: true, message, statusCode, payload }` (see `docs/api.md`); routes marked `@SkipResponseTransform()` (e.g. the Daraja webhook) are passed through unwrapped since their shape is dictated by Safaricom's contract.
- **Rate limiting**: `@nestjs/throttler`, applied per-controller with named presets in `common/throttle-tiers.ts` (`StrictPaymentThrottle` 10/min, `ReadThrottle` 120/min, `WebhookThrottle` 300/min). `TenantAwareThrottlerGuard` tracks by tenant, not IP, so tenants sharing a NAT gateway don't throttle each other.
- **Env validation**: every environment variable is declared and validated with Zod (`src/config/env.schema.ts`) at boot — a missing or malformed value fails startup instead of surfacing as a runtime bug later.

# ScriptPay Backend

Reference NestJS implementation of the architecture from the ScriptPay technical assessment.
This is a scaffold to merge into your real codebase, not a finished, runnable product —
`DarajaClient`'s methods are intentionally stubbed (see below).

## Structure

```
src/
├── modules/
│   ├── prisma/         # PrismaService + global PrismaModule
│   ├── auth/            GET /v1/me — resolves role/tenantId for a Firebase-authenticated caller
│   ├── tenants/          tenant CRUD, scoped by role
│   ├── api-keys/         issue/list/revoke scoped, hashed API keys
│   ├── payments/         STK Push initiation (tenant + dashboard variants), transaction reads, state machine
│   ├── callbacks/        idempotent webhook ingestion + async processing (with real retry/backoff)
│   ├── reconciliation/   active drift detection against Daraja's status API
│   ├── reporting/        GET /v1/reporting/summary — aggregated success/failure metrics
│   ├── audit-log/        global AuditLogService — records every sensitive action and M-Pesa interaction
│   └── alerts/           global AlertsService — Slack webhook notifications on failures
├── infrastructure/
│   └── daraja/           the ONLY place that talks to Safaricom's API — fill in the stubs here
└── common/
    ├── guards/           FirebaseAuthGuard, RolesGuard, ApiKeyGuard, TenantAwareThrottlerGuard
    ├── decorators/       @Roles(), @RequireScopes(), @CurrentUser()
    ├── throttle-tiers.ts  named rate-limit presets (StrictPaymentThrottle, ReadThrottle, WebhookThrottle)
    ├── pipes/            ZodValidationPipe
    ├── filters/          global HttpExceptionFilter (now reports 5xx to Sentry)
    └── interceptors/     structured request LoggingInterceptor
```

## Production hardening added in this pass

- **Retry/backoff for webhook processing** — `callbacks.module.ts` now sets real `defaultJobOptions` (5 attempts, exponential backoff) on the queue. Previously the code *said* "let BullMQ retry" but never configured it — BullMQ's actual default is 1 attempt.
- **A guard-ordering bug affecting every `@Roles()` check** — `RolesGuard` was registered as a global `APP_GUARD`, but NestJS runs global guards *before* controller-level ones. Since `FirebaseAuthGuard` (which sets `request.user`) is controller-level, `RolesGuard` was always seeing an empty user and rejecting every role-gated route. Fixed by applying `RolesGuard` explicitly per-controller, after `FirebaseAuthGuard`, everywhere `@Roles()` is used.
- **Rate limiting** — `@nestjs/throttler`, applied per-controller (not globally — same ordering reason as above: it needs `request.tenantId`/`request.user`, set by the auth guard that must run first). `TenantAwareThrottlerGuard` tracks by tenant, not IP, so tenants sharing a NAT gateway don't throttle each other. See `common/throttle-tiers.ts` for the actual limits.
- **Audit logging** — new `AuditLog` table + `AuditLogService`, wired into tenant creation, API key issuance/revocation, every outbound Daraja call (success and failure), and every inbound callback outcome (settled/failed/unmatched).
- **Alerts** — `AlertsService` posts to a Slack incoming webhook (`SLACK_WEBHOOK_URL`) on STK push initiation failures, Safaricom-reported failures, and webhook processing failures that exhaust all retries. Falls back to a loud log line if no webhook is configured. Email is a stubbed extension point.
- **Sentry (backend)** — was only wired into the frontend before. Now initialized in `main.ts`, and the global `HttpExceptionFilter` reports every 5xx to Sentry (4xx is treated as expected traffic, not incidents).
- **Reporting endpoint** — `GET /v1/reporting/summary` aggregates success rate, per-status counts, settled volume, and reconciliation drift count over a configurable window, via `Prisma.groupBy` (native SQL aggregation — the thing Firestore couldn't do).
- **`GET /v1/transactions/:id`** — added for the frontend's payment status polling page.
- **`POST /v1/dashboard/payments/stk-push`** — a Firebase-authenticated route separate from the API-key-authenticated `/v1/payments/stk-push`, since dashboard users don't have API keys and the two caller types need different guards.



## What's still stubbed and needs real implementation

- `infrastructure/daraja/daraja.client.ts` — OAuth token fetch, STK push initiation, and
  status query all throw `not implemented in scaffold`. Fill these in against your rotated
  sandbox credentials following Safaricom's Daraja API docs.
- `reconciliation/drift-detector.service.ts` → `recordDriftAndReconcile` — should call
  `TransactionStateMachine.transitionToSettled/Failed` with the queried result and set
  `reconciliationRecord.driftDetected = true`.

## Running locally

```bash
cp .env.example .env   # fill in real values, rotated credentials only
npm install
npx prisma migrate dev
psql $DATABASE_URL -f prisma/migrations/manual/001_row_level_security.sql
npm run start:dev
```

Requires a running Postgres instance and Redis instance (for the BullMQ webhook-processing queue).

## Auth model

- **Dashboard users** (your Next.js frontend) → Firebase ID token → `FirebaseAuthGuard` verifies
  it, then loads role/tenantId from the `User` table in Postgres. Firebase answers "who,"
  Postgres answers "what they're allowed to do." `GET /v1/me` is what the frontend calls to
  resolve this on every protected page load.
- **Tenant integrations** (a merchant's own backend calling ScriptPay) → `x-api-key` header →
  `ApiKeyGuard` verifies an argon2 hash and checks scopes.

Never conflate the two guards on one route — pick whichever matches who's actually calling it.

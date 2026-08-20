# ScriptPay Backend

NestJS implementation of ScriptPay, a multi-tenant M-Pesa (Safaricom Daraja) payment platform. `DarajaClient` (OAuth token fetch, STK Push initiation, status query) is fully implemented against Safaricom's real API contract — see `docs/architecture.md` for the full system design.

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

- **Retry for webhook processing** — inbound Daraja callbacks are written to the `WebhookEvent` table immediately, and `WebhookPollerService` polls for unprocessed rows every 10 seconds (up to 5 attempts). This replaced an earlier BullMQ/Redis-backed processor — the table row is now the durable queue, removing the Redis dependency at the cost of a small polling delay.
- **A guard-ordering bug affecting every `@Roles()` check** — `RolesGuard` was registered as a global `APP_GUARD`, but NestJS runs global guards _before_ controller-level ones. Since `FirebaseAuthGuard` (which sets `request.user`) is controller-level, `RolesGuard` was always seeing an empty user and rejecting every role-gated route. Fixed by applying `RolesGuard` explicitly per-controller, after `FirebaseAuthGuard`, everywhere `@Roles()` is used.
- **Rate limiting** — `@nestjs/throttler`, applied per-controller (not globally — same ordering reason as above: it needs `request.tenantId`/`request.user`, set by the auth guard that must run first). `TenantAwareThrottlerGuard` tracks by tenant, not IP, so tenants sharing a NAT gateway don't throttle each other. See `common/throttle-tiers.ts` for the actual limits.
- **Audit logging** — new `AuditLog` table + `AuditLogService`, wired into tenant creation, API key issuance/revocation, every outbound Daraja call (success and failure), and every inbound callback outcome (settled/failed/unmatched).
- **Alerts** — `AlertsService` posts to a Slack incoming webhook (`SLACK_WEBHOOK_URL`) on STK push initiation failures, Safaricom-reported failures, and webhook processing failures that exhaust all retries. Falls back to a loud log line if no webhook is configured. Email is a stubbed extension point.
- **Sentry (backend)** — was only wired into the frontend before. Now initialized in `main.ts`, and the global `HttpExceptionFilter` reports every 5xx to Sentry (4xx is treated as expected traffic, not incidents).
- **Reporting endpoint** — `GET /v1/reporting/summary` aggregates success rate, per-status counts, settled volume, and reconciliation drift count over a configurable window, via `Prisma.groupBy` (native SQL aggregation — the thing Firestore couldn't do).
- **`GET /v1/transactions/:id`** — added for the frontend's payment status polling page.
- **`POST /v1/dashboard/payments/stk-push`** — a JWT-authenticated route separate from the API-key-authenticated `/v1/payments/stk-push`, since dashboard users don't have API keys and the two caller types need different guards.

## Running locally

```bash
cp .env.example .env   # fill in real values, rotated credentials only
npm install
npx prisma migrate dev
psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql
npm run start:dev
```

## Auth model

- **Dashboard users** (the Next.js frontend) → email + password against this backend's own `User` table (argon2id) → the backend issues its own short-lived JWT access token + long-lived refresh token; `AccessTokenGuard` verifies the JWT on every protected route. `GET /profile` is what the frontend calls to resolve role/tenantId on every protected page load. (An earlier Firebase-based flow has been fully removed — see `docs/decisions.md`, ADR-001.)
- **Tenant integrations** (a merchant's own backend calling ScriptPay) → `x-api-key` header → `ApiKeyGuard` verifies an argon2 hash and checks scopes.

Never conflate the two guards on one route — pick whichever matches who's actually calling it. Full detail in `docs/architecture.md` and `docs/security.md`.

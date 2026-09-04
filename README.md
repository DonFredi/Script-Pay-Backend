# ScriptPay Backend

NestJS + Prisma + PostgreSQL API for **ScriptPay**, a multi-tenant M-Pesa
(Safaricom Daraja) payment platform. `DarajaClient` implements OAuth token
fetch, STK Push initiation, and status query against Safaricom's real API
contract. Counterpart repo: `Script Pay Frontend` (Next.js), which talks to
this API over REST only.

## Structure

```
src/
├── modules/
│   ├── prisma/         PrismaService + global PrismaModule
│   ├── auth/            signup/login/refresh/password-reset/email-verification, JWT issuance
│   ├── tenants/          tenant CRUD, scoped by role, encrypted Daraja credentials
│   ├── api-keys/         issue/list/revoke scoped, argon2-hashed API keys
│   ├── ledger/           tenant balance computed from LedgerEntry; authorizes payouts behind a row lock
│   ├── payments/         STK Push + B2C payouts (tenant + dashboard variants each), transaction reads, state machine
│   ├── callbacks/        idempotent webhook ingestion + Postgres-polling retry/backoff
│   ├── reconciliation/   drift detection: active recovery for collections, escalation for stuck payouts
│   ├── reporting/        GET /v1/reporting/summary — aggregated success/failure metrics
│   ├── audit-log/        global AuditLogService — records every sensitive action and M-Pesa interaction
│   └── alerts/           global AlertsService — Slack webhook notifications on failures
├── infrastructure/
│   └── daraja/           the only place that talks to Safaricom's API
└── common/
    ├── guards/           AccessTokenGuard, ApiKeyGuard, RolesGuard, CsrfGuard, TenantAwareThrottlerGuard
    ├── decorators/       @Roles(), @RequireScopes(), @CurrentUser()
    ├── throttle-tiers.ts named rate-limit presets (StrictPaymentThrottle, WebhookThrottle, ...)
    ├── pipes/            ZodValidationPipe
    ├── filters/          global HttpExceptionFilter (reports 5xx to Sentry)
    └── interceptors/     structured request LoggingInterceptor, ResponseTransformInterceptor
```

## Running locally

```bash
cp .env.example .env   # fill in real values, rotated credentials only
npm install
npx prisma migrate dev
# Policies + RLS ENABLE + the app_runtime/app_privileged roles. Safe to run now:
# the table owner is still exempt from RLS, so nothing changes for the running app.
psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql
# NOTE: do NOT also run 004_force_row_level_security.sql yet. FORCE removes the
# owner's exemption, and until DATABASE_URL points at app_runtime rather than the
# owner it makes every query outside withTenantContext return zero rows — including
# login. That file lists its own prerequisites and a rollback.
npm run start:dev
```

## Scripts

| Command | Does |
|---|---|
| `npm run start:dev` | dev server, watch mode |
| `npm run build` / `npm run start:prod` | production build/run |
| `npm run lint` | eslint --fix over `src`/`scripts` |
| `npm test` / `npm run test:cov` | Jest unit tests |
| `npm run test:e2e` | Jest e2e config |
| `npm run prisma:generate` / `npm run prisma:migrate` | Prisma client/migrations |

## Auth model

- **Dashboard users** (the Next.js frontend) → email + password against this backend's own `User` table (argon2id) → the backend issues its own short-lived JWT access token + long-lived refresh token as httpOnly cookies; `AccessTokenGuard` verifies the JWT on every protected route. `GET /profile` is what the frontend calls to resolve role/tenantId on every protected page load.
- **Tenant integrations** (a merchant's own backend calling ScriptPay) → `x-api-key` header → `ApiKeyGuard` verifies an argon2 hash and checks scopes.

Never conflate the two guards on one route — pick whichever matches who's actually calling it. `JWT_ACCESS_SECRET` must match the frontend's env var of the same name exactly — it's a shared secret used to verify tokens at the frontend's Edge middleware.

See `CLAUDE.md` for the full module map, real route table, data-model notes, and the guard-ordering rule that has silently broken production once already.

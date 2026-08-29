# CLAUDE.md — ScriptPay Backend

Guidance for Claude Code (or any AI assistant) working in this repository.

## What this project is

A NestJS + Prisma + PostgreSQL backend for **ScriptPay**, a multi-tenant M-Pesa
(Safaricom Daraja) payment platform for the Kenyan market. Tenants (merchants)
integrate against this API to initiate STK Push payments, send B2C payouts,
receive Daraja callbacks, and reconcile/report on transactions. Money moves in
**both** directions as of 2026-08-29 — this was collect-only before that.

This repo is standalone — not a monorepo. Its counterpart is a sibling
repository, `Script Pay Frontend` (Next.js 16, App Router), which is the only
consumer of this API and talks to it purely over REST/HTTP. Nothing in this
repo imports from or calls into the frontend.

## Real stack — do not assume otherwise

- **Framework**: NestJS 11 (TypeScript, decorators, DI, guards/interceptors/pipes)
- **Database**: PostgreSQL via Prisma 6 — no TypeORM, no Mongo
- **Payment provider**: Safaricom Daraja API (STK Push; C2B/Paybill/Till modeled in schema) — no Stripe, no card processing
- **Auth**: self-issued JWT (`jose`, HS256) + refresh-token rotation, argon2id password hashing. No Firebase — it was fully removed; some inline comments still say "Firebase" and are stale (see below)
- **Retry/queue**: Postgres-table polling (`WebhookPollerService` via `@nestjs/schedule` cron) — no Redis, no BullMQ
- **Other**: `argon2` (passwords + API keys), Node `crypto` AES-256-GCM (tenant Daraja credential encryption), `nestjs-pino` (structured logs), `@sentry/node`, `resend` (transactional email), `zod` (request validation + env schema)

## Project structure

```
src/
├── app.module.ts           wires everything together — no business logic here
├── main.ts                 bootstrap: env validation, Sentry init, cookie-parser, CORS
├── config/env.schema.ts    zod schema for every env var — app refuses to boot if invalid
├── modules/
│   ├── prisma/              PrismaService (global)
│   ├── auth/                 signup/login/refresh/password-reset/email-verification, JWT issuance
│   │                         AccessTokenGuard, TokenService, RefreshTokenService, EmailService
│   ├── tenants/               tenant CRUD/onboarding, encrypted Daraja credential storage
│   ├── api-keys/              issue/list/revoke scoped, argon2-hashed API keys
│   ├── ledger/                 LedgerService — tenant balance computed from LedgerEntry; guards the payout spend path; GET /v1/ledger/balance for display
│   ├── payments/               STK Push + B2C payouts (tenant + dashboard variants each), transaction reads, TransactionStateMachine
│   ├── callbacks/               inbound Daraja webhook ingestion (WebhookIngestService) + Postgres-polling processor (WebhookPollerService)
│   ├── reconciliation/          DriftDetectorService — active recovery for stuck collections, escalation for stuck payouts
│   ├── reporting/                GET /v1/reporting/summary
│   ├── audit-log/                 AuditLogService — every sensitive action + Daraja interaction
│   └── alerts/                     Slack webhook alerts on failures
├── infrastructure/daraja/  the ONLY code that calls Safaricom (DarajaClient)
└── common/                 guards, decorators, throttle tiers, pipes, filters, interceptors
```

There is no `apps/`, no `packages/`, no `k8s/`, no `docker-compose.yml`.

## Real routes

| Method | Path | Guard chain | Notes |
|---|---|---|---|
| POST | `/auth/signup`, `/auth/login` | Throttler | issues `access_token`/`refresh_token`/`csrf-token` httpOnly cookies |
| POST | `/auth/refresh` | Throttler | rotates refresh token, reissues access token |
| POST | `/auth/forgot-password`, `/auth/reset-password`, `/auth/verify-email`, `/auth/resend-verification` | Throttler, CsrfGuard | |
| GET | `/profile` | AccessTokenGuard | resolves role/tenantId for the dashboard |
| POST | `/profile/logout` | AccessTokenGuard | |
| POST/GET/PATCH | `/v1/tenants*` | AccessTokenGuard, CsrfGuard, RolesGuard | SUPER_ADMIN for create/status |
| POST/GET/DELETE | `/v1/api-keys*` | AccessTokenGuard, CsrfGuard, RolesGuard | |
| POST | `/v1/payments/stk-push` | ApiKeyGuard, TenantAwareThrottlerGuard | tenant-to-platform, scope `PAYMENTS_INITIATE` |
| POST | `/v1/dashboard/payments/stk-push` | AccessTokenGuard | dashboard-initiated STK push |
| POST | `/v1/payments/b2c` | ApiKeyGuard, TenantAwareThrottlerGuard | tenant-to-platform payout, scope `PAYMENTS_DISBURSE` (NOT `PAYMENTS_INITIATE`) |
| POST | `/v1/dashboard/payments/b2c` | AccessTokenGuard, CsrfGuard, RolesGuard | dashboard-initiated payout, `@Roles("TENANT_ADMIN")` only |
| GET | `/v1/transactions`, `/v1/transactions/:id` | AccessTokenGuard | `?direction=` filters collections vs payouts; unfiltered returns both |
| GET | `/v1/reporting/summary` | AccessTokenGuard | success rate, per-status counts, drift count — collections only at top level, payouts under `payouts` |
| GET | `/v1/ledger/balance` | AccessTokenGuard | `{ tenantId, availableMinorUnits }` — same computed figure the B2C payout balance check uses, read outside the spend path for display |
| GET | `/v1/audit-logs` | AccessTokenGuard, RolesGuard | |
| POST | `/v1/webhooks/daraja/stk-callback`, `/v1/webhooks/daraja/c2b-confirmation` | Throttler only | inbound from Safaricom; always returns 200, `@SkipResponseTransform` |
| POST | `/v1/webhooks/daraja/b2c-result`, `/v1/webhooks/daraja/b2c-timeout` | Throttler only | payout outcome / queue timeout. The timeout is NOT a failure — it releases nothing (decisions.md entry 18) |

Controllers are the source of truth for exact guard order and scopes — verify against the file before repeating a route/guard claim.

## Auth model (read before touching anything auth-related)

- **Dashboard users** (Next.js frontend) → email + password against this backend's own `User` table (argon2id) → backend issues its own short-lived (`JWT_ACCESS_TTL_SECONDS`, default 15 min) access JWT + long-lived refresh token (`JWT_REFRESH_TTL_DAYS`, default 30), both as httpOnly cookies, plus a non-httpOnly `csrf-token` cookie the frontend echoes back as `X-CSRF-Token` on mutating requests. `AccessTokenGuard` verifies the JWT (`Authorization: Bearer`) on every protected route.
- **Tenant integrations** (a merchant's own backend calling ScriptPay) → `x-api-key` header → `ApiKeyGuard` verifies an argon2 hash (prefix-narrowed lookup, then per-candidate verify) and checks `@RequireScopes(...)`.
- Never conflate the two guards on one route — pick whichever matches who's actually calling it.

### The guard-ordering rule (this has broken production before)

`RolesGuard` is **not** registered as a global `APP_GUARD` — NestJS runs global guards *before* controller-level ones, and `RolesGuard` needs `request.user`, which only `AccessTokenGuard` sets. A global `RolesGuard` would always see an empty user and reject every `@Roles()` route. It is instead applied explicitly, per-controller, *after* `AccessTokenGuard`/`ApiKeyGuard` in each `@UseGuards([...])` array — same reasoning applies to `TenantAwareThrottlerGuard`, which needs `request.tenantId` set by whichever auth guard runs before it. When adding a new guarded route, match the existing controller's guard order — don't reorder guards without understanding why they're ordered that way (`app.module.ts` has the full rationale in a comment).

## Data model highlights (`prisma/schema.prisma` is the source of truth)

- Money is **integer minor units** (`amountMinorUnits`), never float/Decimal-as-JS-number.
- `Transaction.direction` (`INBOUND`/`OUTBOUND`) is what separates a collection from a payout — they share one table, because `LedgerEntry`, `ReconciliationRecord` and `TenantWebhookDelivery` all hold required FKs to `Transaction`. Any query meaning "money in" must filter on it; `msisdn` is the payer on `INBOUND` and the payee on `OUTBOUND`.
- Tenant balance is **computed** by summing `LedgerEntry` (`LedgerService`), never stored. A payout's balance check runs behind a `FOR UPDATE` lock on the tenant row, inside the same transaction as the debit it authorizes — see `docs/decisions.md` entry 15 before touching that path.
- `WebhookEvent` is the idempotency guard — every inbound Daraja callback is inserted (unique on `(source, naturalKey)`) *before* processing; a Safaricom retry fails the insert, not the business logic.
- `RefreshToken` stores only a SHA-256 hash, tracks a rotation chain (`replacedByTokenId`) — a revoked token presented again is a theft signal.
- `AuditLog` is append-only by convention — never updated/deleted by application code.
- Tenant-scoped tables carry `tenantId` and are meant to be protected by Postgres RLS; the policy SQL lives in `prisma/manual-sql/001_row_level_security.sql` and must be applied manually (Prisma doesn't manage RLS).

## Environment

Every var is validated by `src/config/env.schema.ts` (zod) — the app refuses to boot on a missing/malformed value. See `.env.example` for the full list. Notable ones:
- `JWT_ACCESS_SECRET` must be byte-for-byte identical to the frontend's `JWT_ACCESS_SECRET` — it's a shared secret the frontend's Edge middleware uses to verify tokens this backend signs.
- `CREDENTIALS_ENCRYPTION_KEY` must be a base64-encoded 32-byte key (AES-256-GCM) for tenant Daraja credential encryption.
- `FRONTEND_ORIGIN` is a required comma-separated CORS allow-list (not optional — an unset value previously produced a silent, headerless CORS failure).

## Running locally

```bash
cp .env.example .env   # fill in real values, rotated credentials only
npm install
npx prisma migrate dev
psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql
npm run start:dev
```

## Further docs

This file and `README.md` are the fast-orientation layer. For depth, see
`docs/` (regenerated 2026-08-21, verified against source — see "What to
avoid" below for why that verification matters here specifically):

- `docs/architecture.md` — module map, request flows (STK push, webhook
  ingestion, drift detection), auth model, retry model, observability.
- `docs/decisions.md` — ADR log: each entry states the problem, the choice
  made, and *why the rejected alternative didn't fit* (e.g. why Postgres
  polling replaced BullMQ/Redis, why RolesGuard isn't global).
- `docs/api.md` — full route reference: every endpoint, guard chain, request
  body shape, and the authorization rules enforced beyond the guards
  themselves.
- `docs/database.md` — table-by-table Prisma schema reference and the
  Row-Level Security setup.
- `docs/security.md` — consolidated security posture: auth, CSRF, rate
  limiting, secrets at rest, the webhook trust boundary, known gaps.

Two project-specific skills also live in `.claude/skills/`:
`add-guarded-route` (the guard-ordering checklist, operationalized) and
`add-tenant-scoped-table` (the RLS/tenantId checklist for a new Prisma
model) — reach for these before adding a route or table from scratch.

## Known stale spots

- Inline comments in a few files (e.g. `dashboard-stk-push.controller.ts`) still say "Firebase-verified user" — functionally that's now the JWT-verified user from `AccessTokenGuard`. The comment wording is stale; the guard itself is correct. Fix the wording if you're already editing that file; don't go out of your way otherwise.

## What to avoid

- Don't invent Stripe/card/PCI-DSS terminology — this is mobile money (M-Pesa), not card processing.
- Don't assume a monorepo layout when referencing paths.
- Don't add or reorder guards on a route without reading the guard-ordering rule above first — this has silently broken every `@Roles()` check in production once already.
- Don't treat `docs/` references in old commit messages or comments as still valid — the ORIGINAL `docs/` folder was deleted (2026-08-20) because it had drifted into fictional/hallucinated content (a nonexistent `scriptpay-agent` CLI, invented files like `coding-standards.md`/`deployment.md`). A new `docs/` was regenerated the same day (see "Further docs" above), verified claim-by-claim against controllers/schema/guards rather than carried over from the deleted version — treat *that* one, plus this file and `README.md`, as current. If you extend `docs/` further, keep verifying against actual source before writing anything down; this repo has already paid for that mistake once.

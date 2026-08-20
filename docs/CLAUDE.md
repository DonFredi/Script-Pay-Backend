# Claude Integration Guide — ScriptPay Backend

This file previously contained a generic template describing a different, fictional product (Stripe payments, GraphQL gateway, microservices, Kubernetes/`apps`+`packages` monorepo). None of that matched this repository. Rewritten to describe what's actually here.

## What this project is

A NestJS + Prisma + PostgreSQL backend for **ScriptPay**, a multi-tenant M-Pesa (Safaricom Daraja) payment platform for the Kenyan market. This repo is standalone — not part of a monorepo. Its counterpart is a separate repository, `Script Pay Frontend` (Next.js), which only talks to this backend over REST; nothing in this repo talks to it back.

## Real stack

- **Framework**: NestJS (TypeScript, decorators, DI, guards/interceptors/pipes)
- **Database**: PostgreSQL via Prisma — no TypeORM
- **Payment provider**: Safaricom Daraja API (STK Push, C2B/Paybill/Till) — no Stripe
- **Auth**: self-issued JWT (`jose`) + refresh-token rotation; no Firebase (removed), no OAuth2 social login
- **Queue/retry**: Postgres-table polling (`@nestjs/schedule` cron); no Redis/BullMQ
- **Other**: `argon2` (passwords, API keys), Node's `crypto` (AES-256-GCM, Daraja credential encryption), `nestjs-pino` (structured logging), `@sentry/node`, `resend` (transactional email), `zod` (validation + env schema)

See `docs/architecture.md` for the full module map and request flow, `docs/database.md` for the schema, `docs/api.md` for real endpoints, `docs/security.md` for real security measures, `docs/decisions.md` for real architectural decisions and their rationale.

## Real project structure

```
src/
├── modules/
│   ├── prisma/            PrismaService (global) + tenant RLS context
│   ├── auth/               signup/login/refresh/password-reset/email-verification, JWT issuance
│   ├── tenants/             tenant CRUD, onboarding, encrypted Daraja credential storage
│   ├── api-keys/            issue/list/revoke scoped, argon2-hashed API keys
│   ├── payments/            STK Push (dashboard + API-key variants), transaction reads, TransactionStateMachine
│   ├── callbacks/           inbound webhook ingestion (WebhookIngestService) + Postgres-polling processor (WebhookPollerService)
│   ├── reconciliation/      DriftDetectorService — active recovery for stuck transactions
│   ├── reporting/           GET /v1/reporting/summary
│   ├── audit-log/           AuditLogService
│   └── alerts/              Slack webhook alerts
├── infrastructure/daraja/  the ONLY code that calls Safaricom
└── common/                 guards, decorators, throttle tiers, pipes, filters, interceptors
```

There is no `apps/`, no `packages/`, no `k8s/`, no `docker-compose.yml` — those don't exist in this repo.

## What to do before making claims about this project

Read the actual files, don't assume from naming conventions:
- `prisma/schema.prisma` for the real data model (not `docs/database.md`'s old content, which used to describe a `merchants` table with Stripe fields that never existed here).
- The relevant `*.controller.ts` for real routes, guards, and roles — `docs/api.md` is kept in sync but the controller is the source of truth.
- Inline code comments in this codebase are unusually dense with real "why" rationale (see `transaction-state-machine.ts`, `drift-detector.service.ts`, `auth.controller.ts`) — read them before proposing a change to logic they explain.

## Known stale spots to be aware of

- The root `README.md`'s auth section still describes `FirebaseAuthGuard` and BullMQ-based webhook retry — both have since been replaced (own JWT auth; Postgres-polling retry). Verify against `access-token.guard.ts` and `webhook-poller.service.ts` before repeating those claims.
- Some inline comments (e.g. in `dashboard-stk-push.controller.ts`) still say "Firebase-verified User record" — functionally it's now the JWT-verified user from `AccessTokenGuard`; the comment wording is stale but the guard itself is correct.

## What to avoid

- Don't invent Stripe/card/PCI-DSS terminology for this product — it's mobile money (M-Pesa), not card processing.
- Don't assume a monorepo layout when referencing paths.
- Don't add payment logic without reading `docs/security.md` and the existing guard-ordering rationale first — this codebase has a documented history of guard-ordering bugs shipping silently (see `docs/decisions.md`, ADR-006).

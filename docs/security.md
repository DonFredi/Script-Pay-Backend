# Security — ScriptPay Backend

Consolidated security posture: what's enforced, where, and what's
deliberately out of scope. Verified against guards/services/schema as of
2026-08-21. Cross-references `docs/decisions.md` for the reasoning behind
choices that had a rejected alternative worth recording.

## Authentication

Two independent mechanisms, never combined on one route (see
`docs/architecture.md`, "Auth model"):

- **Dashboard sessions**: self-issued JWT (`jose`, HS256, `TokenService`),
  15-minute access token + 30-day refresh token, both httpOnly cookies.
  `AccessTokenGuard` verifies the access JWT on every protected route.
- **Tenant integrations**: `x-api-key` header, verified by `ApiKeyGuard`
  against an argon2 hash (`keyPrefix`-narrowed lookup, then per-candidate
  `argon2.verify`), scope-checked via `@RequireScopes(...)`.

Password storage: argon2id (`User.passwordHash`). No password is ever logged
or stored outside this column.

## Session integrity

- **Refresh token rotation**: every use of a refresh token revokes it and
  issues a new one (`replacedByTokenId` chain). A revoked token presented
  again is a reuse signal — a strong indicator the token was stolen and used
  by both the legitimate holder and an attacker.
- **Refresh tokens are hashed (SHA-256) before storage** — a stolen database
  backup alone does not hand out usable sessions.
- **Cookie flags**: `httpOnly` on `access_token`/`refresh_token` (invisible
  to any JS, including via XSS), `secure` in production, `sameSite: "lax"`.
  `refresh_token` is additionally path-scoped
  (`/api/backend/auth/refresh`) — it is never sent to unrelated endpoints.

## CSRF

Double-submit cookie pattern (`CsrfGuard` + `generateCsrfToken`): a
non-httpOnly `csrf-token` cookie is set at login/signup; every
POST/PUT/PATCH/DELETE to a `CsrfGuard`-protected route must echo that exact
value in `X-CSRF-Token`. Applied on every cookie-authenticated, state-changing
route with real consequences — password reset, tenant creation/status
changes, Daraja credential updates, API key issuance/revocation, dashboard
payment initiation, logout. **Not** applied to:

- `GET`/`HEAD`/`OPTIONS` (safe methods).
- `/v1/webhooks/*` — Safaricom is the caller, not a browser; it cannot read
  or echo a cookie-derived header.
- `POST /v1/payments/stk-push` (the API-key-authenticated tenant route) —
  CSRF is a browser-cookie attack; an `x-api-key`-authenticated request
  carries no ambient browser credential for CSRF to forge in the first
  place.
- `/auth/signup`, `/auth/login`, `/auth/refresh` — no session exists yet to
  forge.

## Authorization

- **`RolesGuard`** checks `request.user.role` against `@Roles(...)`. Applied
  per-controller, always *after* `AccessTokenGuard` in the same
  `@UseGuards([...])` array — never registered globally. See
  `docs/decisions.md` entry 6 for why a global registration is actively
  wrong (empty `request.user`, silently rejects every `@Roles()` route) and
  has broken production once already. **Do not reorder guards on a route
  without reading that entry first.**
- **Row-level authorization beyond `@Roles()`** lives in service methods,
  not decorators, wherever a role alone isn't a fine-enough check: a
  `TENANT_ADMIN` can only manage their *own* tenant's status/keys/transactions
  (enforced in `TenantsService`/`ApiKeysService`/`TransactionsController`),
  even though the route itself is open to the role generally. `SUPER_ADMIN`
  callers are required to pass an explicit `?tenantId=` on cross-tenant read
  endpoints (transactions, reporting) rather than defaulting to a full-table
  scan.
- **Scoped API keys**: `@RequireScopes(...)` limits what an API key can do
  independent of which tenant it belongs to — a leaked read-only reporting
  key cannot initiate payments.

## Rate limiting

`TenantAwareThrottlerGuard` tracks by `tenantId` (set by whichever auth guard
ran first) instead of IP alone — default `@nestjs/throttler` IP-tracking is
wrong for a multi-tenant API, since several tenants' integrations can share
an egress IP behind a corporate/cloud NAT. Falls back to IP only for fully
unauthenticated requests. Three tiers (`src/common/throttle-tiers.ts`):

| Tier | Limit | Applied to |
|---|---|---|
| `StrictPaymentThrottle` | 10/min | Payment initiation, signup/login, API key issuance, password reset |
| `ReadThrottle` | 120/min | Transaction/reporting/audit-log reads |
| `WebhookThrottle` | 300/min | Inbound Daraja webhooks — generous, since real protection there is idempotency, not rate limiting |

## Secrets at rest

| Secret | Mechanism | Reversible? |
|---|---|---|
| User password | argon2id | No |
| API key | argon2 (+ `API_KEY_HASH_PEPPER`) | No |
| Refresh token | SHA-256 | No |
| Email verification / password reset token | SHA-256 (implied by "hashed", same pattern as refresh tokens) | No |
| Tenant Daraja Consumer Secret / Passkey | AES-256-GCM | Yes — the backend must recover the real value to call Safaricom |
| Tenant Daraja Consumer Key | Plaintext | N/A — Safaricom treats it like a client ID, not a secret |

`CREDENTIALS_ENCRYPTION_KEY` (32-byte, base64) is the AES key for the one
reversible case. `API_KEY_HASH_PEPPER` is an application-wide secret mixed
into every API key hash, independent of the per-key salt argon2 already
applies — a second, deployment-level secret an attacker would need in
addition to a stolen database backup.

## Input validation

Every mutating route validates its body through `ZodValidationPipe(<schema>)`
before the controller method runs — malformed input never reaches business
logic. Notable domain constraints enforced at this layer: MSISDN format
(`^254(7|1)\d{8}$`), STK push amount ceiling (KES 150,000, Safaricom's actual
per-push limit), Daraja's hard length limits on `accountReference` (12 chars)
and `transactionDesc` (13 chars), Paybill/Till shortcode format (5–7 digits).

## Webhook trust boundary

Inbound Daraja webhooks (`/v1/webhooks/daraja/*`) carry **no auth guard** —
Safaricom is the caller, not a credentialed party this system issues
credentials to. Trust is established structurally instead:

- `WebhookEvent`'s unique constraint on `(source, naturalKey)` is the
  idempotency guard — the actual defense against replay, not an
  authentication check.
- A callback for an unrecognized `CheckoutRequestID`/`businessShortcode` is
  logged and audit-recorded (`daraja.callback_unmatched` /
  `daraja.c2b_unmatched`) but otherwise ignored — it cannot mutate a
  transaction it isn't the legitimate result for.
- The endpoint always returns HTTP 200, even on internal failure — this is a
  protocol requirement (Safaricom retries aggressively on anything else),
  not a security relaxation; failures are captured in `WebhookEvent.processingError`
  and alerted on via `AlertsService` after `MAX_ATTEMPTS` (5).

## Audit trail

`AuditLogService` records every sensitive action — admin actions (tenant
creation, status changes, key issuance/revocation) and every outbound Daraja
interaction, not just inbound callbacks (`WebhookEvent` covers those
separately). Append-only by convention: application code never updates or
deletes a row. `GET /v1/audit-logs` is `RolesGuard`-restricted to
`SUPER_ADMIN`/`TENANT_ADMIN` — `TENANT_STAFF` cannot read it.

## Defense in depth: Row-Level Security

Every tenant-scoped table is meant to carry a Postgres RLS policy
(`prisma/manual-sql/001_row_level_security.sql`) as a second, independent
layer beneath application-level `tenantId` filtering. This is not managed by
Prisma migrations and must be applied manually — see `docs/database.md`. It
exists specifically so a single missed `where: { tenantId }` clause anywhere
in the codebase is not, by itself, sufficient to leak cross-tenant data.

## Observability

- `@sentry/node` reports 5xx errors via the global `HttpExceptionFilter`.
- `AlertsService` sends Slack webhook notifications for operationally
  significant security-relevant events (webhook processing exhausted its
  retries, STK push failed at Safaricom).
- `nestjs-pino` structured logs via `LoggingInterceptor` on every request.

## Known gaps / out of scope

- No CI pipeline or automated security scanning is currently configured in
  this repo (no `.github/workflows/`, no Dockerfile) — verified absent as of
  2026-08-21, not merely undocumented.
- RLS policy application is a manual step (`psql -f ...`) with no automated
  check that it was actually run against a given database — a fresh
  environment that skips this step loses the second isolation layer without
  any error surfacing.

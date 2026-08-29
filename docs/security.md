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
non-httpOnly `csrf-token` cookie is set at login/signup, and reissued on every
`/auth/refresh`; every POST/PUT/PATCH/DELETE to a `CsrfGuard`-protected route
must echo that exact value in `X-CSRF-Token`. Applied on every
cookie-authenticated, state-changing route with real consequences — password
reset, tenant creation/status changes, Daraja credential updates, API key
issuance/revocation, dashboard payment initiation, logout, **and
`/auth/refresh`**.

`/auth/refresh` was the one exception until 2026-08-28, when it was brought in
line with its siblings. It is worth stating why it belongs here rather than in
the "no session exists yet" list below: unlike signup and login, refresh *does*
act on an existing session — it presents the httpOnly `refresh_token` cookie a
browser attaches automatically, so a cross-origin page could previously trigger
it. Nothing is readable cross-origin, so there was no exfiltration path, but a
forged refresh still rotates the victim's refresh token, and a rotated token
replayed outside `RefreshTokenService`'s 10-second grace window is treated as
theft — which revokes every session that user has.

Because the guard now runs on refresh, the `csrf-token` cookie is issued with
the **same** lifetime as `refresh_token` (`JWT_REFRESH_TTL_DAYS`), not a
shorter fixed window. A csrf cookie that expired first would be an
unrecoverable lockout: only login and refresh mint a new one, and refresh
would be rejecting the request.

Refresh uses `RefreshCsrfGuard` (`modules/auth/refresh-csrf.guard.ts`), a
`CsrfGuard` subclass with exactly one exemption: a request carrying **no**
`refresh_token` cookie is allowed through. That is the case the handler
already treats as a no-op — it returns `{ accessToken: null }` before issuing
a cookie or touching the database — so there is no state change for a forged
request to cause. It matters because the frontend's `AuthProvider` calls this
endpoint blind on first load to discover whether a session exists, and a
logged-out visitor sends neither the cookie nor the header; plain `CsrfGuard`
would 403 every first-time visitor. The moment a session cookie *is* present —
the only situation in which a forged refresh could rotate someone's token —
full validation applies.

**Not** applied to:

- `GET`/`HEAD`/`OPTIONS` (safe methods).
- `/v1/webhooks/*` — Safaricom is the caller, not a browser; it cannot read
  or echo a cookie-derived header.
- `POST /v1/payments/stk-push` (the API-key-authenticated tenant route) —
  CSRF is a browser-cookie attack; an `x-api-key`-authenticated request
  carries no ambient browser credential for CSRF to forge in the first
  place.
- `/auth/signup`, `/auth/login` — no session exists yet to forge. (These, and
  only these, are the genuine "nothing to protect" cases; `/auth/refresh` used
  to be listed here in error, as described above.)

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
- **`PAYMENTS_DISBURSE` is separate from `PAYMENTS_INITIATE` on purpose.**
  Sending money out (`POST /v1/payments/b2c`) is the one capability that can
  drain a tenant's balance, so it is not implied by the scope that collects
  payments. Every API key already in the database carries
  `PAYMENTS_INITIATE` — it is in the default set auto-provisioned on tenant
  activation (`ApiKeysService.provisionDefaultKeyIfNeeded`) — so widening
  that scope's meaning to cover payouts would have silently granted the
  capability to every existing key the moment the route shipped. It is also
  deliberately absent from that default set: a tenant gets payout ability
  only on a key somebody issued with it explicitly. Note the scope list is
  duplicated by hand in `api-key.dto.ts` (zod cannot read a Prisma enum), so
  both must be edited together.
- **Solvency is enforced in the ledger, not the guard.** A caller holding
  `PAYMENTS_DISBURSE` still cannot pay out more than the tenant's balance:
  `LedgerService.assertSufficientBalance` takes a `FOR UPDATE` lock on the
  tenant row and sums `LedgerEntry` inside the same transaction that writes
  the debit, so two concurrent payouts cannot both pass the same check. See
  `docs/decisions.md` entry 15.
- **Tenant status is an authorization check, not just a label.** Suspending a
  tenant does *not* revoke their API keys, so `ApiKeyGuard` alone will keep
  authenticating them. `TenantsService.getMpesaCredentialsForPayment` refuses
  to release Daraja credentials for a `suspended` tenant (added 2026-08-28),
  which is what actually stops a suspended merchant from continuing to charge
  customers. This mirrors the inbound side, where
  `WebhookPollerService.processC2bConfirmation` already scoped its shortcode
  lookup to `status: "active"`. `pending_kyc` is deliberately still permitted
  — that is the state a tenant tests from against Safaricom's sandbox before
  approval.

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
| Tenant webhook secret (`Tenant.webhookSecretEncrypted`) | AES-256-GCM | Yes — `TenantWebhookPollerService` must recover it to sign each outbound delivery's HMAC |

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
- A callback for an unrecognized `CheckoutRequestID`/`businessShortcode`/
  `OriginatorConversationID` is logged and audit-recorded
  (`daraja.callback_unmatched` / `daraja.c2b_unmatched` /
  `daraja.b2c_callback_unmatched`) but otherwise ignored — it cannot mutate a
  transaction it isn't the legitimate result for.
- **Collections and payouts cannot cross-contaminate.** The two directions
  correlate on different columns (`checkoutRequestId` vs
  `originatorConversationId`), so an STK callback structurally cannot match a
  payout row and vice versa. `TransactionStateMachine` additionally refuses
  the crossing outright — `assertNotOutbound` on the collection transitions,
  `assertOutbound` on the payout ones — because the failure mode there is not
  a wrong response but ledger entries written in the wrong direction, which
  nothing downstream would flag.
- **A B2C queue timeout is not treated as a failure.** Releasing a
  reservation on a timeout, when the payout may still complete, is a
  double-spend. The handler holds the reservation and escalates instead — see
  `docs/api.md` on `/v1/webhooks/daraja/b2c-timeout`.
- The endpoint always returns HTTP 200, even on internal failure — this is a
  protocol requirement (Safaricom retries aggressively on anything else),
  not a security relaxation; failures are captured in `WebhookEvent.processingError`
  and alerted on via `AlertsService` after `MAX_ATTEMPTS` (5).

## Outbound webhook trust boundary

The reverse of the inbound case above: ScriptPay is the caller, a tenant's
own server is the recipient. Trust runs the other direction accordingly:

- `POST /v1/tenants/webhook-config` is `ApiKeyGuard`-gated with
  `@RequireScopes("WEBHOOKS_MANAGE")` — only a tenant holding a key with that
  scope can set or rotate *their own* `webhookUrl`; `request.tenantId` comes
  from the verified key, never from the request body.
- The webhook secret is generated server-side (never accepted from the
  caller) and shown exactly once, same principle as API key issuance — a
  weak or guessable tenant-chosen secret is never possible.
- Every delivery is signed (`X-ScriptPay-Signature: sha256=<HMAC-SHA256 of
  the raw body>`) so the tenant's receiver can verify a request genuinely
  came from ScriptPay before acting on it — this is the outbound equivalent
  of `WebhookEvent`'s idempotency guard protecting the inbound side.
- `webhookUrl` must be `https://` (enforced by the zod schema) — no
  plaintext delivery of settlement data.
- A delivery only ever fires for a tenant that has explicitly configured a
  `webhookUrl` — opt-in, not a default that would otherwise POST tenant
  transaction data to an unconfigured/attacker-guessable destination.

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
- **Stuck payouts are escalated to a human, not auto-recovered.** A payout
  left `PROCESSING` (no result callback, or a queue timeout) keeps its funds
  reserved and unspendable until someone resolves it in Safaricom's portal.
  `DriftDetectorService.detectStuckPayouts` alerts once per payout after 5
  minutes; it cannot settle or fail one itself, because Daraja's Transaction
  Status API answers asynchronously and auto-recovery therefore needs its own
  callback route and correlation. See `docs/decisions.md` entry 18. The
  collection path does self-heal, so this asymmetry is specific to payouts.
- **The B2C amount ceiling in `initiate-b2c.dto.ts` (KES 250,000) has not
  been verified against live Daraja documentation** for a specific shortcode,
  and it is explicitly *not* the same limit as the STK push one. It bounds
  requests that Safaricom would reject anyway; it is not what protects the
  platform from over-spending — the ledger balance check is. Confirm it
  before going live.

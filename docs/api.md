# API Reference — ScriptPay Backend

Every route in this repo, its guard chain, request/response shape, and the
authorization rule enforced beyond the guards themselves. Verified directly
against each controller and its zod schema/DTO as of 2026-08-21 — controllers
are still the source of truth if this drifts.

Every non-webhook response is wrapped by `ResponseTransformInterceptor`
(`{ success, message, statusCode, payload }`) unless the route carries
`@SkipResponseTransform()`. Request bodies are validated with
`ZodValidationPipe(<schema>)` — an invalid body returns a 400 with per-field
errors, never reaches the controller/service.

## Auth — `/auth/*`

Base guard: `ThrottlerGuard` (default tier) on the whole controller.

| Method | Path | Extra guard | Throttle | Body |
|---|---|---|---|---|
| POST | `/auth/signup` | — | `StrictPaymentThrottle` (10/min) | `{ username, email, password, confirmPassword }` |
| POST | `/auth/login` | — | `StrictPaymentThrottle` | `{ email, password }` |
| POST | `/auth/refresh` | — | default | none (reads `refresh_token` cookie) |
| POST | `/auth/forgot-password` | `CsrfGuard` | `StrictPaymentThrottle` | `{ email }` |
| POST | `/auth/reset-password` | `CsrfGuard` | `StrictPaymentThrottle` | `{ token, password, confirmPassword }` |
| POST | `/auth/verify-email` | `CsrfGuard` | default | `{ token }` |
| POST | `/auth/resend-verification` | `CsrfGuard` | `StrictPaymentThrottle` | `{ email }` |

`signup`/`login` set three cookies on success: `access_token` (httpOnly,
15 min), `refresh_token` (httpOnly, path-scoped to `/api/backend/auth/refresh`,
`refreshTtlDays` from env), `csrf-token` (NOT httpOnly, 7 days) — and return
`{ user, accessToken }` in the payload. `refresh` rotates the refresh token
(old one revoked, `replacedByTokenId` set) and reissues both cookies. There is
no `CsrfGuard` on `signup`/`login`/`refresh` — no session exists yet to forge.

## Profile — `/profile`

Deliberately a separate controller from `AuthController`, matching the
frontend's own module split (`me.api.ts` → `GET /profile`, `logout.api.ts` →
`POST /profile/logout`, not `/auth/logout`).

| Method | Path | Guard | Notes |
|---|---|---|---|
| GET | `/profile` | `AccessTokenGuard` | Returns `{ id, username, email, roles: [role], tenantId, emailVerified }` — what the frontend calls on every protected page load to resolve identity. |
| POST | `/profile/logout` | `CsrfGuard` | Revokes the presented refresh token, clears all three auth cookies. |

## Tenants — `/v1/tenants`

Guard chain: `AccessTokenGuard, CsrfGuard, RolesGuard` (order matters —
`RolesGuard` reads `request.user`, set by `AccessTokenGuard`).

| Method | Path | Roles | Body | Notes |
|---|---|---|---|---|
| POST | `/v1/tenants` | `SUPER_ADMIN` | `{ name, businessShortcode }` | Platform-staff-created tenant. |
| POST | `/v1/tenants/onboard` | any authenticated | `{ name, businessShortcode }` | Self-service onboarding; `TenantsService.onboardSelf` enforces caller is `TENANT_ADMIN` with no existing tenant. **The caller's current access token still has `tenantId: null`** after this succeeds (signed before onboarding) — the frontend must call `/auth/refresh` immediately after, or every subsequent request looks tenant-less. |
| GET | `/v1/tenants` | `SUPER_ADMIN` | — | List all tenants. |
| GET | `/v1/tenants/:id` | any authenticated | — | No `@Roles()` restriction at the decorator level — `TenantsService.findOne` enforces "only your own tenant" for non-`SUPER_ADMIN` callers. |
| POST | `/v1/tenants/:id/mpesa-credentials` | any authenticated (service-enforced) | `{ businessShortcode, consumerKey, consumerSecret, passkey }` | Encrypts `consumerSecret`/`passkey` before storage (see `docs/architecture.md`, secrets section). |
| PATCH | `/v1/tenants/:id/status` | `SUPER_ADMIN`, `TENANT_ADMIN` | `{ status: "active" \| "suspended" \| "pending_kyc" }` | `SUPER_ADMIN` may set any status on any tenant. `TENANT_ADMIN` may only toggle their own tenant between `active`/`suspended` — `TenantsService.updateStatus` blocks a `TENANT_ADMIN` from setting `pending_kyc`, even though the DTO itself accepts the value (authorization lives in the service, not the schema). `TENANT_STAFF` is excluded entirely by `@Roles()`. |

## API keys — `/v1/api-keys`

Guard chain: `AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard`,
`@Roles("TENANT_ADMIN", "SUPER_ADMIN")`. Cookie/session-authenticated — this
manages keys, it does not authenticate via one; don't confuse it with
`ApiKeyGuard` on the payments routes below.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/api-keys` | `{ scopes: ApiKeyScope[], expiresAt?: Date }` | `StrictPaymentThrottle` — key issuance is rare and sensitive, same ceiling as payment initiation. `scopes` ∈ `PAYMENTS_INITIATE`, `PAYMENTS_READ`, `RECONCILIATION_READ`, `WEBHOOKS_MANAGE`, at least one required. Raw key returned once, at creation, never again. |
| GET | `/v1/api-keys` | — | Lists the caller's tenant's keys (hash never returned). |
| DELETE | `/v1/api-keys/:id` | — | Revokes a key belonging to the caller's tenant. |

`SUPER_ADMIN` callers have `tenantId: null` and are rejected with
`ForbiddenException("Platform staff must specify a tenant explicitly")` on
all three routes — this controller manages *a specific tenant's* keys, not
platform-wide key administration.

## Payments — STK Push initiation

Two separate controllers, same underlying `StkPushService`, deliberately
different guard chains — see `docs/decisions.md` in the backend for the
non-obvious parts of this split.

### `POST /v1/payments/stk-push` — tenant-to-platform

Guard chain: `ApiKeyGuard, TenantAwareThrottlerGuard`. `@RequireScopes("PAYMENTS_INITIATE")`,
`StrictPaymentThrottle` (10/min, tracked per-tenant). `tenantId` comes from
`request.tenantId`, set by `ApiKeyGuard` — never from the request body.

### `POST /v1/dashboard/payments/stk-push` — dashboard-initiated

Guard chain: `AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard`,
`@Roles("TENANT_ADMIN", "TENANT_STAFF")`, `StrictPaymentThrottle`. `tenantId`
comes from `user.tenantId` (the logged-in caller's own token claim) — never
from the request body, so a tampered field can't initiate a payment against a
tenant the caller doesn't belong to. Returns 403 if the caller's account has
no associated tenant yet (hasn't completed onboarding).

### Request body (both routes) — `InitiateStkPushDto`

```ts
{
  msisdn: string;            // ^254(7|1)\d{8}$ — Kenyan MSISDN, 2547XXXXXXXX or 2541XXXXXXXX
  amountMinorUnits: number;  // positive integer, max 15,000,000 (KES 150,000 — Safaricom's per-push limit)
  accountReference: string;  // 1–12 chars — Daraja hard limit
  transactionDesc: string;   // 1–13 chars — Daraja hard limit
  metadata?: Record<string, unknown>; // echoed back on the transaction record; never trusted for amount/identity
  channel?: "PAYBILL" | "TILL"; // defaults to "PAYBILL"
}
```

Creates a `Transaction` row (`status: PENDING`), calls `DarajaClient` to
initiate the real STK push, records `daraja.stk_push_initiated` (or
`_failed`) in the audit log.

## Transactions — `/v1/transactions`

Guard chain: `AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard`, `ReadThrottle`
(120/min). Dashboard-facing reads only.

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/v1/transactions` | `status?`, `tenantId?` | Non-`SUPER_ADMIN` callers are always scoped to their own tenant regardless of `tenantId`. `SUPER_ADMIN` **must** pass `?tenantId=` explicitly — there is no cross-tenant default list, to avoid an accidental full-table scan becoming the norm for platform staff. Returns up to 100 rows, newest first. |
| GET | `/v1/transactions/:id` | — | Backs the payment-status page the frontend polls at a short interval while a transaction is `PENDING`/`PROCESSING`. 404 if not found; 403 if it belongs to a different tenant than the caller's (a tenant can't poll another tenant's transaction by guessing its UUID). |

## Reporting — `/v1/reporting/summary`

Guard chain: `AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard`, `ReadThrottle`.

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/v1/reporting/summary` | `tenantId?` (required if `SUPER_ADMIN`), `days?` (default 7) | Success rate, per-status counts, drift count over the window. |

## Audit logs — `/v1/audit-logs`

Guard chain: `AccessTokenGuard, RolesGuard`, `@Roles("SUPER_ADMIN", "TENANT_ADMIN")`,
`ReadThrottle`. `TENANT_STAFF` is excluded entirely — audit history is an
admin-level concern.

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/v1/audit-logs` | `tenantId?`, `action?` | `SUPER_ADMIN` may query any tenant's log (or all, if `tenantId` omitted). `TENANT_ADMIN` is scoped to their own tenant by `AuditLogService.list` regardless of what `tenantId` they pass. |

## Webhooks — `/v1/webhooks/daraja/*`

Guard: `ThrottlerGuard` only (`WebhookThrottle`, 300/min) — no auth guard,
since Safaricom is the caller, not a dashboard user or tenant. Real
protection is the `WebhookEvent` idempotency constraint, not authentication.
`@SkipResponseTransform()` on the whole controller: Safaricom expects exactly
`{ ResultCode, ResultDesc }`, not the standard response envelope.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/webhooks/daraja/stk-callback` | STK Push result. Always returns `{ ResultCode: 0, ResultDesc: "Accepted" }` / HTTP 200, even on internal processing failure — Safaricom retries aggressively on anything else. |
| POST | `/v1/webhooks/daraja/c2b-confirmation` | Paybill/Till payment confirmation. Same always-200 contract. |

Both routes only *ingest* (write a `WebhookEvent` row) — actual processing
happens asynchronously via `WebhookPollerService`; see `docs/architecture.md`.

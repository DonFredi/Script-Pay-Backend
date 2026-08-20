# API Reference

There is no deployed staging/production domain to document — this backend is run locally (`npm run start:dev`) against whatever `PORT` is configured. All routes below are relative to that base URL; most are prefixed `/v1`, auth routes are not.

## Response envelope

Every successful response is wrapped by `ResponseTransformInterceptor`:

```json
{
  "success": true,
  "message": "OK",
  "statusCode": 200,
  "payload": { }
}
```

Errors (`HttpExceptionFilter`) follow the matching shape with `success: false`. The one exception is the Daraja webhook endpoint (`@SkipResponseTransform()`), which returns exactly `{ "ResultCode": 0, "ResultDesc": "..." }` because that shape is dictated by Safaricom's own contract, not ours.

## Auth (`/auth`, no `/v1` prefix)

| Method | Path | Notes |
|---|---|---|
| POST | `/auth/signup` | sets `refresh_token`, `access_token`, `csrf-token` cookies; returns `{ user, accessToken }` |
| POST | `/auth/login` | same cookie/response shape as signup |
| POST | `/auth/refresh` | reads the httpOnly `refresh_token` cookie; returns `{ accessToken: string \| null }` — `null`, not an error, if there's no valid session |
| POST | `/auth/forgot-password` | CSRF-protected |
| POST | `/auth/reset-password` | CSRF-protected |
| POST | `/auth/verify-email` | CSRF-protected |
| POST | `/auth/resend-verification` | CSRF-protected |

`GET /profile` and `POST /profile/logout` (separate `ProfileController`, `/profile` prefix) resolve the current user and clear the `access_token` cookie, respectively.

## Tenants — `/v1/tenants`
Guards: `AccessTokenGuard, CsrfGuard, RolesGuard`

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/v1/tenants` | `SUPER_ADMIN` | create a tenant |
| POST | `/v1/tenants/onboard` | any authenticated user | self-service onboarding; re-login required after, since the access token needs a fresh `tenantId` claim |
| GET | `/v1/tenants` | (see controller) | list |
| GET | `/v1/tenants/:id` | (see controller) | tenant-scoped read |
| POST | `/v1/tenants/:id/mpesa-credentials` | (see controller) | stores Daraja consumer secret/passkey, encrypted at rest |
| PATCH | `/v1/tenants/:id/status` | `SUPER_ADMIN` can act on any tenant; `TENANT_ADMIN` only their own; `TENANT_STAFF` blocked entirely |

## API keys — `/v1/api-keys`
Guards: `AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard` · Roles: `TENANT_ADMIN, SUPER_ADMIN`

Cookie/session-authenticated (a dashboard user managing their own tenant's keys) — distinct from `ApiKeyGuard` below, which authenticates the keys themselves.

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/api-keys` | `StrictPaymentThrottle`; returns the raw key exactly once |
| GET | `/v1/api-keys` | list for the caller's tenant |
| DELETE | `/v1/api-keys/:id` | revoke |

## Payments

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/v1/payments/stk-push` | `ApiKeyGuard` + scope `PAYMENTS_INITIATE` | for a tenant's own external systems |
| POST | `/v1/dashboard/payments/stk-push` | `AccessTokenGuard, CsrfGuard, RolesGuard` | for the dashboard's own "send a payment" form; `tenantId` always comes from the authenticated user, never from the request body |

Both ultimately call the same `StkPushService` / `DarajaClient.initiateStkPush`; they exist as separate controllers because the two caller types need different guards (`ApiKeyGuard` sets `request.tenantId` for tenant-aware throttling, `AccessTokenGuard` does not).

## Transactions — `/v1/transactions`
Guards: `AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard` (`ReadThrottle`)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/transactions` | tenant staff/admins see only their own tenant; `SUPER_ADMIN` may pass `?tenantId=` but gets no cross-tenant list by default |
| GET | `/v1/transactions/:id` | same tenant scoping |

## Reporting — `/v1/reporting`
Guards: `AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard` (`ReadThrottle`)

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/reporting/summary?days=` | `SUPER_ADMIN` must pass `?tenantId=` explicitly; aggregated success rate, per-status counts, settled volume, and drift count over the window, via `Prisma.groupBy` |

## Audit logs — `/v1/audit-logs`
Guards: `AccessTokenGuard, RolesGuard` (`ReadThrottle`) · Roles: `SUPER_ADMIN, TENANT_ADMIN`

| Method | Path | Notes |
|---|---|---|
| GET | `/v1/audit-logs?tenantId=` | `SUPER_ADMIN` can query any tenant or omit `tenantId` for all; `TENANT_ADMIN` is always scoped to their own tenant regardless of what they pass. `TENANT_STAFF` cannot access this at all. |

## Daraja webhooks — `/v1/webhooks/daraja`
Guard: `ThrottlerGuard` (`WebhookThrottle`, 300/min) — unauthenticated by nature, since Safaricom calls this directly. Real protection is idempotency (unique `(source, naturalKey)`) plus `CheckoutRequestID` matching, not a credential check. Responses are **not** wrapped in the standard envelope (`@SkipResponseTransform()`).

| Method | Path | Notes |
|---|---|---|
| POST | `/v1/webhooks/daraja/stk-callback` | STK Push result callback |
| POST | `/v1/webhooks/daraja/c2b-confirmation` | Paybill/Till confirmation |

Both return `200 OK` with `{ ResultCode: 0, ResultDesc: "Accepted" }` immediately — actual processing is async, picked up by `WebhookPollerService` (see `docs/architecture.md`).

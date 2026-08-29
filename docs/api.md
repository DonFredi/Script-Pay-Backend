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
| POST | `/v1/tenants/:id/mpesa-credentials` | any authenticated (service-enforced) | `{ businessShortcode, consumerKey, consumerSecret, passkey, initiatorName?, securityCredential? }` | Encrypts `consumerSecret`/`passkey` before storage (see `docs/architecture.md`, secrets section). `initiatorName`/`securityCredential` are the B2C payout credentials — **optional, but must be supplied together** (zod rejects one without the other) and omitting both leaves any previously-stored pair untouched rather than wiping it, so a tenant re-submitting only collection credentials does not silently lose payout access. `securityCredential` is pasted from Safaricom's portal already RSA-encrypted; ScriptPay never sees the initiator password (`docs/decisions.md` entry 17). Without these, `POST /v1/payments/b2c` returns 403 with a message distinct from the collection-credentials one. |
| PATCH | `/v1/tenants/:id/status` | `SUPER_ADMIN`, `TENANT_ADMIN` | `{ status: "active" \| "suspended" \| "pending_kyc" }` | `SUPER_ADMIN` may set any status on any tenant. `TENANT_ADMIN` may only toggle their own tenant between `active`/`suspended` — `TenantsService.updateStatus` blocks a `TENANT_ADMIN` from setting `pending_kyc`, even though the DTO itself accepts the value (authorization lives in the service, not the schema). `TENANT_STAFF` is excluded entirely by `@Roles()`. **A transition into `active` from any other status auto-provisions the tenant's first API key** (see the API-keys section below and `docs/decisions.md` entry 14) — idempotent, skipped if the tenant already holds a live key. |

## API keys — `/v1/api-keys`

Guard chain: `AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard`,
`@Roles("TENANT_ADMIN", "SUPER_ADMIN")`. Cookie/session-authenticated — this
manages keys, it does not authenticate via one; don't confuse it with
`ApiKeyGuard` on the payments routes below.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/api-keys` | `{ scopes: ApiKeyScope[], expiresAt?: Date }` | `StrictPaymentThrottle` — key issuance is rare and sensitive, same ceiling as payment initiation. `scopes` ∈ `PAYMENTS_INITIATE`, `PAYMENTS_READ`, `RECONCILIATION_READ`, `WEBHOOKS_MANAGE`, `PAYMENTS_DISBURSE`, at least one required. `PAYMENTS_DISBURSE` (send money out) is **not** in the auto-provisioned default set and is not implied by `PAYMENTS_INITIATE` — a tenant wanting payouts must be issued a key carrying it explicitly. Raw key returned once, at creation, never again. |
| GET | `/v1/api-keys` | — | Lists the caller's tenant's keys (hash never returned). |
| DELETE | `/v1/api-keys/:id` | — | Revokes a key belonging to the caller's tenant. |

`TENANT_ADMIN` is always scoped to their own tenant on all three routes,
regardless of any `?tenantId=` they pass. `SUPER_ADMIN` callers have
`tenantId: null` and must pass `?tenantId=` explicitly on all three
(`BadRequestException` if omitted) — there's no "act on every tenant at once"
mode, this is per-tenant, on-demand only. This applies to `create` too as of
2026-08-27: platform staff can now issue a key on a tenant's behalf (e.g.
onboarding/support), matching the oversight `list`/`revoke` already had —
previously `create` unconditionally rejected any caller with `tenantId: null`.
The primary path for a tenant obtaining a key is now neither of the above by
default: as of 2026-08-27, `TenantsService.updateStatus` auto-provisions a
default-scoped key (`PAYMENTS_INITIATE`, `PAYMENTS_READ`, `WEBHOOKS_MANAGE`)
the moment a tenant transitions into `"active"`, emailed once to every
`TENANT_ADMIN` on the account — see `docs/decisions.md` entry 14. This route
remains available for a tenant that wants a second scoped key, or platform
staff provisioning one manually; it's an optional capability, not a required
onboarding step.

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

## Payments — B2C payout initiation

### `POST /v1/payments/b2c` — tenant-to-platform

Guard chain: `ApiKeyGuard, TenantAwareThrottlerGuard`,
`@RequireScopes("PAYMENTS_DISBURSE")`, `StrictPaymentThrottle` (10/min,
per-tenant). `tenantId` comes from `request.tenantId` — never the body, so a
caller cannot name the account a payout is drawn from.

**`PAYMENTS_DISBURSE` is not `PAYMENTS_INITIATE`.** Every key already issued
carries `PAYMENTS_INITIATE` (it is in the set auto-provisioned on tenant
activation), so reusing it would have granted every existing key the ability
to drain its tenant's balance. It is also excluded from that default set:
collecting is the common case, disbursing is opt-in per key.

### `POST /v1/dashboard/payments/b2c` — dashboard-initiated

Guard chain: `AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard`,
**`@Roles("TENANT_ADMIN")`**, `StrictPaymentThrottle`. Same body and service as
the API-key route above; `tenantId` comes from `user.tenantId`. Returns 403 if
the caller's account has no tenant yet.

**Narrower than the STK dashboard route on purpose.**
`/v1/dashboard/payments/stk-push` allows `TENANT_ADMIN` *and* `TENANT_STAFF`,
because taking a payment in is routine work. Sending money out drains the
tenant's own balance, so `TENANT_STAFF` is excluded — the two routes are not
symmetrical and shouldn't be made so for tidiness.

The audit entry records the real actor either way: `actorType: "user"` with the
user's id from the dashboard, `actorType: "api_key"` with the key id from an
integration. Neither degrades to `"system"`.

#### Request body — `InitiateB2cDto`

```ts
{
  msisdn: string;            // ^254(7|1)\d{8}$ — the PAYEE here, not the payer
  amountMinorUnits: number;  // positive integer, max 25,000,000 (KES 250,000)
                             // NOTE: not the same ceiling as STK push — verify against
                             // current Daraja docs for the specific shortcode
  remarks: string;           // 1–100 chars — Daraja "Remarks"
  occasion?: string;         // ≤100 chars — Daraja "Occasion"
  commandId?: "BusinessPayment" | "SalaryPayment" | "PromotionPayment"; // default BusinessPayment
  metadata?: Record<string, unknown>;
}
```

Returns `{ transactionId, status: "PROCESSING" }`. **`PROCESSING` means
Safaricom accepted the request into its queue, not that money moved** — only
the result callback can settle a payout.

Failure modes worth handling in an integration:

| Status | Meaning |
|---|---|
| 422 | Insufficient balance. The message carries both the requested and available amounts. |
| 403 | Tenant suspended, or payout credentials (`initiatorName` / `securityCredential`) not configured — a distinct message from the collection-credentials one, since a tenant may have been collecting for months. |
| 502 | Daraja rejected the request. The reservation is released automatically before this returns. |

Before calling Daraja the service reserves the funds in one transaction: a
`FOR UPDATE` lock on the tenant row, a balance check summed from
`LedgerEntry`, the transaction row, and a `tenant_balance` debit. See
`docs/decisions.md` entry 15.

## Tenant webhook config — `POST /v1/tenants/webhook-config`

Guard chain: `ApiKeyGuard, TenantAwareThrottlerGuard`, `@RequireScopes("WEBHOOKS_MANAGE")`,
`StrictPaymentThrottle`. API-key-authenticated (merchant-to-platform), like
`/v1/payments/stk-push` — not a dashboard route, since registering where
settlement notifications go is an integration concern, not something a human
fills into a form.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/v1/tenants/webhook-config` | `{ webhookUrl: string }` (must be `https://`) | Generates a fresh `whsec_<64 hex>` secret server-side (never client-supplied), encrypts it at rest (same AES-256-GCM pattern as Daraja credentials), stores it + the URL on `Tenant`. Returns `{ webhookUrl, webhookSecret }` — the raw secret is shown **exactly once**, same principle as API key issuance. Re-calling this route rotates both the URL and the secret. Audit-logged as `tenant.webhook_configured` with `actorType: "api_key"`. |

### Outbound delivery — settlement/failure notifications

Once configured, every `Transaction` that transitions to `SETTLED` or `FAILED`
via `TransactionStateMachine` (STK-push-initiated only — not C2B/Paybill-Till,
see the method's own doc comment) enqueues a `TenantWebhookDelivery` row in
the same DB transaction as the transition itself. `TenantWebhookPollerService`
(Postgres-table polling, same architecture as `WebhookPollerService` — see
`docs/decisions.md`) delivers it:

```json
POST <tenant's webhookUrl>
X-ScriptPay-Signature: sha256=<hex HMAC-SHA256 of the raw body, keyed by webhookSecret>
Content-Type: application/json

{
  "transactionId": "uuid",
  "status": "SETTLED" | "FAILED",
  "direction": "INBOUND" | "OUTBOUND",
  "channel": "STK_PUSH" | "PAYBILL" | "TILL" | "B2C",
  "mpesaReceiptNumber": "string | null",
  "amountMinorUnits": 1234500,
  "metadata": { "...": "echoed back from the original initiation call" },
  "occurredAt": "ISO-8601"
}
```

`direction` and `channel` were added when payouts landed, and are additive —
an existing consumer that ignores them is unaffected. They matter because
**B2C payouts now enqueue deliveries through this same channel**: without
them a tenant's endpoint sees `"status": "SETTLED", "amountMinorUnits": 50000`
and cannot tell money arriving from money leaving. Any consumer that treats
a `SETTLED` delivery as "a customer paid us" should now check
`direction === "INBOUND"` explicitly.

Retries on a non-2xx response or network error/timeout with backoff (30s, 2m,
10m, 30m, 1h), up to 5 attempts, then marks the delivery `FAILED` (terminal)
and fires a critical alert via `AlertsService`. A tenant with no `webhookUrl`
configured never gets a delivery row queued in the first place — this is
opt-in, not a default for every tenant.

## Transactions — `/v1/transactions`

Guard chain: `AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard`, `ReadThrottle`
(120/min). Dashboard-facing reads only.

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/v1/transactions` | `status?`, `tenantId?`, `direction?` | `direction` is `INBOUND` (collections) or `OUTBOUND` (payouts); omitted returns both, since they share one table. A UI built for collections should pass `direction=INBOUND` explicitly or it will start listing payouts alongside them. Non-`SUPER_ADMIN` callers are always scoped to their own tenant regardless of `tenantId`. `SUPER_ADMIN` **must** pass `?tenantId=` explicitly — there is no cross-tenant default list, to avoid an accidental full-table scan becoming the norm for platform staff. Returns up to 100 rows, newest first. |
| GET | `/v1/transactions/:id` | — | Backs the payment-status page the frontend polls at a short interval while a transaction is `PENDING`/`PROCESSING`. 404 if not found; 403 if it belongs to a different tenant than the caller's (a tenant can't poll another tenant's transaction by guessing its UUID). |

## Reporting — `/v1/reporting/summary`

Guard chain: `AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard`, `ReadThrottle`.

| Method | Path | Query | Notes |
|---|---|---|---|
| GET | `/v1/reporting/summary` | `tenantId?` (required if `SUPER_ADMIN`), `days?` (default 7) | Success rate, per-status counts, drift count over the window. |

The top-level `totalCount` / `successRate` / `byStatus` /
`settledAmountMinorUnits` / `reconciliationDriftCount` fields cover
**collections only**, keeping both the shape and the meaning they had before
payouts existed. Payouts are reported separately under `payouts`, with the
same fields plus its own `reconciliationDriftCount`. Blending the two would
have made a run of failed payouts drag down the collection success rate — one
number describing two unrelated things, and therefore neither.
`payouts.successRate` is `null`, not `0`, when the tenant has made no payouts.

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
| POST | `/v1/webhooks/daraja/b2c-result` | Payout outcome (Daraja `ResultURL`). Here a `ResultCode` of 0 **does** mean the money moved, unlike the sync response to the payment request. Correlates on `Result.OriginatorConversationID`. |
| POST | `/v1/webhooks/daraja/b2c-timeout` | Payout queue timeout (Daraja `QueueTimeOutURL`). **Not a failure notice** — see below. |

The timeout route deliberately performs **no state transition and releases no
reservation**. A queue timeout means Safaricom could not process the request
in its window, not that the money stayed put; the result callback may still
arrive afterwards reporting success. Failing the payout here would return the
reserved funds to the tenant's spendable balance while the payout is
potentially still in flight, letting the same shillings go out twice. The
payout stays `PROCESSING` with its reservation held, an audit entry is
written (`daraja.b2c_timeout`) and a `critical` alert is raised for a human.
`DriftDetectorService` is what escalates it if no result ever arrives.

Note the three payload shapes are mutually incompatible: STK is wrapped in
`Body.stkCallback` with `CallbackMetadata.Item[]` (`Name`/`Value`), C2B is
flat, and B2C is wrapped in `Result` with `ResultParameters.ResultParameter[]`
(`Key`/`Value`). Reading the wrong accessor yields `undefined`, not an error.

Both routes only *ingest* (write a `WebhookEvent` row) — actual processing
happens asynchronously via `WebhookPollerService`; see `docs/architecture.md`.

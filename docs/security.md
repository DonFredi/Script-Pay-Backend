# Security

This documents what the codebase actually does, not a compliance program — there is no PCI DSS/SOC 2 scope here (ScriptPay never touches card data; M-Pesa is a bank-mediated mobile money rail, not a card network) and no 2FA/TOTP implementation exists. If those become real requirements, this doc should be rewritten against the actual implementation at that time, not aspirationally in advance of it.

## Password & credential storage

- **User passwords**: argon2id (`passwordHash` on `User`). This backend owns password verification directly — an earlier Firebase-based auth flow has been fully removed.
- **API keys**: argon2, only the hash is stored (`ApiKey.keyHash`). `ApiKeyGuard` narrows candidates by `keyPrefix` (indexed, cheap) before running the expensive argon2 verify, to avoid a full-table hash comparison on every request.
- **Refresh tokens / email-verification / password-reset tokens**: SHA-256, not argon2 — these are high-entropy random tokens, not low-entropy passwords, so a fast hash is correct and sufficient; slow hashing here would only waste CPU with no security benefit.
- **Daraja credentials** (`Tenant.mpesaConsumerSecretEncrypted`, `mpesaPasskeyEncrypted`): AES-256-GCM, reversible by design (`CredentialsEncryptionService`) — these must be decrypted to actually call Safaricom, unlike passwords/keys which only ever need to be *verified*. `CREDENTIALS_ENCRYPTION_KEY` is a 32-byte base64 key, validated at boot by the env schema.

## Session model

- Access token: short-lived JWT (`jose`, ~15 min), verified on every request by `AccessTokenGuard`. Set as an httpOnly cookie and also returned in the login/signup JSON body for the frontend to hold in memory.
- Refresh token: long-lived, httpOnly cookie, path-scoped to `/auth/refresh`. Stored server-side only as a SHA-256 hash, with rotation — using a token revokes it and issues a replacement; a revoked token presented again is treated as a theft signal.
- `POST /profile/logout` clears the `access_token` cookie.

## CSRF

Double-submit cookie pattern (`CsrfGuard`): a non-httpOnly `csrf-token` cookie is set on login/signup; state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) must echo it back in an `X-CSRF-Token` header, and the guard compares the two. Applied to every cookie-authenticated mutating route (auth flows, tenant management, API key create/revoke, dashboard STK push) — not applied to the Daraja webhook endpoints, which aren't browser-originated and can't carry the cookie/header pair at all.

## Multi-tenant isolation

Two independent layers, not one:
1. **Application-level**: every query is filtered by `tenantId`, resolved from the authenticated caller (JWT claim or API key), never from a client-supplied body field.
2. **Database-level**: Postgres Row-Level Security (`prisma/manual-sql/001_row_level_security.sql`), applied per tenant-scoped table via `current_setting('app.current_tenant_id')`. This is defense-in-depth — a service that forgets to filter by tenant is still blocked at the database layer.

## Rate limiting

`@nestjs/throttler`, per-controller (not global — throttling needs `request.tenantId`/`request.user`, which only exist after the auth guard has run; a global throttler would run first and see neither). `TenantAwareThrottlerGuard` keys by tenant, not IP, so tenants behind the same NAT gateway don't throttle each other. Named tiers in `common/throttle-tiers.ts`:
- `StrictPaymentThrottle` — 10/min (STK push initiation: real-world cost per call, an actual SMS/prompt sent to a phone)
- `ReadThrottle` — 120/min
- `WebhookThrottle` — 300/min (the Daraja webhook has no credential to check, so a generous ceiling is its only defense against being discovered and hammered)

## Guard ordering — a real, previously-shipped bug

`RolesGuard` must run **after** the auth guard that populates `request.user`/`request.tenantId` (`AccessTokenGuard` or `ApiKeyGuard`). It is deliberately *not* registered as a global `APP_GUARD`: NestJS runs global guards before controller-level `@UseGuards()`, so a global `RolesGuard` would always see an empty `request.user` and reject every `@Roles()`-protected route regardless of actual role. This previously shipped as a live bug (every role-gated route silently rejecting valid users) and is now fixed by applying `RolesGuard` explicitly, per-controller, listed after the auth guard.

## Idempotency as a security property

Every inbound Daraja webhook is written to `WebhookEvent` (unique on `(source, naturalKey)`) **before** any business logic runs. A duplicate or replayed callback fails the insert, not the settlement logic — this matters for a payments system specifically because double-processing a settlement would double-credit a ledger.

## Error reporting

Global `HttpExceptionFilter` reports every 5xx to Sentry. 4xx is treated as expected client traffic, not an incident, and is not reported — this keeps Sentry's signal-to-noise ratio meaningful (a wrong password isn't an incident; an unhandled exception is).

## Boot-time validation

Every environment variable the app depends on is declared and validated with Zod (`src/config/env.schema.ts`), including shape checks like "this must decode to exactly 32 bytes" for the encryption key. A missing or malformed value fails startup in CI/deploy instead of surfacing as a runtime failure in production later.

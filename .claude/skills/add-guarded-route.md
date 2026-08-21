---
name: add-guarded-route
description: Use when adding a new NestJS route to this repo — walks through picking the correct guard chain, order, throttle tier, and validation pattern so it matches every existing controller instead of silently breaking RolesGuard/TenantAwareThrottlerGuard.
---

# Adding a new route in ScriptPay Backend

This repo has one rule that has broken production before: guard order.
Follow this checklist for every new route instead of copying a controller
you're not sure is a good template.

## 1. Who calls this route?

Pick exactly one — never combine them on the same route:

- **A logged-in dashboard user** (via the Next.js frontend, cookie session)
  → `AccessTokenGuard`.
- **A tenant's own backend/integration** (via `x-api-key`) →
  `ApiKeyGuard`.

If you're not sure, check who calls the equivalent existing endpoint — e.g.
`v1/payments/stk-push` (tenant) vs `v1/dashboard/payments/stk-push`
(dashboard) are deliberately separate controllers for exactly this reason.

## 2. Build the guard array in the correct order

`RolesGuard` and `TenantAwareThrottlerGuard` both depend on state an auth
guard sets (`request.user` / `request.tenantId`). They must run *after* the
auth guard, in the same `@UseGuards([...])` array — never as a global
`APP_GUARD` (see `app.module.ts`'s comment and `docs/decisions.md` entry 6
for why that's actively wrong, not just unconventional).

**Dashboard route, typical order:**
```ts
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
```
Drop `CsrfGuard` only for routes that don't mutate state (GET reads) or that
run before a session exists (signup/login/refresh). Drop `RolesGuard` only
if every authenticated role may call it (then enforce anything finer, like
"only your own tenant," inside the service — see `tenants.controller.ts`'s
`findOne` for the pattern).

**Tenant-integration route, typical order:**
```ts
@UseGuards(ApiKeyGuard, TenantAwareThrottlerGuard)
```
Add `@RequireScopes(...)` from `api-key-scopes.decorator` if the action
should be limited to specific `ApiKeyScope` values.

## 3. Pick a throttle tier

From `src/common/throttle-tiers.ts` — don't invent a new one without a
reason:

- `StrictPaymentThrottle` (10/min) — anything with real-world cost or
  sensitivity: payment initiation, signup/login, key issuance, password
  reset.
- `ReadThrottle` (120/min) — ordinary authenticated reads.
- `WebhookThrottle` (300/min) — inbound Safaricom callbacks only.

## 4. Validate the body with a zod schema, not manual checks

Define the schema next to the DTO type in the module (see
`initiate-stk-push.dto.ts` or `tenant.dto.ts` for the pattern:
`export const xSchema = z.object({...}); export type XDto = z.infer<typeof xSchema>;`),
then apply it in the controller:
```ts
@Body(new ZodValidationPipe(xSchema)) dto: XDto
```
Never trust a body field for identity/tenant scoping that a guard already
established — e.g. `tenantId` always comes from `request.tenantId` /
`user.tenantId`, never from the request body (see
`dashboard-stk-push.controller.ts`'s comment on exactly this).

## 5. Record sensitive actions in the audit log

If the route creates, mutates, or revokes something a human should be able
to trace later (tenant status, API keys, credentials, payments), call
`AuditLogService.record({...})` with an `action` in `"resource.verb"` form
(e.g. `"tenant.created"`, `"api_key.revoked"`) — match the existing action
names in `prisma/schema.prisma`'s `AuditLog` comment and
`webhook-poller.service.ts` before inventing a new naming style.

## 6. Update the docs

Add the route to the table in `docs/api.md` and, if it introduces a new
guard/throttle/validation pattern worth remembering, a line in
`docs/architecture.md` or a new entry in `docs/decisions.md` if you rejected
an alternative approach along the way.

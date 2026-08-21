# Architecture Decision Log — ScriptPay Backend

Each entry: the problem being solved, the choice made, and why the rejected
alternative(s) didn't fit. Ordered roughly by when the decision shows up in
the system's evolution (early foundational choices first), not strictly by
date. Verified against source comments and code as of 2026-08-21 — this file
replaces the deleted `docs/decisions.md`, which described a different,
partly-fictional decision set.

## 1. Self-issued JWT (`jose`, HS256) instead of Firebase Auth

**Problem**: The frontend's route protection needs to verify a session token
in Next.js Edge middleware, at page-load time, before any React code runs.
The project's earlier approach used Firebase for authentication.

**Rejected**: Firebase Admin SDK verification. Firebase's server-side session
verification cannot run in the Edge runtime at all — it depends on Node-only
APIs. That forced all real route protection into `"use client"` components,
which only run after JS loads and React renders — meaning a Server
Component's data-fetching on a "protected" page would already have executed
on the server before any client-side redirect could stop it. A real
authorization gap, not just a UX rough edge.

**Chosen**: The backend signs its own JWT with `jose` (`TokenService`,
HS256), and the frontend's `middleware.ts` verifies that exact token with the
same library and the same shared secret (`JWT_ACCESS_SECRET`, byte-for-byte
identical in both repos' env). `jose` works identically on Node and Edge, so
real stateless signature verification can run in Edge middleware. Firebase
was fully removed — some inline comments in older files still say
"Firebase-verified user"; that wording is stale, the guard itself
(`AccessTokenGuard`) is correct.

## 2. Postgres-table polling instead of Redis/BullMQ for webhook processing

**Problem**: Inbound Daraja webhooks must be processed reliably, with retry
on failure, without losing an event if the process crashes mid-processing.

**Rejected**: An earlier `WebhookProcessor` used BullMQ backed by Redis.
Removed — see `webhook-poller.service.ts`'s comment on the class. This added
an entire extra infrastructure dependency (Redis: provisioning, monitoring,
another failure mode) for the actual throughput this system sees.

**Chosen**: `WebhookIngestService` already writes every inbound event to
Postgres immediately with `processedAt: null` — that row *is* the queue.
`WebhookPollerService` polls for unprocessed rows every 10 seconds
(`@Cron(EVERY_10_SECONDS)`) and processes them directly. Trade-off accepted
on purpose: a small polling delay (up to ~10s) instead of near-instant
processing, in exchange for one less moving system. Explicitly flagged in
code as revisit-if-throughput-ever-becomes-a-real-bottleneck, not a
permanent architectural bet.

## 3. Insert-before-process idempotency instead of a separate dedup check

**Problem**: Safaricom retries webhook delivery aggressively. The same
callback can arrive multiple times and must not be processed twice (e.g.
double-crediting a tenant's ledger).

**Rejected**: Checking "have I seen this natural key before?" as a read
before deciding whether to process — this has a race window between the
check and the insert under concurrent delivery, and requires application
code to get the check right every time.

**Chosen**: `WebhookEvent` has `@@unique([source, naturalKey])` in the
schema. `WebhookIngestService.ingest()` always attempts the insert first; a
duplicate delivery fails the insert itself (Postgres error `P2002`), which is
caught and treated as an expected, successful no-op. The database constraint
is the idempotency guard, not application logic — it can't be accidentally
bypassed by a new code path that forgets to check.

## 4. Active reconciliation (drift detection) in addition to passive webhooks

**Problem**: Webhooks can simply never arrive — network blips, or this
service being mid-deploy when Safaricom calls back — leaving a transaction
stuck in `PROCESSING` indefinitely with no automatic path to resolution.

**Rejected**: Waiting indefinitely for the callback, possibly with manual
ops intervention to query Safaricom by hand when a merchant complains. This
was reportedly the actual pain point that motivated this project.

**Chosen**: `DriftDetectorService` runs every 5 minutes, finds transactions
`PROCESSING` for more than 15 minutes, and actively queries Daraja's STK Push
Query API for each one — turning reconciliation into "hope the callback
arrives" into an active, provable process. Critically, it resolves the result
through the *exact same* `TransactionStateMachine.transitionToSettled` /
`transitionToFailed` methods the passive webhook path uses, rather than
duplicating state-transition logic — so there is never a second, subtly
different definition of "settled."

## 5. Settlement gated on `resultCode === 0`, not on receipt-number presence

**Problem**: `transitionToSettled` needs a single, consistent rule for "this
transaction is settled," but it's called from two different Safaricom
responses with different shapes: the async callback's `CallbackMetadata`
(which includes `MpesaReceiptNumber`) and the STK Push Query API's response
used by drift detection (which never includes a receipt number).

**Rejected**: Requiring `mpesaReceiptNumber` to be present before marking a
transaction `SETTLED`. This was tried and made the drift-detection settlement
branch permanently unreachable, since that API response can never supply it.

**Chosen**: `resultCode === 0` is Safaricom's own authoritative success
signal for both APIs. `transitionToSettled` accepts an optional
`mpesaReceiptNumber` and backfills it later if the real callback eventually
arrives after drift detection already settled the transaction (handled as an
explicit `SETTLED → SETTLED` backfill case, not treated as an illegal
transition).

## 6. Global `RolesGuard`/`TenantAwareThrottlerGuard` rejected in favor of per-controller ordering

**Problem**: `@Roles()`-protected routes need to check `request.user.role`,
and tenant-aware throttling needs `request.tenantId` — both are only
populated by an auth guard (`AccessTokenGuard` or `ApiKeyGuard`) that runs
earlier in the chain.

**Rejected**: Registering `RolesGuard` (and `TenantAwareThrottlerGuard`) as
global guards via `APP_GUARD` in `AppModule` — the natural-looking way to
apply a guard everywhere. NestJS runs global (`APP_GUARD`) guards *before*
controller-level `@UseGuards()` guards, so a global `RolesGuard` would always
see an empty `request.user` and reject every `@Roles()`-protected route
regardless of actual role. This has silently broken every `@Roles()` check in
production once already.

**Chosen**: Both guards are applied explicitly, per-controller, *after*
`AccessTokenGuard`/`ApiKeyGuard` in each controller's `@UseGuards([...])`
array. The reasoning is documented directly in `app.module.ts` next to where
the temptation to "just make it global" would otherwise recur.

## 7. SHA-256 for refresh tokens, argon2id for passwords and API keys

**Problem**: Three different secrets need hashing before storage
(`RefreshToken.tokenHash`, `User.passwordHash`, `ApiKey.keyHash`), and it
would be simplest to use one algorithm for all three.

**Rejected**: argon2 (or bcrypt) for refresh tokens, "for consistency."
Slow, memory-hard hashing exists to make brute-forcing a *low-entropy*,
human-chosen secret (a password) computationally expensive. A refresh token
is a 256-bit random value generated by the server — brute-forcing it is
already infeasible regardless of hash speed, so a slow hash on every refresh
request would only burn CPU for zero additional security.

**Chosen**: Passwords and API keys (both effectively "things a human or
external system might choose or leak in a guessable way") use argon2id.
Refresh tokens use SHA-256 — fast is the *correct* tool for a high-entropy
random value, not a shortcut taken under time pressure.

## 8. Reversible AES-256-GCM for tenant Daraja credentials, not hashing

**Problem**: Tenant `mpesaConsumerSecret`/`mpesaPasskey` must be protected at
rest (a stolen DB backup shouldn't hand out usable Daraja credentials), but
unlike a password, the backend must be able to recover the *real* plaintext
value to actually call Safaricom on the tenant's behalf.

**Rejected**: Hashing (the same principle used for passwords/API keys) —
fundamentally can't work here, since hashing is one-way and the backend needs
the original secret back.

**Chosen**: AES-256-GCM (`CredentialsEncryptionService`), a symmetric,
reversible cipher, keyed by `CREDENTIALS_ENCRYPTION_KEY` (a 32-byte
base64-encoded key, `openssl rand -base64 32`). `mpesaConsumerKey` itself is
stored in plaintext, deliberately not encrypted — Safaricom's own docs treat
the Consumer Key like a client ID, not a secret, so encrypting it would add
overhead without a real security benefit.

## 9. Integer minor units for money, never float or JS-number Decimal

**Problem**: Payment amounts must never lose precision through arithmetic —
a fraction-of-a-cent rounding error compounding across thousands of
transactions is a real financial and reconciliation problem, not a cosmetic
one.

**Rejected**: Storing amounts as a float, or as a `Decimal`-typed column read
into a plain JS `number` (which reintroduces float precision loss the moment
it's read out of the database and used in arithmetic).

**Chosen**: `Transaction.amountMinorUnits` and every `LedgerEntry` amount are
plain integers (KES cents). All arithmetic — ledger credits/debits, C2B
amount parsing (`Math.round(Number(amount) * 100)`) — operates on integers
throughout.

## 10. Postgres RLS as defense-in-depth, applied via manual SQL, not Prisma migrations

**Problem**: Tenant data isolation needs more than one layer — a single
missed `where: { tenantId }` in a Prisma query anywhere in the codebase
should not be enough to leak cross-tenant data.

**Rejected**: Relying solely on application-level `tenantId` filtering in
every query. Correct in principle, but a single missed filter in a large,
evolving codebase is exactly the kind of mistake defense-in-depth exists for.

**Chosen**: Every tenant-scoped table also carries a Postgres Row-Level
Security policy (`prisma/manual-sql/001_row_level_security.sql`), applied by
running the SQL file directly against the database — not through
`prisma migrate`, since Prisma doesn't manage RLS policies. This is
deliberately a manual, separate step in the setup instructions rather than
something migrations silently handle, so it's never accidentally skipped
without the operator noticing they skipped a step.

## 11. Double-entry ledger instead of a mutable tenant-balance counter

**Problem**: "What is this tenant's balance?" needs to be an answer that can
be audited and never silently drifts from the sum of real settled
transactions.

**Rejected**: A single mutable `balance` column on `Tenant`, incremented and
decremented as transactions settle/reverse. Simple, but a balance that can be
directly written by application code (or a bug, or a manual DB fix) has no
built-in way to prove it's still correct.

**Chosen**: `LedgerEntry` records balanced credit/debit pairs
(`tenant_balance` / `pending_settlement`) for every settlement, created in
the same database transaction as the status change. A tenant's balance is a
*computed* value (sum of ledger entries), not a hot mutable counter — the
audit trail and the balance are the same data, not two things that can
diverge.

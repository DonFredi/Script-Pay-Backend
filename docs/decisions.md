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

## 12. Outbound tenant-webhook delivery: Postgres polling, enqueued in-transaction, not a raw fetch inline

**Problem**: A tenant integration (scripttagg-leadgen was the first real
consumer) has no way to learn a `POST /v1/payments/stk-push` result — status
reads require a dashboard session (`AccessTokenGuard`), not an API key, and
no outbound notification mechanism existed at all. `WEBHOOKS_MANAGE` and
`PAYMENTS_READ` were reserved in `ApiKeyScope` from the start but never wired
to anything.

**Rejected**: (a) Wiring up `PAYMENTS_READ` for `GET /v1/transactions` and
telling tenants to poll it — works, but pushes an ongoing polling burden onto
every tenant integration for something ScriptPay already knows the instant it
happens. (b) Calling `fetch()` to the tenant's `webhookUrl` synchronously,
inline inside `TransactionStateMachine.transitionToSettled`/`transitionToFailed`
— couples a DB transaction's commit to a third-party HTTP round-trip's
latency/availability, and a slow or hung tenant server would then stall the
same code path that's also updating the ledger.

**Chosen**: The same shape as inbound Daraja processing, mirrored outward.
`TransactionStateMachine` enqueues a `TenantWebhookDelivery` row (`PENDING`)
in the *same* DB transaction as the settle/fail it's reporting — so a
delivery is never missed for a transition that actually committed, and never
double-enqueued for an idempotent duplicate (only the branch that actually
just transitioned enqueues, not the early-return dedup branches). A separate
`TenantWebhookPollerService` (same Postgres-table-polling architecture as
entry 2's `WebhookPollerService`, applied to the opposite direction) then
delivers it out-of-band with its own retry/backoff (30s/2m/10m/30m/1h, 5
attempts), signed the same way Daraja itself would be trusted
(`X-ScriptPay-Signature`, HMAC-SHA256, keyed by a per-tenant secret that's
AES-256-GCM-encrypted at rest — entry 8's mechanism, reused). Webhook
registration (`POST /v1/tenants/webhook-config`) is `ApiKeyGuard`-gated, not
a dashboard route, on the same reasoning as `/v1/payments/stk-push`: this is
a tenant's own backend registering itself, not a human filling in a form.
Deliberately scoped to STK-push-initiated settle/fail only, not
`recordInboundSettlement` (C2B/Paybill-Till) — no tenant integration asked
for that path yet, and guessing at the shape it'd need wasn't worth doing
speculatively.

## 13. Platform-staff-issued API keys made symmetric with existing oversight, not left create-only-by-tenant

**Problem**: `SUPER_ADMIN` (platform staff) could already `list`/`revoke` any
tenant's API keys via an explicit `?tenantId=` (audit-on-demand, no ambient
cross-tenant access) — but `create()` unconditionally rejected any caller
with `tenantId: null`, which is always true for `SUPER_ADMIN`. There was no
way for platform staff to provision a key on a tenant's behalf at all, even
though they already had every other administrative lever over that tenant's
keys.

**Rejected**: Leaving it as-is on the theory that "self-service only" is a
deliberate security boundary. It wasn't reasoned that way originally — it was
simply never extended past the tenant-self-service case `ApiKeysController`
was first built for — and it left `create` as the one operation out of three
that didn't follow the `resolveTenantId()` pattern already governing
`list`/`revoke`.

**Chosen**: `create()` now calls the same `resolveTenantId(user, tenantId)`
helper as `list`/`revoke` — a `TENANT_ADMIN` is still always scoped to their
own tenant regardless of any `?tenantId=` they pass, and `SUPER_ADMIN` must
now pass `?tenantId=` explicitly to issue a key on a tenant's behalf (a
`BadRequestException` if they don't, same as the other two routes). This is
oversight/onboarding-provisioning, not a parallel self-service channel: the
primary path for a tenant obtaining a key is still their own `TENANT_ADMIN`
calling `POST /v1/api-keys` for themselves. Both paths creating independent,
freely-coexisting key rows was already the intended multi-key model (a
tenant is expected to hold several keys, one per integration/scope — see
`ApiKeyGuard`'s own doc comment) — nothing here introduces a write conflict,
since no call ever mutates an existing key row, only inserts a new one; the
audit log (`api_key.created`, `actorId` = the issuing user) is what
distinguishes who issued which key, same as before this change.

## 14. API keys auto-provisioned on tenant activation, not left as a required self-service step

**Problem**: `POST /v1/api-keys` was built assuming every tenant is a
developer-run integration that wants to think about scopes and key
management. In practice most tenants using ScriptPay only care about
accepting payments — they never asked for the concept of "API keys," they
just want their integration to work. Requiring a self-service visit to an
API-keys page before a tenant could call `POST /v1/payments/stk-push` was
friction with no corresponding benefit for that majority case.

**Rejected**: (a) Removing the self-service endpoints entirely — too
restrictive for the minority of tenants who *do* run their own integration
and want a second scoped key later (e.g. a read-only reporting key), or who
need to rotate one. (b) Requiring platform staff to manually create and
relay a key over some ad hoc channel for every new tenant — works, but is a
manual step that doesn't scale and is exactly the kind of thing a system
should do for itself the instant the real trigger (activation) occurs.

**Chosen**: `TenantsService.updateStatus` auto-provisions a default-scoped
key (`PAYMENTS_INITIATE`, `PAYMENTS_READ`, `WEBHOOKS_MANAGE`) via
`ApiKeysService.provisionDefaultKeyIfNeeded` the moment a tenant transitions
into `"active"` — the same real-world moment that already means "this
tenant is now allowed to move real money." Idempotent (skips if the tenant
already holds a live key, e.g. re-activating after a suspension), so it
never fires twice for the same tenant. The raw key is emailed once to every
`TENANT_ADMIN` on the account (`EmailService.sendApiKeyProvisionedEmail`,
reusing the existing Resend integration) and never shown again after that —
same "shown exactly once" discipline as self-service issuance. Audit-logged
as `actorType: "system"`, distinguishing it from a human-triggered
`api_key.created` entry. This makes `/v1/api-keys` an optional advanced
capability rather than a required step in onboarding — the frontend's
API-keys page (`Script Pay Frontend`, a separate repo) can be hidden or
removed for the common case without anything in this backend needing to
change; it remains available for the tenants who actually want it. A
provisioning failure (email or key creation) is caught and logged, never
allowed to fail the status-change request itself — same "a side effect's
failure isn't the main action's failure" reasoning already used by
`AlertsService`.

## 15. Payout authorization: computed balance behind a tenant-row lock, not a stored balance or an unlocked read

**Problem**: Entry 11 established that a tenant's balance is a *computed*
value summed from `LedgerEntry`, never a mutable counter. Nothing ever
computed it — `TransactionStateMachine` wrote balanced credit/debit pairs
and no code path read them back, which stayed harmless only because every
write so far *credits* the balance. Outbound payments (Daraja B2C) end
that: a payout must be refused when it exceeds available funds, and "read
the balance, then spend against it" is a race by default. Two concurrent
payout requests reading the same KES 1,000 balance will both authorize
KES 600 and both send. The window is milliseconds; the loss is real money.

**Rejected**: (a) A materialized `balanceMinorUnits` column on `Tenant`,
updated on every settlement — reintroduces precisely the mutable counter
entry 11 rejected, now with a correctness stake (authorizing a spend)
rather than only a reporting one. (b) Reading the balance without a lock,
inside the transaction or outside it — the check reads as correct in
review and prevents nothing, since both racers still see the pre-spend
balance. (c) `isolationLevel: "Serializable"` on the reservation
transaction — genuinely correct, but it makes serialization failures
(Postgres `40001`) a normal outcome the caller must retry, and no retry
discipline exists anywhere else in this codebase; one call site isn't
reason enough to introduce one. (d) Locking the `ledger_entries` rows
themselves — the balance is an aggregate, and the rows a concurrent
payout is about to insert cannot be locked before they exist, which is
exactly what's being raced on.

**Chosen**: `LedgerService.assertSufficientBalance` takes a row-level lock
on the *tenant* row (`SELECT id FROM tenants WHERE id = $1 FOR UPDATE`)
and only then sums the ledger. The tenant row is the common object two
concurrent payouts can queue on — a stand-in for an aggregate that has no
single row of its own to lock. Reservations debit `tenant_balance`
directly rather than only writing to `payout_reserved`, so in-flight
payouts are already subtracted from every subsequent read with no
special-casing anywhere.

The lock deliberately guards payout-against-payout only. Collections are
not serialized against it: `transitionToSettled` and
`recordInboundSettlement` only ever *credit* `tenant_balance`, so a
collection landing mid-payout can only make the balance larger, leaving
the check reading a stale, lower figure — the safe direction to be wrong
in. That reasoning holds only while nothing else debits the balance, and
must be revisited if reversals are ever implemented (`SETTLED →
REVERSED` is legal in `ALLOWED_TRANSITIONS`, but no code performs it
today).

`LedgerService` injects no Prisma client of its own; every method takes
the caller's transaction client instead. A balance read on a different
connection than the write it authorizes is only a number that *was* true
a moment ago, so requiring the caller to hand over its own transaction is
what makes check-then-spend atomic. `assertSufficientBalance` further
refuses to run on a client exposing `$transaction`: a `FOR UPDATE` taken
outside a transaction is released the instant its statement finishes,
leaving a check that still looks correct while guaranteeing nothing.
Prisma's interactive-transaction client omits `$transaction` where a
plain `PrismaClient` exposes it; should a future Prisma version stop
omitting it, this throws on a legitimate call — loud, rather than
silently unguarding the spend path.

## 16. Payouts extend `Transaction` rather than getting their own model

**Problem**: B2C payouts are the mirror image of collections — different
API, different callbacks, opposite ledger direction — and modelling them as
a separate `Payout` table looks like the tidier choice.

**Rejected**: A dedicated `Payout` model. `LedgerEntry.transactionId` is a
*required* FK to `Transaction`, and so are `ReconciliationRecord.transactionId`
(also `@unique`) and `TenantWebhookDelivery.transactionId`. A separate model
could not have written a single ledger entry without either making that FK
nullable or growing a parallel `payoutId` on all three — and the ledger is
precisely what proves money moved. The tidier-looking option would have cost
the one thing worth keeping.

**Chosen**: One table, plus a `direction` column (`INBOUND`/`OUTBOUND`)
defaulted to `INBOUND` so the migration is a pure column add with no
backfill. Payouts inherit the ledger, reconciliation and outbound-webhook
machinery unchanged. The costs are real and were paid explicitly rather than
absorbed silently: `msisdn` stops meaning "payer" and becomes the
counterparty; `GET /v1/transactions` gained a `direction` filter, because a
list built for collections would otherwise start showing money going out;
and `ReportingService` now groups by direction, because a run of failed
payouts blended into one success rate would drag down the collection figure
the dashboard shows.

## 17. Tenant security credential stored as Safaricom already encrypted it

**Problem**: B2C authenticates with an `InitiatorName` and a
`SecurityCredential` — the initiator password RSA-encrypted against
Safaricom's public certificate. Something has to perform that encryption.

**Rejected**: Taking the raw initiator password from the tenant and doing
the RSA step ourselves. That means handling the password in plaintext at
some point in the request path, bundling and shipping Safaricom's
certificate, tracking its rotation, and carrying separate sandbox and
production certificates — all to arrive at exactly the string Safaricom's
own Daraja portal already hands the tenant.

**Chosen**: Tenants paste the portal's output. ScriptPay stores it
AES-256-GCM-encrypted at rest (entry 8's mechanism, reused) and passes it
through to Daraja verbatim, never seeing the underlying password and holding
no certificate. `getMpesaCredentialsForPayout` is a separate method from
`getMpesaCredentialsForPayment` for the same reason the credentials are
separate columns: collections need the passkey and no initiator, payouts the
exact reverse, so the payout path never decrypts a secret it has no use for.
Its "payout credentials not configured" error is deliberately worded
differently from the collection one — a tenant who has been collecting for
months would be actively misled by being told their M-Pesa credentials
aren't set up.

## 18. A B2C queue timeout holds the reservation instead of failing the payout

**Problem**: Safaricom posts to `QueueTimeOutURL` when it cannot process a
payout request within its queue window. The obvious handling — mark the
payout failed, return the reserved funds to the tenant's balance — is
wrong.

**Rejected**: Treating the timeout as a failure. A timeout says Safaricom
could not process the request *in time*, not that the money stayed put; the
result callback may still arrive minutes later reporting success. Releasing
the reservation and then having the payout complete lets the same shillings
go out twice. This is the single easiest place in the payout path to lose
real money, and it is the opposite of how the callback's name reads.

**Chosen**: The timeout handler performs no state transition and releases
nothing. The payout stays `PROCESSING` with its funds reserved, an audit
entry is written and a `critical` alert goes to a human. The cost is a
payout that can sit `PROCESSING` indefinitely if no result ever arrives, and
that case belongs to drift detection rather than to a guess made here.

Drift detection for payouts currently escalates rather than self-heals, and
that is a deliberate stopping point, not an oversight. The collection path
can resolve itself because Daraja's STK Push Query API answers
*synchronously*. The Transaction Status API — the payout equivalent — does
not: it accepts the query and posts the answer to a `ResultURL` later, so
auto-recovery needs its own callback route, ingest source, and a stored
correlation between the status query and the payout it asks about. Inventing
Safaricom's correlation semantics on a money-recovery path is exactly the
kind of guess this repo has already paid for once, so
`DriftDetectorService.detectStuckPayouts` alerts a human exactly once per
stuck payout instead. That is strictly better than the behaviour it replaced,
which was to skip payouts silently and forever.

## 19. Tenant removal is a status flag, not a hard delete

**Problem**: There was no admin-facing way to remove a tenant at all —
`PATCH /v1/tenants/:id/status` only accepted `active | suspended | pending_kyc`,
and `suspended` is already self-service (a `TENANT_ADMIN` can toggle their own
tenant into and out of it). A platform-initiated, harder-to-undo "remove this
tenant" action needed a real path.

**Rejected**: A hard `DELETE`. `Tenant` carries required FKs from
`Transaction`, `LedgerEntry`, `ReconciliationRecord`, and
`TenantWebhookDelivery` — cascading a delete through those would destroy
financial and reconciliation history for a business that, by definition, has
already moved real money. `AuditLog` is append-only by convention precisely
because this platform treats its own history as something it cannot casually
erase; a cascading tenant delete would contradict that on the very table
(`Tenant`) everything else keys off. It would also collide with the Postgres
RLS policies in `prisma/manual-sql/001_row_level_security.sql`, which assume
tenant-scoped rows persist rather than disappear out from under a policy
mid-query.

**Chosen**: A fourth `status` value, `"removed"`, reusing the exact
enforcement points `"suspended"` already has —
`getMpesaCredentialsForPayment`/`Payout` block money movement in both
directions for either status, and the inbound C2B path already scopes its
shortcode lookup to `status: "active"`, so a removed tenant is excluded there
for free. Unlike `suspended`, `"removed"` is platform-only in **both**
directions: `TenantsService.updateStatus` forbids a `TENANT_ADMIN` from
setting their own tenant to `removed` and from reinstating one already
`removed` — only `SUPER_ADMIN` can do either. `status` is a plain Postgres
`String` column rather than a DB enum, so adding this required no migration.
Removed tenants stay visible via `GET /v1/tenants`/`GET /v1/tenants/:id`
rather than being hidden, preserving audit visibility and avoiding an admin
unknowingly re-onboarding a duplicate shortcode.

## 20. One default shortcode per (tenant, type), enforced by unsetting the previous one in the same transaction

**Problem**: A tenant can hold multiple `TenantShortcode` rows of the same
`type` (e.g. two `PAYBILL` shortcodes), but
`getMpesaCredentialsForPayment` picks one via `findFirst({ tenantId, type,
isDefault: true })`. Nothing stopped two rows of the same type from both
having `isDefault: true`, which makes that lookup pick whichever `findFirst`
happens to return first — a real payment could start using different
credentials than the merchant intended, silently.

**Rejected**: A unique partial index (`@@unique([tenantId, type], where:
isDefault: true)`-style constraint) enforced at the database level. Prisma
doesn't support partial unique indexes, and a manual SQL constraint would need
its own migration plus an `ON CONFLICT` story in `create`/`update` — more
moving parts than the actual invariant needs, given there are only two write
paths that ever set `isDefault: true`.

**Chosen**: `TenantShortcodesService.create`/`update` unset any existing
`{ tenantId, type, isDefault: true }` row before writing the new default,
inside the same `withTenantContext` transaction as the create/update itself
— so no query can ever observe two defaults of the same type, even
momentarily. `update` additionally excludes the row being updated (`id: {
not: shortcodeId }`) and falls back to the shortcode's existing `type` when
the patch doesn't change it, since "make this one default" is the more common
call than "make this one default and also change its type."

## 21. Daraja responses parsed as text first, not `response.json()` directly

**Problem**: Every `DarajaClient` method assumed a Daraja API response body is
always JSON. A request that never reaches Daraja's own application layer —
blocked by Safaricom's API gateway (rate limiting, a locked initiator, an
outage) — comes back as an HTML fault page instead. `response.json()` throws
a raw `SyntaxError` on that, which bypasses every `BadGatewayException` this
file already raises for a genuine Daraja rejection and reaches
`HttpExceptionFilter` as an unhandled 500 — the caller (and the merchant,
via `transaction.failureReason`) learns nothing about what actually happened,
and it doesn't get logged as a Daraja-specific failure either.

**Chosen**: `parseDarajaJson` reads the response as text first and parses it
itself, logging the raw (truncated) body and raising the same
`BadGatewayException` shape every other rejection in this file already
produces when parsing fails. Applied to every Daraja call
(`getAccessToken`, `initiateStkPush`, `initiateB2c`, C2B URL registration,
STK status query). At the same time, `B2cService`/`StkPushService` now store
the real Daraja rejection message (or this gateway message) as
`transaction.failureReason` instead of a generic `"daraja_initiation_error"`
bucket label — the frontend polls onto that exact field to show the merchant
what went wrong, and the bucket label was never actionable for them.

## 22. `.strict()` added to auth schemas to reject unknown fields, not applied repo-wide

**Problem**: Every `*.schema.ts` file uses plain `z.object({...})`, and Zod 4
does not treat that as strict by default — an unrecognized key in the
request body is silently **stripped** rather than rejected. A request to
`/auth/login` or `/auth/signup` carrying a field the schema doesn't declare
(e.g. `role`, `tenantId`, `isAdmin`) parsed successfully with that field
quietly dropped, instead of failing. No current auth handler spreads the raw
DTO into a Prisma call — each destructures named fields off it — so this
wasn't an active mass-assignment bug, but it's the exact shape of one, and
gave no signal that a client (or an attacker probing the login/signup form)
was sending fields it had no business sending.

**Chosen**: `.strict()` added to all six schemas in `auth.schema.ts`
(`signupSchema`, `loginSchema`, `forgotPasswordSchema`,
`resetPasswordSchema`, `verifyEmailSchema`, `resendVerificationSchema`).
It's chained onto the `z.object()` before `.refine()` on the two
password-confirmation schemas, since `.refine()` returns a `ZodEffects`
that doesn't carry a `.strict()` method itself. An unrecognized field now
fails in `ZodValidationPipe` with the same structured `BadRequestException`
shape as any other validation error, instead of disappearing. Verified
against every frontend auth API call (`login.api.ts`, `register.api.ts`,
`forgot-password.api.ts`, `reset-password.api.ts`, `verify-email.api.ts`,
`resend-verification.api.ts`) before landing this — each sends exactly the
fields its schema declares, so no legitimate request starts failing.

**Not done**: the same treatment was not extended to the other
`*.schema.ts` files (tenants, shortcodes, api-keys, stk-push, b2c) in this
pass. Auth was the immediate priority as the highest-value target for
tampering attempts against unauthenticated endpoints; extending `.strict()`
repo-wide is a deliberate, separately-scoped follow-up, not an oversight.

## 23. Unknown is not failure: STK status queries gained a third outcome

**Problem**: `DarajaClient.queryStkPushStatus` returned
`Number(body.ResultCode ?? -1)`. Safaricom answers a query about a push that is
still in flight with HTTP 500, `errorCode: "500.001.1001"` ("The transaction is
being processed") and **no `ResultCode` field at all** — so every such answer
collapsed to `-1`. `DriftDetectorService.recordDriftAndReconcile` read "not
zero" as "failed" and called `transitionToFailed`.

`FAILED` is terminal in `ALLOWED_TRANSITIONS`, so when the genuine success
callback arrived minutes later, `transitionToSettled` threw *Illegal transaction
state transition: FAILED -> SETTLED*, burned all five webhook retries and gave
up. Net effect: the customer paid, the transaction read `FAILED`, and the tenant
was never credited. The type could not express "we asked and were told nothing",
so the code had nowhere to put that answer except the failure branch.

**Chosen**: `queryStkPushStatus` now returns `StkPushStatusResult`, whose
`resultCode` is `number | null`. `null` means Safaricom gave no verdict — an
absent, empty or unparseable `ResultCode` — and carries the `errorCode` alongside
for logging. `recordDriftAndReconcile` returns early on `null`, leaving the
transaction `PROCESSING` for the next pass and recording no drift, since nothing
has been shown to have drifted.

**Rejected**: making `FAILED -> SETTLED` a legal transition so a late callback
could recover the row. That treats the symptom, keeps the wrong verdict in the
audit trail, and weakens a terminal state that exists precisely so a failed
transaction is retried as a new one rather than mutated.

**Note**: this does not retroactively heal transactions already wrongly marked
`FAILED`. Any such row has to be identified and settled by hand.

## 24. A tenant admin's status self-service is gated on the CURRENT status, not just the target

**Problem**: `PATCH /v1/tenants/:id/status` allows `TENANT_ADMIN`, and
`updateStatus` checked only the *target* status — rejecting `pending_kyc` and
`removed`. Nothing rejected `active`. A self-registered admin (whom
`onboardSelf` creates as `pending_kyc`) could PATCH their own tenant straight to
`active`, which additionally triggers `provisionApiKeyOnActivation` and emails
them a live API key. The method's own doc comment claimed this was "not a path to
self-approve out of KYC review"; it was exactly that path.

The test named *"forbids a TENANT_ADMIN from self-approving out of KYC review"*
asserted the opposite direction — it moved a tenant *into* `pending_kyc` — so the
real escalation was never covered and the suite passed throughout.

**Chosen**: a non-`SUPER_ADMIN` caller must find the tenant in `active` or
`suspended` **and** be moving it to `active` or `suspended`. Gating on
`before.status` as well as `dto.status` is the part that matters: rejecting only
`pending_kyc -> active` would have left `pending_kyc -> suspended -> active`
open, since the second hop starts from a status tenant admins may legitimately
use. Two requests, same escalation.

## 25. `FORCE ROW LEVEL SECURITY` split out of the documented setup step

**Problem**: `001_row_level_security.sql` is named in `README.md` and
`CLAUDE.md` as an ordinary setup command, and it unconditionally ran
`ALTER TABLE ... FORCE ROW LEVEL SECURITY`. FORCE removes the table owner's
exemption from its own policies — but `DATABASE_URL` is still the owner role,
because the `app_runtime` / `app_privileged` cutover has not happened. Running
the documented command would therefore have made every query outside
`withTenantContext` return zero rows: login's user lookup, `ApiKeyGuard`,
`listAll`, both pollers. They return empty rather than raising, so the app comes
back up looking healthy and simply cannot find any users.

The file's header had always warned about this. The executable SQL did not
honour the warning, which made the warning worth nothing.

**Chosen**: `ENABLE` and the policies stay in `001` (safe today, a no-op for the
owner). The nine `FORCE` statements moved to `004_force_row_level_security.sql`,
which states its five prerequisites, is explicitly not a setup step, and carries
a `NO FORCE` rollback. README, CLAUDE.md and `docs/database.md` now say so.

**Also fixed here**: three reads that would have broken silently at that cutover
— `TenantsService.notifyWebhookSecretRotated`,
`TenantsService.provisionApiKeyOnActivation` and
`ApiKeysService.notifyKeyIssued` all queried `users` on the RLS-enforced
connection with no tenant context. Post-FORCE they would return zero admins, and
the one-time API key and webhook secret they exist to deliver would reach nobody
— unrecoverable, since neither value is ever shown twice.

## 26. Amounts are validated as whole shillings, and the Daraja boundary refuses to round

**Problem**: `amountMinorUnits` was validated only as `.int().positive()`, and
both payment services pass `amountMinorUnits / 100` to `DarajaClient`, which
applied `Math.round`. An amount of `150` (KES 1.50) therefore became a real
**KES 2** charge while the transaction row and every ledger entry still said
`150`. On the payout side the tenant was debited KES 1.50 for KES 2 that
genuinely left their shortcode. The books and the money disagreed, silently.

Separately, the STK ceiling read `.max(15_000_00, "... cannot exceed KES
150,000")` — `15_000_00` is KES **15,000**, a tenth of the limit the message
claimed, so every legitimate collection between KES 15,000 and 150,000 was
rejected by an error asserting a limit the code did not enforce. The frontend has
always allowed up to 150,000, so the two repos disagreed. The B2C constant
(`250_000_00`) was written correctly, which is what made the typo easy to miss.

**Chosen**: `.multipleOf(100)` on both payment DTOs, the STK ceiling corrected to
`150_000_00`, and `Math.round` at the Daraja boundary replaced with
`assertWholeShillings`, which throws. Both callers already handle a throw here
correctly — `StkPushService` marks the transaction `FAILED`, `B2cService` also
releases the reservation — so failing loudly costs nothing, and mis-charging
costs real money.

## 28. `rootDir` pinned in tsconfig.build.json — the build emitted to the wrong path

**Problem**: production start died with
`Error: Cannot find module '/opt/render/project/src/dist/main'` on a build that
had just reported success.

`tsconfig.json` sets `outDir: "./dist"` but no `rootDir`, so TypeScript infers
the root as the longest common prefix of its inputs. `tsconfig.build.json`
excluded `node_modules`, `test`, `dist` and specs — but not `scripts/`, which
holds two operator utilities (`promote-to-admin.ts`,
`check-tenant-credentials.ts`). With both `src/` and `scripts/` as inputs, that
prefix was the repo root, so `nest build` emitted `dist/src/main.js` and
`dist/scripts/` — while `package.json`'s `start:prod` runs `node dist/main`.

**Why nothing caught it**: `npm run build` exits 0 either way, so the CI build
step passed; `tsc --noEmit` passed because compiling is fine, only the emit path
moved; and local development runs `nest start --watch`, which never reads `dist`
at all. The failure only exists on a real deploy running the compiled output —
which is exactly the path no check exercised.

**Chosen**: `scripts` added to the build config's `exclude`, and
`rootDir: "./src"` stated explicitly rather than left to inference. The exclude
alone would fix today's symptom; pinning `rootDir` means a future stray `.ts`
file outside `src/` fails the build loudly instead of silently relocating every
emitted path again. `tsconfig.json` is untouched, so `tsc --noEmit` in CI still
typechecks `scripts/`.

**Rejected**: changing `start:prod` to `node dist/src/main`. It would have
worked today and broken the moment `scripts/` was removed or another top-level
source file was added, since the emit path would shift back — encoding an
accident of directory layout into the start command.

## 29. C2B callback URLs get an explicit re-registration route

**Problem**: moving the backend from one domain to another fixed two of the
three Daraja callback types and silently broke the third.

STK Push's `CallBackURL` and B2C's `ResultURL`/`QueueTimeOutURL` are built per
request from `MPESA_CALLBACK_BASE_URL`, so they follow the env var immediately.
C2B's `ConfirmationURL`/`ValidationURL` are different: `registerC2bUrl` sends
them to Safaricom **once**, Safaricom stores them, and it keeps posting there
until told otherwise. Nothing in this codebase told it otherwise —
`registerC2bUrl` was only ever called from `TenantShortcodesService.create`.

The resulting state is nastier than an outright outage: STK pushes work, so the
platform looks healthy, while direct Paybill/Till payments post to a host that
may no longer exist. The only remedy was deleting and recreating the shortcode,
which for a live tenant destroys the row every transaction references.

**Chosen**: `POST /v1/tenant-shortcodes/:id/register-c2b-url`, on the existing
controller and guard chain, re-sending the URLs built from the *current*
`MPESA_CALLBACK_BASE_URL`. POST rather than PATCH because it changes state at
Safaricom, not on the shortcode row — there is no local representation to
modify. Idempotent by nature; re-registering the same URLs is the point.

**The one real design decision**: this does NOT swallow a Daraja failure, where
`create` deliberately does. In `create` the registration is a best-effort side
effect of saving a shortcode, and losing it must not roll the save back — a
tenant would rather have the shortcode saved and retry the registration. Here
registration *is* the operation. Reporting success on a rejection would leave
the caller believing callbacks are fixed when they are still pointed at the old
host, which is precisely the invisible-breakage this route exists to end. The
`BadGatewayException` propagates.

Rejects a `B2C` shortcode with a 400 rather than calling Daraja: it has no C2B
URLs to register, and letting the call through would return a confusing
Safaricom-side error about a shortcode not being enabled for C2B.

**Not done**: automatic re-registration on startup or on an
`MPESA_CALLBACK_BASE_URL` change. That would mean calling Safaricom once per
shortcode on every boot, and a deploy loop would hammer their API with the
tenant's own credentials. Re-registration is rare and deliberate; a route the
operator invokes is the right shape.

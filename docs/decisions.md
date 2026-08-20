# Architectural Decisions

Real decisions made in this codebase, reconstructed from its actual history and the rationale left in code comments — not a generic ADR template. Dates are approximate (from migration/commit context, not exact).

## ADR-001: Own-issued JWT auth, not Firebase

**Status**: Accepted (supersedes an earlier Firebase-based flow, now fully removed)

**Context**: The frontend needs to verify a session at the Next.js Edge middleware layer, before a page even renders, so route protection doesn't depend on client-side JS having loaded. Firebase Admin SDK cannot run on the Edge runtime at all.

**Decision**: The backend verifies identity via Firebase (or, now, its own password check) only once, at `/auth/login`/`/auth/signup`, then mints its own short-lived JWT access token + long-lived refresh token. Every other request — including the frontend's Edge middleware — verifies that JWT directly with `jose`, using a secret shared between both repos.

**Consequence**: `JWT_ACCESS_SECRET` is a genuine shared secret between two separate codebases — it must be kept in sync manually, which is a real coordination cost the alternative (calling the backend from middleware on every request) would have avoided at the cost of added latency on every navigation.

## ADR-002: Postgres-polling webhook processing, not BullMQ/Redis

**Status**: Accepted (replaces an earlier BullMQ/Redis-backed `WebhookProcessor`)

**Context**: Inbound Daraja webhooks need reliable, retried, idempotent processing. The original design used BullMQ against Redis.

**Decision**: `WebhookIngestService` writes every inbound event to the `WebhookEvent` table synchronously, before any processing. `WebhookPollerService` polls for unprocessed rows every 10 seconds and processes them directly — the table row *is* the queue.

**Rationale**: Removes an entire infrastructure dependency (Redis) for a comparatively small volume of events, at the cost of an up-to-~10-second processing delay instead of near-instant. Explicitly flagged in code as worth revisiting if throughput ever becomes a real bottleneck — this was a deliberate, load-aware tradeoff, not an oversight.

## ADR-003: Money as integer minor units, never float

**Status**: Accepted

All amounts (`Transaction.amountMinorUnits`, `LedgerEntry.amountMinorUnits`) are stored and computed as integers (KES cents), never `Float` or a JS-number-backed `Decimal`. Standard for financial systems, worth stating explicitly because it constrains every future migration and API contract: amounts in and out of this system are always integers, and any client-side display formatting is display-only.

## ADR-004: Double-entry ledger over a mutable balance column

**Status**: Accepted

There is no `tenant.balance` column. Every settlement writes a balanced pair of `LedgerEntry` rows (credit `tenant_balance` / debit `pending_settlement`). A tenant's balance is a computed sum, not a hot mutable counter — this trades a small amount of query complexity for an inherently auditable, hard-to-corrupt source of truth (a balance column can silently drift from reality if any code path updates it incorrectly; a ledger cannot drift from itself).

## ADR-005: Row-Level Security as a second, independent isolation layer

**Status**: Accepted

Every tenant-scoped table is filtered by `tenantId` at the application layer already. Postgres RLS is applied on top, via a raw SQL migration outside Prisma's own management (`prisma/manual-sql/001_row_level_security.sql`). This is deliberate defense-in-depth: a single service method that forgets a `where: { tenantId }` clause is still blocked by the database itself, not just by code review.

## ADR-006: `RolesGuard` applied per-controller, not globally

**Status**: Accepted, fixing a real shipped bug

**Context**: `RolesGuard` depends on `request.user`, populated by an auth guard (`AccessTokenGuard`/`ApiKeyGuard`) that runs at the controller level. NestJS executes global `APP_GUARD`s before any controller-level guard.

**Decision**: `RolesGuard` is explicitly listed in each controller's `@UseGuards([...])` array, after the auth guard — never registered globally.

**Why this is documented as an ADR and not just a code comment**: registering it globally is the *obvious*, natural-looking choice, and doing so silently breaks every `@Roles()` check (every request appears unauthenticated to the guard, so every role-gated route rejects valid users). This shipped once already; the decision record exists specifically so it isn't reintroduced.

## ADR-007: Settlement does not require a receipt number

**Status**: Accepted (fixes a real bug found via test coverage)

**Context**: `DriftDetectorService` recovers transactions stuck in `PROCESSING` by actively querying Safaricom's STK Push Query API. That API's response (`{ resultCode, resultDesc }`) never includes `mpesaReceiptNumber` — only the async callback's `CallbackMetadata` does.

**Decision**: `TransactionStateMachine.transitionToSettled`'s `mpesaReceiptNumber` parameter is optional. Settlement is gated on Safaricom's `resultCode === 0` alone. If a transaction is later settled again by the real callback with the receipt number, it's back-filled onto the existing row rather than treated as an illegal `SETTLED → SETTLED` transition; a *conflicting* receipt number on an already-settled transaction still throws, since that would indicate a genuine data anomaly.

**Consequence**: previously, this made the drift-detection safety net's settlement path permanently unreachable — every stuck transaction that Safaricom confirmed as genuinely successful was incorrectly marked `FAILED` instead. Fixed and covered by tests in `transaction-state-machine.spec.ts` / `drift-detector.service.spec.ts`.

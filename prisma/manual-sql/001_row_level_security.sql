-- Row-Level Security policies: the second tenant-isolation layer beneath
-- application-level `WHERE tenantId = ...` filtering. Run after `prisma migrate deploy`.
--
-- The application calls `SET LOCAL app.current_tenant_id = '<uuid>'` at the start of
-- every tenant-scoped request (see PrismaService.withTenantContext, wired into
-- transactions.controller.ts, api-keys.service.ts, stk-push.service.ts,
-- reporting.service.ts, and profile.controller.ts as of this writing — that list is
-- not exhaustive; a new tenant-scoped query needs the same treatment or it isn't
-- RLS-covered).
--
-- CORRECTION (found by an actual audit of every direct query against these tables,
-- not assumed): an earlier draft of this file claimed no cross-tenant/tenant-unknown
-- query existed anywhere in the codebase. That was wrong — there are several, and
-- they're architectural, not oversights:
--   - AuthService (signup/login/password-reset) looks up a user BY EMAIL, before any
--     tenant identity exists to scope by.
--   - ApiKeyGuard resolves WHICH tenant an API key belongs to — the tenant is the
--     OUTPUT of that lookup, not an input.
--   - WebhookPollerService / DriftDetectorService are cron jobs that scan across
--     every tenant's pending/stuck transactions in one pass, never one tenant at a
--     time; TransactionStateMachine is only ever invoked by those two.
--   - AuditLogService writes carry an explicit tenantId from many calling contexts,
--     not all of them already tenant-scoped.
-- These now use PrismaPrivilegedService (src/modules/prisma/prisma-privileged.service.ts)
-- instead of PrismaService — a SECOND connection, authenticated as app_privileged
-- (BYPASSRLS, created below), separate from app_runtime (RLS-enforced). See that
-- file's own doc comment for the full reasoning per call site. Every other
-- tenant-scoped read/write goes through app_runtime + withTenantContext.
--
-- IMPORTANT — ENABLE alone is not enough. By default Postgres lets a table's OWNER
-- bypass RLS regardless of policies, and the owner is whatever role ran
-- `prisma migrate deploy` — almost certainly the same role in DATABASE_URL today.
-- FORCE ROW LEVEL SECURITY below closes that, but only once the app's runtime
-- connection is a role OTHER than the table owner: run migrations as the owner role,
-- but point DATABASE_URL at app_runtime and PRIVILEGED_DATABASE_URL at app_privileged
-- (both created below) for the running app.
-- This step needs actual passwords set and both env vars updated in your deploy
-- environment — it is not something a schema migration can do for you, and this file
-- deliberately stops short of doing it, since it changes how the app authenticates to
-- its own database. Do this in one coordinated window: FORCE makes even the table
-- owner subject to RLS, so if it lands before every tenant-scoped query is confirmed
-- to either call withTenantContext or use the privileged connection, an unwired query
-- silently returns zero rows instead of erroring.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- The FORCE ROW LEVEL SECURITY statements that used to sit here have MOVED to
-- 004_force_row_level_security.sql, and that move is the entire point.
--
-- This file is listed in README.md and CLAUDE.md as an ordinary setup step
-- ("psql $DATABASE_URL -f prisma/manual-sql/001_row_level_security.sql"), so it
-- gets run against a database whose DATABASE_URL is still the table OWNER — the
-- app_runtime/app_privileged cutover described above has not happened yet. FORCE
-- subjects the owner to RLS too, so running it in that state instantly breaks
-- every query that doesn't call withTenantContext: AuthService's login lookup,
-- ApiKeyGuard, TenantsService.listAll, both pollers. They return zero rows rather
-- than erroring, so the app comes back up looking healthy and simply cannot find
-- any users.
--
-- The header above always warned about exactly this. The executable SQL did not
-- honour the warning, which made the warning worth nothing. ENABLE (above) is
-- safe to apply today and is a no-op for the owner; FORCE is the step that must
-- wait for the role cutover, so it now lives in a file you have to choose to run.

-- Column is "tenantId" (camelCase, quoted) — Prisma only @@map'd table names to
-- snake_case in this schema, not individual field names, so the raw column stays
-- exactly as declared in schema.prisma. An earlier draft of this file used
-- unquoted tenant_id here, which doesn't exist as a column and would have failed
-- outright the moment this file was actually applied.
CREATE POLICY tenant_isolation ON users
  USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON api_keys
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON transactions
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON ledger_entries
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON webhook_events
  USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON reconciliation_records
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

CREATE POLICY tenant_isolation ON audit_logs
  USING ("tenantId" IS NULL OR "tenantId" = current_setting('app.current_tenant_id', true));

-- Written by TransactionStateMachine and read by TenantWebhookPollerService — both
-- go through PrismaPrivilegedService (cross-tenant, same reasoning as webhook_events
-- above), so this policy is defense-in-depth rather than the primary access path.
CREATE POLICY tenant_isolation ON tenant_webhook_deliveries
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

-- `tenants` itself has no tenantId column (it IS the tenant) — isolation for that
-- table is enforced entirely at the application layer (TenantsService.findOne),
-- since a row's own id is what would need to match, not a foreign key to itself.
-- IMPORTANT: ENABLE ROW LEVEL SECURITY with zero policies means default-deny once
-- FORCE is applied — without this pass-through policy, app_runtime would lose all
-- access to this table the moment FORCE lands, contradicting the "app-layer-only"
-- intent stated above. This policy is a deliberate no-op, not a mistake.
CREATE POLICY tenants_app_layer_isolation ON tenants USING (true);

-- Dedicated non-owner role for the app's default (RLS-enforced) runtime connection —
-- required for FORCE ROW LEVEL SECURITY above to mean anything. Run this once, set a
-- real password out-of-band (never commit one), then point DATABASE_URL at it for the
-- running app. Migrations keep using the original owner role, which still bypasses
-- RLS by design — that's fine, migrations aren't tenant-scoped requests.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN PASSWORD 'CHANGE_ME_SET_A_REAL_SECRET';
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_runtime;
-- Covers tables added by a future migration without re-running this file.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_runtime;

-- Second role, WITH BYPASSRLS: backs PRIVILEGED_DATABASE_URL /
-- PrismaPrivilegedService — the connection used ONLY by the handful of call sites
-- listed in the header comment above, which are architecturally incapable of
-- resolving to a single tenant before querying. BYPASSRLS makes FORCE a no-op for
-- this role specifically — deliberate, not an oversight: it's a smaller, explicitly
-- named exception to RLS rather than disabling RLS globally. Every one of its call
-- sites is named in PrismaPrivilegedService's own doc comment; adding a new caller
-- there should be a deliberate choice, not a default reached for out of convenience.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_privileged') THEN
    CREATE ROLE app_privileged LOGIN PASSWORD 'CHANGE_ME_SET_A_REAL_SECRET' BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_privileged;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_privileged;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_privileged;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_privileged;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_privileged;

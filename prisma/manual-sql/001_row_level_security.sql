-- Row-Level Security policies: the second tenant-isolation layer beneath
-- application-level `WHERE tenantId = ...` filtering. Run after `prisma migrate deploy`.
--
-- The application calls `SET LOCAL app.current_tenant_id = '<uuid>'` at the start of
-- every tenant-scoped request (see PrismaService.withTenantContext, wired into
-- transactions.controller.ts, api-keys.service.ts, and stk-push.service.ts as of this
-- writing — that list is not exhaustive; a new tenant-scoped query needs the same
-- treatment or it isn't RLS-covered). Requests that genuinely have no single target
-- tenant — a true cross-tenant admin query — should use a separate, explicitly-audited
-- connection path that bypasses RLS (BYPASSRLS role), never by disabling RLS globally.
-- No such query currently exists in the wired call sites above: every one of them
-- resolves to exactly one concrete tenantId before touching the DB, SUPER_ADMIN
-- included (see transactions.controller.ts's resolveTenantId, which requires an
-- explicit ?tenantId= from platform staff rather than defaulting to "all tenants").
--
-- IMPORTANT — ENABLE alone is not enough. By default Postgres lets a table's OWNER
-- bypass RLS regardless of policies, and the owner is whatever role ran
-- `prisma migrate deploy` — almost certainly the same role in DATABASE_URL today.
-- FORCE ROW LEVEL SECURITY below closes that, but only once the app's runtime
-- connection is a role OTHER than the table owner: run migrations as the owner role,
-- but point the app's own DATABASE_URL at app_runtime (created below) day to day.
-- This step needs an actual password set and DATABASE_URL updated in your deploy
-- environment — it is not something a schema migration can do for you, and this file
-- deliberately stops short of doing it, since it changes how the app authenticates to
-- its own database.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON api_keys
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON transactions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON ledger_entries
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON webhook_events
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON reconciliation_records
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

CREATE POLICY tenant_isolation ON audit_logs
  USING (tenant_id IS NULL OR tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- `tenants` itself has no tenant_id column (it IS the tenant) — isolation for that
-- table is enforced entirely at the application layer (TenantsService.findOne),
-- since a row's own id is what would need to match, not a foreign key to itself.

-- Dedicated non-owner role for the app's runtime connection — required for FORCE ROW
-- LEVEL SECURITY above to mean anything (see the note at the top of this file). Run
-- this once, set a real password out-of-band (never commit one), then grant it and
-- point DATABASE_URL at it for the running app. Migrations keep using the original
-- owner role, which still bypasses RLS by design — that's fine, migrations aren't
-- tenant-scoped requests.
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

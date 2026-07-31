-- Row-Level Security policies: the second tenant-isolation layer beneath
-- application-level `WHERE tenantId = ...` filtering. Run after `prisma migrate deploy`.
--
-- The application must call `SET LOCAL app.current_tenant_id = '<uuid>'` at the start
-- of every tenant-scoped request (see PrismaService.withTenantContext). Requests that
-- never set this session variable — e.g. SUPER_ADMIN cross-tenant queries — should use
-- a separate, explicitly-audited connection path that bypasses RLS (BYPASSRLS role),
-- never by disabling RLS globally.

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

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

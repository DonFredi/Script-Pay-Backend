-- Companion to migrations/20260830090000_tenant_shortcodes. Run after that migration
-- (and after 001_row_level_security.sql has already been applied once — this file
-- only touches the new tenant_shortcodes table, it does not re-run 001).
--
-- Existing tenants in this database are sandbox test data (confirmed with the
-- product owner) and are being deleted as part of rolling this out, not migrated —
-- there is deliberately no backfill INSERT here turning old tenants.businessShortcode
-- values into tenant_shortcodes rows. Every tenant re-onboards fresh afterward.

ALTER TABLE tenant_shortcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_shortcodes FORCE ROW LEVEL SECURITY;

-- Same shape as the api_keys policy in 001_row_level_security.sql: a plain
-- tenantId match against the session's app.current_tenant_id, set by
-- PrismaService.withTenantContext.
CREATE POLICY tenant_isolation ON tenant_shortcodes
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_shortcodes TO app_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_shortcodes TO app_privileged;

-- "No two ACTIVE tenants may hold the same real Safaricom shortcode" used to be a
-- single-table partial unique index (tenants_business_shortcode_active_unique,
-- retired by this same rollout) because the shortcode and the status it was
-- conditioned on both lived on `tenants`. Now the shortcode lives on
-- tenant_shortcodes and the status lives on its parent `tenants` row — a partial
-- index's WHERE clause can only reference columns of the table it's built on, so
-- the same guarantee has to be a trigger instead. Two entry points need covering,
-- matching the two places TenantsService.rejectingShortcodeConflict used to wrap:
--   1. Adding/editing a shortcode on a tenant that's already active.
--   2. Activating a tenant that already holds a shortcode colliding with another
--      active tenant's (this is the case a bare per-row trigger on
--      tenant_shortcodes would miss entirely, since no shortcode row changes).
-- pending_kyc tenants may still freely share Safaricom's sandbox shortcode with
-- each other, same as before — the check only fires once 'active' is involved.

CREATE OR REPLACE FUNCTION enforce_active_shortcode_uniqueness() RETURNS trigger AS $$
BEGIN
  IF (SELECT status FROM tenants WHERE id = NEW."tenantId") = 'active' THEN
    IF EXISTS (
      SELECT 1
      FROM tenant_shortcodes ts
      JOIN tenants t ON t.id = ts."tenantId"
      WHERE ts.shortcode = NEW.shortcode
        AND ts.id != NEW.id
        AND t.status = 'active'
    ) THEN
      RAISE EXCEPTION 'shortcode % is already in use by another active tenant', NEW.shortcode
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenant_shortcodes_active_uniqueness
  BEFORE INSERT OR UPDATE OF shortcode, "tenantId" ON tenant_shortcodes
  FOR EACH ROW EXECUTE FUNCTION enforce_active_shortcode_uniqueness();

CREATE OR REPLACE FUNCTION enforce_tenant_activation_shortcode_uniqueness() RETURNS trigger AS $$
BEGIN
  IF NEW.status = 'active' AND OLD.status IS DISTINCT FROM 'active' THEN
    IF EXISTS (
      SELECT 1
      FROM tenant_shortcodes mine
      JOIN tenant_shortcodes theirs
        ON theirs.shortcode = mine.shortcode AND theirs."tenantId" != mine."tenantId"
      JOIN tenants other ON other.id = theirs."tenantId"
      WHERE mine."tenantId" = NEW.id
        AND other.status = 'active'
    ) THEN
      RAISE EXCEPTION 'a shortcode belonging to tenant % is already in use by another active tenant', NEW.id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tenants_activation_shortcode_uniqueness
  BEFORE UPDATE OF status ON tenants
  FOR EACH ROW EXECUTE FUNCTION enforce_tenant_activation_shortcode_uniqueness();

-- Both trigger functions raise with ERRCODE 'unique_violation' (Postgres code
-- 23505) specifically so TenantShortcodesService/TenantsService can keep catching
-- this the same way rejectingShortcodeConflict always has — Prisma surfaces it as
-- PrismaClientKnownRequestError with code "P2002", same as a real unique index.

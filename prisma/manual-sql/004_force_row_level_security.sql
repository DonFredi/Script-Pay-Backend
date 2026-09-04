-- FORCE ROW LEVEL SECURITY — the second half of the RLS rollout, deliberately
-- SEPARATE from 001_row_level_security.sql and NOT part of ordinary setup.
--
-- DO NOT RUN THIS FILE UNTIL EVERY PREREQUISITE BELOW IS TRUE.
--
-- Postgres exempts a table's OWNER from its own RLS policies. The owner is
-- whichever role ran `prisma migrate deploy`. FORCE removes that exemption — which
-- is the point, but it means FORCE is only safe once the application connects as a
-- role that is NOT the owner. Applied before then, every query that does not run
-- inside PrismaService.withTenantContext starts returning zero rows instead of
-- raising: AuthService's login-by-email lookup, ApiKeyGuard's key resolution,
-- TenantsService.listAll, WebhookPollerService, DriftDetectorService. Nothing
-- errors. The app just stops finding data, which is a far worse failure than a
-- crash because it looks like a data problem rather than a config one.
--
-- PREREQUISITES — confirm all five, in this order:
--
--   1. 001_row_level_security.sql has been applied (policies exist, RLS ENABLEd,
--      and the app_runtime / app_privileged roles have been created).
--   2. Both roles have had REAL passwords set, out of band. 001 creates them with
--      the literal placeholder 'CHANGE_ME_SET_A_REAL_SECRET'.
--         ALTER ROLE app_runtime    WITH PASSWORD '...';
--         ALTER ROLE app_privileged WITH PASSWORD '...';
--   3. DATABASE_URL points at app_runtime, and PRIVILEGED_DATABASE_URL points at
--      app_privileged. Migrations keep using the original owner role — that is
--      correct and unaffected by this file.
--   4. Every tenant-scoped query either calls withTenantContext or deliberately
--      uses PrismaPrivilegedService. Audit this rather than assuming it; the known
--      gaps at the time of writing were TenantsService.notifyWebhookSecretRotated,
--      TenantsService.provisionApiKeyOnActivation and ApiKeysService.notifyKeyIssued,
--      all of which read `users` with no tenant context.
--   5. You have a rollback ready and are doing this in a maintenance window. The
--      rollback is at the bottom of this file.
--
-- Verify after applying, with the app running as app_runtime: log in, list
-- transactions, initiate a payment, and confirm a tenant admin still receives the
-- API-key email on activation. A silent empty result anywhere means prerequisite 4
-- was not actually met — roll back and fix the query, don't work around it here.

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE transactions FORCE ROW LEVEL SECURITY;
ALTER TABLE ledger_entries FORCE ROW LEVEL SECURITY;
ALTER TABLE webhook_events FORCE ROW LEVEL SECURITY;
ALTER TABLE reconciliation_records FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhook_deliveries FORCE ROW LEVEL SECURITY;

-- --- ROLLBACK -------------------------------------------------------------
-- Returns the owner exemption without dropping any policy, so the app recovers
-- immediately while you fix whatever query was not RLS-aware. Run all nine.
--
-- ALTER TABLE tenants                   NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE users                     NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE api_keys                  NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE transactions              NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE ledger_entries            NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE webhook_events            NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE reconciliation_records    NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE audit_logs                NO FORCE ROW LEVEL SECURITY;
-- ALTER TABLE tenant_webhook_deliveries NO FORCE ROW LEVEL SECURITY;

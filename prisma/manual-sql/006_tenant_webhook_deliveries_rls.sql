-- Row-Level Security for tenant_webhook_deliveries — closing a gap, not adding a
-- new policy.
--
-- WHY THIS FILE EXISTS
-- 001_row_level_security.sql ALREADY contains both the ENABLE and the policy for
-- this table. But 001 was applied to production BEFORE the table existed: it is
-- created by migration 20260827131831_add_tenant_webhook_delivery, which landed
-- afterwards, and 001 was never re-run. A production audit found the table sitting
-- at rls=disabled, policies=0 while all nine of its siblings were enabled and
-- FORCEd.
--
-- That is the failure mode of any "run this script once by hand" step: it protects
-- the tables that existed on the day it ran, and silently misses every table added
-- later. Worth remembering the next time a tenant-scoped model is added — the
-- add-tenant-scoped-table skill in .claude/skills exists for exactly this checklist.
--
-- WHAT THE TABLE HOLDS
-- Outbound settlement notifications: tenantId, transactionId, and a payload
-- carrying the amount, M-Pesa receipt number and the tenant's own metadata for a
-- settled transaction. Readable across tenants, it leaks one merchant's payment
-- history to another.
--
-- SAFETY
-- Idempotent, and safe to run on a live database. The table is written by
-- TransactionStateMachine and read by TenantWebhookPollerService, both of which use
-- PrismaPrivilegedService — the app_privileged role has BYPASSRLS, so neither is
-- affected by this policy. It is defence in depth against a future caller reaching
-- the table on the app_runtime connection, matching the comment 001 already carries
-- for this table.
--
-- Run in the Supabase SQL Editor (as postgres — app_privileged does not own these
-- tables and cannot ALTER them).

ALTER TABLE tenant_webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_webhook_deliveries FORCE ROW LEVEL SECURITY;

-- CREATE POLICY has no IF NOT EXISTS, so drop first to keep this re-runnable.
DROP POLICY IF EXISTS tenant_isolation ON tenant_webhook_deliveries;

-- Same shape and same policy name as every other tenant-scoped table in 001.
CREATE POLICY tenant_isolation ON tenant_webhook_deliveries
  USING ("tenantId" = current_setting('app.current_tenant_id', true));

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- Expect enabled=t, forced=t, policies=1 — matching transactions and ledger_entries.
--
-- select c.relname, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
--        (select count(*) from pg_policies p
--         where p.tablename = c.relname and p.schemaname = 'public') as policies
-- from pg_class c join pg_namespace n on n.oid = c.relnamespace
-- where n.nspname = 'public' and c.relkind = 'r'
--   and c.relname in ('tenant_webhook_deliveries', 'transactions', 'ledger_entries')
-- order by c.relname;
--
-- ---------------------------------------------------------------------------
-- Still deliberately outside RLS after this file
-- ---------------------------------------------------------------------------
-- refresh_tokens, email_verification_tokens, password_reset_tokens.
-- These are keyed by userId, not tenantId, so the tenant_isolation shape does not
-- apply to them, and every path that touches them runs on the privileged connection
-- (AuthService, RefreshTokenService) before any tenant is known. Recorded here so
-- their absence reads as a decision rather than the same drift this file is fixing.

-- Prevents two ACTIVE tenants from ever sharing one Paybill/Till number — without
-- this, an incoming Daraja webhook can only be matched to a tenant by shortcode
-- (see WebhookPollerService.processC2bConfirmation), so a collision means one
-- tenant's real customer payment gets attributed to another tenant's ledger.
--
-- Scoped to status = 'active' deliberately, not every tenant: Safaricom's shared
-- sandbox shortcode (174379) is legitimately used by multiple tenants at once while
-- they're still in pending_kyc, ahead of Safaricom's own production approval —
-- every tenant is expected to configure a real, unique shortcode once approved and
-- moved to 'active', which is also the point where it can start receiving real
-- customer money. A global (non-partial) constraint would block that shared sandbox
-- workflow outright. Prisma's schema language has no native support for a partial/
-- filtered unique index (see prisma/prisma#1265), so this lives here rather than in
-- schema.prisma + a regular migration, same reasoning as 001_row_level_security.sql.
--
-- Run after prisma migrate dev, same as 001. Application code (TenantsService) still
-- rejects a colliding shortcode on its own before hitting this — this index is the
-- backstop for the day a code path forgets that check, not the only enforcement.

CREATE UNIQUE INDEX IF NOT EXISTS tenants_business_shortcode_active_unique
  ON tenants ("businessShortcode")
  WHERE status = 'active';

import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * A second database connection, authenticated (once the RLS rollout's live cutover
 * happens — see prisma/manual-sql/001_row_level_security.sql) as a Postgres role
 * with BYPASSRLS. Used ONLY by code paths that are architecturally incapable of
 * resolving to a single tenant before querying:
 *
 *  - AuthService — signup/login/password-reset look up a user BY EMAIL, before any
 *    tenant identity exists to scope by.
 *  - ApiKeyGuard — resolves WHICH tenant an API key belongs to; the tenant is the
 *    output of this lookup, not an input to it.
 *  - WebhookPollerService / DriftDetectorService — cron jobs that scan across every
 *    tenant's pending/stuck transactions in one pass, never one tenant at a time.
 *  - TransactionStateMachine — only ever invoked BY those two background services
 *    (confirmed: grep finds zero callers outside webhook-poller.service.ts and
 *    drift-detector.service.ts), so it shares their connection rather than needing
 *    withTenantContext threaded in from a caller that has no single tenant either.
 *    It also enqueues TenantWebhookDelivery rows in the same transaction as a
 *    settle/fail — still fine on this connection, since it's the same call site.
 *  - TenantWebhookPollerService — scans PENDING deliveries across every tenant in
 *    one pass, same shape as WebhookPollerService but outbound instead of inbound.
 *  - AuditLogService — writes carry an explicit tenantId param from many different
 *    calling contexts, some already tenant-scoped and many not (system-actor
 *    entries, pre-auth signup events). RLS's WITH CHECK would reject a non-null
 *    tenantId write whenever the caller's own withTenantContext wasn't already
 *    active for that exact tenant. Threading tenant context through every call site
 *    that happens to also log an audit event is fragile; giving audit logging its
 *    own connection isn't.
 *
 * Falls back to DATABASE_URL when PRIVILEGED_DATABASE_URL is unset — that's the
 * state today, before the live cutover: both connections are the same owner-role
 * connection, which already bypasses RLS regardless, so this class is a no-op
 * change in behavior until the cutover actually happens.
 *
 * Every other tenant-scoped read/write MUST go through PrismaService.withTenantContext
 * instead of this — this connection has no per-request tenant isolation whatsoever.
 */
@Injectable()
export class PrismaPrivilegedService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      datasources: {
        db: { url: process.env.PRIVILEGED_DATABASE_URL || process.env.DATABASE_URL },
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}

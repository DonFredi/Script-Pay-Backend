import { Injectable, Logger } from "@nestjs/common";
import * as argon2 from "argon2";
// import { customAlphabet } from "nanoid";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { EmailService } from "../auth/email.service";
import type { ApiKeyScope } from "@prisma/client";
import { randomBytes } from "crypto";

// A pepper is a second secret, held only in application config (never in the DB),
// mixed in before hashing. A stolen DATABASE backup alone is then insufficient to
// brute-force keys even offline — the attacker also needs this env var, which lives
// in the secrets manager, not the database.
const PEPPER = process.env.API_KEY_HASH_PEPPER ?? "";

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly emailService: EmailService,
  ) {}

  /**
   * Returns the raw key EXACTLY ONCE — it is never retrievable again after this call,
   * matching how every other API-key-issuing platform works. Only the argon2 hash and
   * an 8-char prefix (for UI identification) are persisted.
   */
  async create(tenantId: string, scopes: ApiKeyScope[], actorId: string, expiresAt?: Date) {
    const { rawKey, keyHash, keyPrefix } = await this.mintKeyMaterial();

    const record = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.apiKey.create({
        data: { tenantId, keyHash, keyPrefix, scopes, expiresAt },
      }),
    );

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId,
      action: "api_key.created",
      targetType: "ApiKey",
      targetId: record.id,
      metadata: { scopes, keyPrefix: record.keyPrefix }, // never log the raw key or hash
    });

    await this.notifyKeyIssued(tenantId, actorId, rawKey, record.keyPrefix, scopes);

    return { id: record.id, rawKey, keyPrefix: record.keyPrefix, scopes: record.scopes };
  }

  /**
   * Tenant admins get the raw key (same one-time-reveal channel as activation
   * auto-provisioning); platform staff get a metadata-only notice — never the
   * raw key, since they aren't the party it authenticates as. Best-effort:
   * a lookup/delivery failure here must never fail the key creation itself,
   * same reasoning as TenantsService.provisionApiKeyOnActivation.
   */
  private async notifyKeyIssued(
    tenantId: string,
    actorId: string,
    rawKey: string,
    keyPrefix: string,
    scopes: ApiKeyScope[],
  ) {
    try {
      const [tenant, actor, admins, staff] = await Promise.all([
        this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
        this.prisma.user.findUnique({ where: { id: actorId }, select: { email: true } }),
        this.prisma.user.findMany({ where: { tenantId, role: "TENANT_ADMIN" }, select: { email: true } }),
        this.prisma.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { email: true } }),
      ]);

      await Promise.all([
        ...admins.map((admin) => this.emailService.sendApiKeyRotatedEmail(admin.email, rawKey)),
        ...staff.map((member) =>
          this.emailService.sendApiKeyStaffNotice(
            member.email,
            tenant?.name ?? tenantId,
            keyPrefix,
            scopes,
            actor?.email ?? actorId,
          ),
        ),
      ]);
    } catch (error) {
      this.logger.error(`Failed to notify of API key issuance for tenant ${tenantId}`, error as Error);
    }
  }

  /**
   * System-triggered issuance — no human actor initiated this, so it's
   * audit-logged as actorType "system" (actorId null) rather than attributing
   * it to whichever admin happened to flip the tenant's status field. Only
   * ever called via provisionDefaultKeyIfNeeded below.
   */
  private async createSystemIssued(tenantId: string, scopes: ApiKeyScope[]) {
    const { rawKey, keyHash, keyPrefix } = await this.mintKeyMaterial();

    const record = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.apiKey.create({
        data: { tenantId, keyHash, keyPrefix, scopes },
      }),
    );

    await this.auditLog.record({
      tenantId,
      actorType: "system",
      action: "api_key.created",
      targetType: "ApiKey",
      targetId: record.id,
      metadata: { scopes, keyPrefix: record.keyPrefix, reason: "tenant_activated" },
    });

    return { id: record.id, rawKey, keyPrefix: record.keyPrefix, scopes: record.scopes };
  }

  /**
   * Auto-provisioning entry point — called once by TenantsService.updateStatus
   * when a tenant transitions into "active", so a merchant who only wants to
   * accept payments never has to visit an API-key management page at all (see
   * docs/decisions.md entry 14). Idempotent: a tenant that already holds a
   * live (non-revoked) key — most commonly re-activating after a suspension —
   * never gets a redundant second one just for that. Default scopes cover the
   * two wired tenant-integration capabilities (STK push initiation, webhook
   * registration) plus the reserved-but-not-yet-wired PAYMENTS_READ, so a
   * tenant never needs a second key issued the day that scope gets a route.
   */
  async provisionDefaultKeyIfNeeded(tenantId: string) {
    const existing = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.apiKey.findFirst({ where: { tenantId, revokedAt: null } }),
    );
    if (existing) return null;

    return this.createSystemIssued(tenantId, ["PAYMENTS_INITIATE", "PAYMENTS_READ", "WEBHOOKS_MANAGE"]);
  }

  private async mintKeyMaterial() {
    const rawKey = `sp_${randomBytes(40).toString("hex")}`;
    const keyHash = await argon2.hash(rawKey + PEPPER);
    return { rawKey, keyHash, keyPrefix: rawKey.slice(0, 8) };
  }

  async listForTenant(tenantId: string) {
    // Deliberately excludes keyHash from the select — never return it, even to the owning tenant.
    return this.prisma.withTenantContext(tenantId, (tx) =>
      tx.apiKey.findMany({
        where: { tenantId },
        select: {
          id: true,
          keyPrefix: true,
          scopes: true,
          lastUsedAt: true,
          revokedAt: true,
          expiresAt: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
    );
  }

  async revoke(tenantId: string, keyId: string, actorId: string) {
    // Scoped by tenantId in the WHERE clause, not just the id — prevents one tenant
    // from revoking another tenant's key by guessing/enumerating IDs. Also runs under
    // RLS's tenant context now, so this is enforced twice over (see PrismaService.withTenantContext).
    const result = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.apiKey.updateMany({
        where: { id: keyId, tenantId },
        data: { revokedAt: new Date() },
      }),
    );

    if (result.count > 0) {
      await this.auditLog.record({
        tenantId,
        actorType: "user",
        actorId,
        action: "api_key.revoked",
        targetType: "ApiKey",
        targetId: keyId,
      });
    }

    return result;
  }
}

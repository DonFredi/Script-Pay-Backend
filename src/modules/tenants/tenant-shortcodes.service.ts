import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { CredentialsEncryptionService } from "./credentials-encryption.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import type { CreateShortcodeDto, UpdateShortcodeDto } from "./tenant-shortcodes.schema";

export interface ShortcodeSummary {
  id: string;
  type: string;
  shortcode: string;
  isDefault: boolean;
  stkConfigured: boolean;
  payoutConfigured: boolean;
  createdAt: Date;
}

/**
 * Owns everything specific to ONE of a tenant's Safaricom shortcodes — a Till, a
 * Paybill, or a shortcode registered for B2C. Counterpart to
 * TenantsService.setAppCredentials, which owns the shared, org-level Consumer
 * Key/Secret every shortcode here authenticates with. Split the same way
 * ApiKeysService is its own service alongside TenantsService: a tenant-owned,
 * RLS-scoped child resource with its own create/list/remove lifecycle.
 */
@Injectable()
export class TenantShortcodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: CredentialsEncryptionService,
    private readonly daraja: DarajaClient,
    private readonly auditLog: AuditLogService,
  ) {}

  async create(tenantId: string, dto: CreateShortcodeDto, actor: AuthenticatedUser): Promise<ShortcodeSummary> {
    this.assertCanManage(tenantId, actor);

    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenant.mpesaConsumerKey || !tenant.mpesaConsumerSecretEncrypted) {
      throw new ForbiddenException(
        "Set this tenant's Daraja app credentials (consumer key/secret) before adding a shortcode",
      );
    }
    const consumerSecret = this.encryption.decrypt(tenant.mpesaConsumerSecretEncrypted);

    // Fail fast, same reasoning TenantsService.setAppCredentials already applies to
    // the app credentials themselves: confirm they still authenticate before this
    // shortcode is persisted against them.
    await this.daraja.verifyCredentials({
      mpesaConsumerKey: tenant.mpesaConsumerKey,
      mpesaConsumerSecretEncrypted: consumerSecret,
    });

    const created = await this.rejectingShortcodeConflict(
      this.prisma.withTenantContext(tenantId, async (tx) => {
        // At most one default per (tenant, type) — getMpesaCredentialsForPayment
        // does findFirst({ type, isDefault: true }), so two defaults of the same
        // type makes that lookup nondeterministic. Unsetting the old one runs in
        // the same transaction as the insert below (withTenantContext already
        // wraps its callback in $transaction), so nothing can observe two
        // defaults for this type even momentarily.
        if (dto.isDefault) {
          await tx.tenantShortcode.updateMany({
            where: { tenantId, type: dto.type, isDefault: true },
            data: { isDefault: false },
          });
        }

        return tx.tenantShortcode.create({
          data: {
            tenantId,
            type: dto.type,
            shortcode: dto.shortcode,
            isDefault: dto.isDefault,
            mpesaPasskeyEncrypted: dto.passkey ? this.encryption.encrypt(dto.passkey) : null,
            ...(dto.initiatorName && dto.securityCredential
              ? {
                  mpesaInitiatorName: dto.initiatorName,
                  mpesaSecurityCredentialEncrypted: this.encryption.encrypt(dto.securityCredential),
                  mpesaPayoutConfiguredAt: new Date(),
                }
              : {}),
          },
        });
      }),
    );

    // Best-effort, same as before the shortcode split: tells Safaricom where to
    // deliver C2B confirmations for direct till/paybill payments that skip STK
    // Push. A failure here must not undo the shortcode that was just saved — it
    // only means manual payments on it stay untracked until retried.
    let c2bUrlRegistered: boolean | undefined;
    if (dto.type !== "B2C") {
      c2bUrlRegistered = true;
      try {
        await this.daraja.registerC2bUrl({
          mpesaConsumerKey: tenant.mpesaConsumerKey,
          mpesaConsumerSecretEncrypted: consumerSecret,
          shortcode: dto.shortcode,
        });
      } catch (error) {
        c2bUrlRegistered = false;
        await this.auditLog.record({
          tenantId,
          actorType: "system",
          action: "daraja.c2b_url_registration_failed",
          metadata: { error: String(error), shortcode: dto.shortcode },
        });
      }
    }

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant_shortcode.created",
      targetType: "TenantShortcode",
      targetId: created.id,
      metadata: {
        type: dto.type,
        shortcode: dto.shortcode,
        payoutCredentialsConfigured: Boolean(dto.initiatorName && dto.securityCredential),
        c2bUrlRegistered,
      },
    });

    return this.toSummary(created);
  }

  async listForTenant(tenantId: string, actor: AuthenticatedUser): Promise<ShortcodeSummary[]> {
    this.assertCanManage(tenantId, actor);

    const rows = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.tenantShortcode.findMany({ where: { tenantId }, orderBy: { createdAt: "asc" } }),
    );
    return rows.map((row) => this.toSummary(row));
  }

  async update(
    tenantId: string,
    shortcodeId: string,
    dto: UpdateShortcodeDto,
    actor: AuthenticatedUser,
  ): Promise<ShortcodeSummary> {
    this.assertCanManage(tenantId, actor);

    const updated = await this.rejectingShortcodeConflict(
      this.prisma.withTenantContext(tenantId, async (tx) => {
        const existing = await tx.tenantShortcode.findFirst({ where: { id: shortcodeId, tenantId } });
        if (!existing) throw new NotFoundException("Shortcode not found");

        // Same one-default-per-type rule as create(), enforced here too since this
        // is the route "Make default" on an existing shortcode actually hits.
        // dto.type covers the (rare) case type is being changed in the same patch.
        if (dto.isDefault) {
          await tx.tenantShortcode.updateMany({
            where: { tenantId, type: dto.type ?? existing.type, isDefault: true, id: { not: shortcodeId } },
            data: { isDefault: false },
          });
        }

        return tx.tenantShortcode.update({
          where: { id: shortcodeId },
          data: {
            ...(dto.type !== undefined ? { type: dto.type } : {}),
            ...(dto.shortcode !== undefined ? { shortcode: dto.shortcode } : {}),
            ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
            ...(dto.passkey ? { mpesaPasskeyEncrypted: this.encryption.encrypt(dto.passkey) } : {}),
            ...(dto.initiatorName && dto.securityCredential
              ? {
                  mpesaInitiatorName: dto.initiatorName,
                  mpesaSecurityCredentialEncrypted: this.encryption.encrypt(dto.securityCredential),
                  mpesaPayoutConfiguredAt: new Date(),
                }
              : {}),
          },
        });
      }),
    );

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant_shortcode.updated",
      targetType: "TenantShortcode",
      targetId: shortcodeId,
    });

    return this.toSummary(updated);
  }

  async remove(tenantId: string, shortcodeId: string, actor: AuthenticatedUser): Promise<void> {
    this.assertCanManage(tenantId, actor);

    const result = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.tenantShortcode.deleteMany({ where: { id: shortcodeId, tenantId } }),
    );
    if (result.count === 0) throw new NotFoundException("Shortcode not found");

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant_shortcode.removed",
      targetType: "TenantShortcode",
      targetId: shortcodeId,
    });
  }

  /**
   * Re-sends this shortcode's C2B callback URLs to Safaricom.
   *
   * WHY THIS IS A SEPARATE OPERATION
   * Of the three callback types, only C2B's is stored on Safaricom's side.
   * STK Push's CallBackURL and B2C's ResultURL/QueueTimeOutURL are built per
   * request from MPESA_CALLBACK_BASE_URL, so changing that env var fixes them
   * immediately. C2B's ConfirmationURL/ValidationURL are registered ONCE, and
   * Safaricom keeps posting to whatever it was told until it is told otherwise.
   *
   * Until now the only code path that registered them was create(), so moving the
   * backend to a new domain left every existing shortcode pointing at the old one
   * with no way to fix it short of deleting and recreating the shortcode — which
   * for a live tenant means losing the row that payments reference.
   *
   * Unlike create(), a failure here is NOT swallowed. There the registration is a
   * best-effort side effect of saving a shortcode, and losing it must not roll back
   * the save. Here registration IS the operation: reporting success when Safaricom
   * rejected it would leave the caller believing callbacks are fixed when they are
   * still going to the old host. The BadGatewayException from DarajaClient
   * propagates unchanged.
   */
  async registerC2bUrl(tenantId: string, shortcodeId: string, actor: AuthenticatedUser) {
    this.assertCanManage(tenantId, actor);

    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenant.mpesaConsumerKey || !tenant.mpesaConsumerSecretEncrypted) {
      throw new ForbiddenException(
        "Set this tenant's Daraja app credentials (consumer key/secret) before registering callback URLs",
      );
    }

    const shortcode = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.tenantShortcode.findFirst({ where: { id: shortcodeId, tenantId } }),
    );
    if (!shortcode) throw new NotFoundException("Shortcode not found");

    // A B2C shortcode has no C2B URLs to register — its ResultURL and
    // QueueTimeOutURL travel with each payment request. Rejecting here rather than
    // calling Daraja means the caller gets a reason instead of a confusing
    // Safaricom-side error about a shortcode not enabled for C2B.
    if (shortcode.type === "B2C") {
      throw new BadRequestException(
        "A B2C shortcode has no C2B callback URLs to register — its ResultURL is sent with each payout request",
      );
    }

    await this.daraja.registerC2bUrl({
      mpesaConsumerKey: tenant.mpesaConsumerKey,
      mpesaConsumerSecretEncrypted: this.encryption.decrypt(tenant.mpesaConsumerSecretEncrypted),
      shortcode: shortcode.shortcode,
    });

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "daraja.c2b_url_registered",
      targetType: "TenantShortcode",
      targetId: shortcode.id,
      metadata: { shortcode: shortcode.shortcode, type: shortcode.type },
    });

    return { registered: true, shortcode: shortcode.shortcode, type: shortcode.type };
  }

  /** Same "my own tenant only, unless SUPER_ADMIN" split as every other tenant-owned resource. */
  private assertCanManage(tenantId: string, actor: AuthenticatedUser) {
    if (actor.tenantId !== tenantId && actor.role !== "SUPER_ADMIN") {
      throw new ForbiddenException("Cannot manage another tenant's shortcodes");
    }
  }

  /** Never exposes the encrypted secret columns themselves — only whether they're set. */
  private toSummary(row: {
    id: string;
    type: string;
    shortcode: string;
    isDefault: boolean;
    mpesaPasskeyEncrypted: string | null;
    mpesaPayoutConfiguredAt: Date | null;
    createdAt: Date;
  }): ShortcodeSummary {
    return {
      id: row.id,
      type: row.type,
      shortcode: row.shortcode,
      isDefault: row.isDefault,
      stkConfigured: Boolean(row.mpesaPasskeyEncrypted),
      payoutConfigured: Boolean(row.mpesaPayoutConfiguredAt),
      createdAt: row.createdAt,
    };
  }

  /**
   * The unique constraint that can fire on either of these writes now comes from
   * the tenant_shortcodes_active_uniqueness trigger (manual-sql/003_tenant_shortcodes.sql)
   * rather than a partial index — see that file's header comment for why a
   * cross-table check has to be a trigger. Prisma still surfaces it as
   * PrismaClientKnownRequestError code P2002, same as a real unique index would.
   */
  private async rejectingShortcodeConflict<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("This shortcode is already in use by another active tenant");
      }
      throw error;
    }
  }
}

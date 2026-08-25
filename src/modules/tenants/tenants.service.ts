import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import type { CreateTenantDto, UpdateTenantStatusDto } from "./tenant.dto";
import type { MpesaCredentialsDto } from "./tenants.schema";
import type { TenantMpesaCredentials } from "../../infrastructure/daraja/daraja.client";
import { CredentialsEncryptionService } from "./credentials-encryption.service";

@Injectable()
export class TenantsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly encryption: CredentialsEncryptionService,
  ) {}

  /** SUPER_ADMIN only — enforced at the controller via @Roles(), not re-checked here on purpose:
   *  authorization is the guard's job, this service trusts it already ran. */
  async create(dto: CreateTenantDto, actor: AuthenticatedUser) {
    const tenant = await this.prisma.tenant.create({ data: { ...dto, status: "pending_kyc" } });

    await this.auditLog.record({
      tenantId: tenant.id,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.created",
      targetType: "Tenant",
      targetId: tenant.id,
      metadata: { name: tenant.name, businessShortcode: tenant.businessShortcode },
    });

    return tenant;
  }
  async setMpesaCredentials(tenantId: string, dto: MpesaCredentialsDto, actor: AuthenticatedUser) {
    if (actor.tenantId !== tenantId && actor.role !== "SUPER_ADMIN") {
      throw new ForbiddenException("Cannot configure another tenant's credentials");
    }

    await this.rejectingShortcodeConflict(
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          businessShortcode: dto.businessShortcode,
          mpesaConsumerKey: dto.consumerKey,
          mpesaConsumerSecretEncrypted: this.encryption.encrypt(dto.consumerSecret),
          mpesaPasskeyEncrypted: this.encryption.encrypt(dto.passkey),
          mpesaCredentialsConfiguredAt: new Date(),
        },
      }),
    );

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.mpesa_credentials_configured",
    });

    // Never echo the secret/passkey back, even to the tenant that just set it.
    return { configured: true };
  }

  async getMpesaCredentialsForPayment(tenantId: string): Promise<TenantMpesaCredentials> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
    if (!tenant.mpesaConsumerKey || !tenant.mpesaConsumerSecretEncrypted || !tenant.mpesaPasskeyEncrypted) {
      throw new ForbiddenException(
        "M-Pesa credentials aren't configured for this tenant yet — set them up before initiating payments",
      );
    }
    return {
      shortcode: tenant.businessShortcode,
      mpesaConsumerKey: tenant.mpesaConsumerKey,
      mpesaConsumerSecretEncrypted: this.encryption.decrypt(tenant.mpesaConsumerSecretEncrypted),
      mpesaPasskeyEncrypted: this.encryption.decrypt(tenant.mpesaPasskeyEncrypted),
    };
  }

  /**
   * SUPER_ADMIN sees any tenant; TENANT_ADMIN/TENANT_STAFF can only see their own.
   * This check is duplicated here even though a route guard also restricts by role,
   * because "my own tenant only" is a data-scoping rule, not a role-gating rule —
   * two different concerns that happen to both look like authorization.
   */
  async findOne(id: string, caller: AuthenticatedUser) {
    if (caller.role !== "SUPER_ADMIN" && caller.tenantId !== id) {
      throw new ForbiddenException("Cannot access another tenant's data");
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException("Tenant not found");
    return tenant;
  }

  async listAll() {
    return this.prisma.tenant.findMany({ orderBy: { createdAt: "desc" } });
  }

  /**
   * Self-service path for a freshly-registered TENANT_ADMIN (see AuthService.signup,
   * which creates the User with tenantId: null). Deliberately distinct from create():
   * that one is SUPER_ADMIN-only and can assign a tenant to anyone; this one only
   * ever operates on the CALLER's own account and only works once — a user who
   * already has a tenantId has nothing to onboard.
   */
  async onboardSelf(dto: CreateTenantDto, actor: AuthenticatedUser) {
    if (actor.tenantId) {
      throw new ForbiddenException("Account is already associated with a tenant");
    }
    if (actor.role !== "TENANT_ADMIN") {
      throw new ForbiddenException("Only a tenant admin can provision a tenant");
    }

    // The two checks above read actor.tenantId from the request's JWT claims, not a
    // fresh DB read — a double-submit (or a retried request) can pass both checks
    // twice before either write lands. tenant.create + user.updateMany run in one
    // transaction, and updateMany's WHERE re-checks tenantId: null at write time:
    // only one of two racing requests can actually claim the account, and the loser
    // throws inside the transaction, rolling its own tenant row back with it instead
    // of leaving an orphaned Tenant nothing points to.
    const tenant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({ data: { ...dto, status: "pending_kyc" } });

      const linked = await tx.user.updateMany({
        where: { id: actor.id, tenantId: null },
        data: { tenantId: created.id },
      });
      if (linked.count !== 1) {
        throw new ConflictException("Account is already associated with a tenant");
      }

      return created;
    });

    await this.auditLog.record({
      tenantId: tenant.id,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.onboarded_self",
      targetType: "Tenant",
      targetId: tenant.id,
      metadata: { name: tenant.name, businessShortcode: tenant.businessShortcode },
    });

    return tenant;
  }

  /**
   * SUPER_ADMIN may set any tenant to any status, including reverting one to
   * "pending_kyc" for re-review. A TENANT_ADMIN may only toggle their OWN tenant
   * between "active" and "suspended" — self-service deactivation, not a path to
   * self-approve out of KYC review or touch another tenant's status.
   */
  async updateStatus(tenantId: string, dto: UpdateTenantStatusDto, actor: AuthenticatedUser) {
    if (actor.role !== "SUPER_ADMIN") {
      if (actor.tenantId !== tenantId) {
        throw new ForbiddenException("Cannot change another tenant's status");
      }
      if (dto.status === "pending_kyc") {
        throw new ForbiddenException("Only ScriptPay staff can move a tenant into KYC review");
      }
    }

    const tenant = await this.rejectingShortcodeConflict(
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: { status: dto.status },
      }),
    );

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.status_changed",
      targetType: "Tenant",
      targetId: tenantId,
      metadata: { newStatus: dto.status },
    });

    return tenant;
  }

  /**
   * The only unique constraint that can fire on a tenants.update is the partial
   * index on businessShortcode scoped to status = 'active' (see
   * prisma/manual-sql/002_tenant_shortcode_unique_active.sql) — pending_kyc tenants
   * may share Safaricom's sandbox shortcode freely, so this only ever surfaces once
   * a shortcode collides with another tenant that's actually live.
   */
  private async rejectingShortcodeConflict<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException(
          "This Paybill/Till shortcode is already in use by another active tenant",
        );
      }
      throw error;
    }
  }
}
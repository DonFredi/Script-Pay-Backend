import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { EmailService } from "../auth/email.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import type { CreateTenantDto, UpdateTenantStatusDto } from "./tenant.dto";
import type { MpesaCredentialsDto } from "./tenants.schema";
import type { TenantMpesaCredentials, TenantPayoutCredentials } from "../../infrastructure/daraja/daraja.client";
import { CredentialsEncryptionService } from "./credentials-encryption.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";

@Injectable()
export class TenantsService {
  private readonly logger = new Logger(TenantsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    private readonly encryption: CredentialsEncryptionService,
    private readonly apiKeysService: ApiKeysService,
    private readonly emailService: EmailService,
    private readonly daraja: DarajaClient,
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

    // Fail fast: confirm this consumer key/secret actually authenticate with Daraja
    // BEFORE persisting anything. Without this, a typo'd secret saves silently and
    // the tenant only discovers it at their first real STK push — a much worse place
    // to find out. Throws BadGatewayException on rejection, which the controller lets
    // through as-is (same pattern as the payment paths).
    await this.daraja.verifyCredentials({
      mpesaConsumerKey: dto.consumerKey,
      mpesaConsumerSecretEncrypted: dto.consumerSecret,
    });

    await this.rejectingShortcodeConflict(
      this.prisma.tenant.update({
        where: { id: tenantId },
        data: {
          businessShortcode: dto.businessShortcode,
          mpesaConsumerKey: dto.consumerKey,
          mpesaConsumerSecretEncrypted: this.encryption.encrypt(dto.consumerSecret),
          mpesaPasskeyEncrypted: this.encryption.encrypt(dto.passkey),
          mpesaCredentialsConfiguredAt: new Date(),
          // Spread rather than set unconditionally: a tenant re-submitting only their
          // collection credentials must not silently wipe payout credentials they
          // configured earlier. The zod schema guarantees these two arrive together
          // or not at all, so one being present implies the other.
          ...(dto.initiatorName && dto.securityCredential
            ? {
                mpesaInitiatorName: dto.initiatorName,
                mpesaSecurityCredentialEncrypted: this.encryption.encrypt(dto.securityCredential),
                mpesaPayoutConfiguredAt: new Date(),
              }
            : {}),
        },
      }),
    );

    // Best-effort: tells Safaricom where to deliver C2B confirmations for direct
    // till/paybill payments (ones that skip STK Push). Credentials are already
    // verified and saved above, so a failure here must not undo that or fail the
    // whole request — it only means manual payments on this shortcode stay
    // untracked until this is retried (e.g. by re-submitting the same credentials).
    let c2bUrlRegistered = true;
    try {
      await this.daraja.registerC2bUrl({
        mpesaConsumerKey: dto.consumerKey,
        mpesaConsumerSecretEncrypted: dto.consumerSecret,
        shortcode: dto.businessShortcode,
      });
    } catch (error) {
      c2bUrlRegistered = false;
      this.logger.warn(`C2B URL registration failed for tenant ${tenantId}: ${String(error)}`);
      await this.auditLog.record({
        tenantId,
        actorType: "system",
        action: "daraja.c2b_url_registration_failed",
        metadata: { error: String(error) },
      });
    }

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.mpesa_credentials_configured",
      // Records WHETHER payout access was configured, never the credential itself.
      metadata: { payoutCredentialsConfigured: Boolean(dto.initiatorName && dto.securityCredential), c2bUrlRegistered },
    });

    // Never echo the secret/passkey back, even to the tenant that just set it.
    return { configured: true, c2bUrlRegistered };
  }

  /**
   * Called from an API-key-authenticated route (TenantWebhookConfigController), not
   * a dashboard session — so there's no AuthenticatedUser to authorize against; the
   * tenant is already established by ApiKeyGuard + the WEBHOOKS_MANAGE scope check
   * before this ever runs, same trust model as StkPushService.initiate.
   *
   * The secret is generated here, server-side, never accepted from the caller —
   * same reasoning as ApiKeysService.create not letting a client choose its own key.
   * Returned exactly once; only the encrypted form is ever persisted.
   */
  async configureWebhook(tenantId: string, webhookUrl: string, actorApiKeyId: string | null) {
    const webhookSecret = `whsec_${randomBytes(32).toString("hex")}`;

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        webhookUrl,
        webhookSecretEncrypted: this.encryption.encrypt(webhookSecret),
        webhookConfiguredAt: new Date(),
      },
    });

    await this.auditLog.record({
      tenantId,
      actorType: "api_key",
      actorId: actorApiKeyId,
      action: "tenant.webhook_configured",
      metadata: { webhookUrl },
    });

    return { webhookUrl, webhookSecret };
  }

  async getMpesaCredentialsForPayment(tenantId: string): Promise<TenantMpesaCredentials> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    // Suspension is the platform's kill switch, and it was previously a no-op for
    // outbound payments: a suspended tenant's API keys are not revoked, so nothing
    // between ApiKeyGuard and Daraja stopped them from continuing to charge
    // customers. The inbound side already refuses to route money to a non-active
    // tenant (WebhookPollerService.processC2bConfirmation scopes its shortcode
    // lookup to status: "active"), so this closes the matching hole on the way out.
    // "removed" gets the same treatment as "suspended" — both are a full kill
    // switch on money movement. pending_kyc is deliberately still allowed — that's
    // the state a tenant tests from against Safaricom's sandbox before approval.
    if (tenant.status === "suspended" || tenant.status === "removed") {
      throw new ForbiddenException("This tenant is suspended and cannot initiate payments");
    }

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
   * Payout counterpart to getMpesaCredentialsForPayment. A separate method rather
   * than an optional-fields variant of that one, because the two need genuinely
   * different secrets: collections need the passkey and no initiator, payouts the
   * exact reverse. One union-shaped return would leave every caller re-checking
   * which half it actually received — and would decrypt a passkey the payout path
   * has no use for.
   */
  async getMpesaCredentialsForPayout(tenantId: string): Promise<TenantPayoutCredentials> {
    const tenant = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });

    // The same kill switch the collection path applies. A suspended (or removed)
    // tenant must not move money in EITHER direction, and outbound is the direction
    // where it matters more — suspension/removal often means exactly "we don't
    // trust this account right now."
    if (tenant.status === "suspended" || tenant.status === "removed") {
      throw new ForbiddenException("This tenant is suspended and cannot initiate payments");
    }

    if (!tenant.mpesaConsumerKey || !tenant.mpesaConsumerSecretEncrypted) {
      throw new ForbiddenException(
        "M-Pesa credentials aren't configured for this tenant yet — set them up before initiating payments",
      );
    }

    // Deliberately a different message from the one above. A tenant that has been
    // collecting successfully for months hits THIS branch the first time they try to
    // pay out, and telling them their "M-Pesa credentials aren't configured" would be
    // actively misleading — theirs plainly are. B2C initiator access is a separate
    // registration on Safaricom's side, not something the collection setup implies.
    if (!tenant.mpesaInitiatorName || !tenant.mpesaSecurityCredentialEncrypted) {
      throw new ForbiddenException(
        "B2C payout credentials aren't configured for this tenant yet — an initiator name and security " +
          "credential are required before sending payments",
      );
    }

    return {
      shortcode: tenant.businessShortcode,
      mpesaConsumerKey: tenant.mpesaConsumerKey,
      mpesaConsumerSecretEncrypted: this.encryption.decrypt(tenant.mpesaConsumerSecretEncrypted),
      initiatorName: tenant.mpesaInitiatorName,
      // Decrypts the AES layer only. What comes out is still Safaricom's
      // RSA-encrypted blob, which is exactly what the B2C request expects.
      securityCredential: this.encryption.decrypt(tenant.mpesaSecurityCredentialEncrypted),
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
   * "pending_kyc" for re-review, or removing/reinstating a tenant via "removed".
   * A TENANT_ADMIN may only toggle their OWN tenant between "active" and
   * "suspended" — self-service deactivation, not a path to self-approve out of
   * KYC review, remove/reinstate their own tenant, or touch another tenant's
   * status. "removed" behaves like "suspended" everywhere money moves (see
   * getMpesaCredentialsForPayment/Payout) but is platform-only in both
   * directions — see docs/decisions.md entry 19 for why this is a status flag
   * rather than a hard delete.
   */
  async updateStatus(tenantId: string, dto: UpdateTenantStatusDto, actor: AuthenticatedUser) {
    const before = await this.prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { status: true } });

    if (actor.role !== "SUPER_ADMIN") {
      if (actor.tenantId !== tenantId) {
        throw new ForbiddenException("Cannot change another tenant's status");
      }
      if (dto.status === "pending_kyc") {
        throw new ForbiddenException("Only platform staff can move a tenant into KYC review");
      }
      // "removed" is a platform-only kill switch in both directions — a TENANT_ADMIN
      // can neither remove their own tenant nor reinstate one already removed.
      if (dto.status === "removed" || before.status === "removed") {
        throw new ForbiddenException("Only platform staff can remove or reinstate a tenant");
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

    if (before.status !== "active" && dto.status === "active") {
      await this.provisionApiKeyOnActivation(tenantId);
    }

    return tenant;
  }

  /**
   * Auto-provisions the tenant's first API key the moment they go active, so a
   * merchant who only wants to accept payments never has to visit an API-key
   * page at all — see docs/decisions.md entry 14. Emailed once to every
   * TENANT_ADMIN on the account; the raw key is never shown again after this.
   * Best-effort: a failure here must never roll back — or even fail — the
   * status change itself, same "a side effect's failure is not the main
   * action's failure" reasoning as AlertsService.
   */
  private async provisionApiKeyOnActivation(tenantId: string) {
    try {
      const provisioned = await this.apiKeysService.provisionDefaultKeyIfNeeded(tenantId);
      if (!provisioned) return; // tenant already held a live key — nothing to do

      const admins = await this.prisma.user.findMany({
        where: { tenantId, role: "TENANT_ADMIN" },
        select: { email: true },
      });

      await Promise.all(
        admins.map((admin) => this.emailService.sendApiKeyProvisionedEmail(admin.email, provisioned.rawKey)),
      );
    } catch (error) {
      this.logger.error(`Failed to auto-provision an API key for tenant ${tenantId}`, error as Error);
    }
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
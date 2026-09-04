import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { EmailService } from "../auth/email.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import type { CreateTenantDto, UpdateTenantStatusDto } from "./tenant.dto";
import type { SetAppCredentialsDto } from "./tenants.schema";
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
    const tenant = await this.prisma.tenant.create({ data: { name: dto.name, status: "pending_kyc" } });
    await this.createInitialShortcode(tenant.id, dto.businessShortcode);

    await this.auditLog.record({
      tenantId: tenant.id,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.created",
      targetType: "Tenant",
      targetId: tenant.id,
      metadata: { name: tenant.name, businessShortcode: dto.businessShortcode },
    });

    return tenant;
  }

  /**
   * Onboarding's shortcode is created as a plain PAYBILL row with no credentials
   * yet — mirrors the pre-shortcode-split flow exactly, where `create`/`onboardSelf`
   * only ever recorded the number itself and a separate step (now
   * TenantShortcodesService.create/update) supplied the passkey and app
   * credentials. Deliberately a step AFTER the tenant row exists, not inside the
   * same transaction: TenantShortcode is RLS-scoped and needs `app.current_tenant_id`
   * set to this tenant's own (brand new) id, which withTenantContext can only do
   * once that id exists.
   */
  private async createInitialShortcode(tenantId: string, shortcode: string) {
    await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.tenantShortcode.create({
        data: { tenantId, type: "PAYBILL", shortcode, isDefault: true },
      }),
    );
  }

  /**
   * Sets the shared, org-level Daraja app credentials (Consumer Key/Secret) —
   * the counterpart to TenantShortcodesService managing everything shortcode-
   * specific. Split out of what used to be one setMpesaCredentials call because
   * these two now save to different tables (Tenant vs TenantShortcode).
   */
  async setAppCredentials(tenantId: string, dto: SetAppCredentialsDto, actor: AuthenticatedUser) {
    if (actor.tenantId !== tenantId && actor.role !== "SUPER_ADMIN") {
      throw new ForbiddenException("Cannot configure another tenant's credentials");
    }

    // Fail fast: confirm this consumer key/secret actually authenticate with Daraja
    // BEFORE persisting anything. Without this, a typo'd secret saves silently and
    // the tenant only discovers it at their first real payment — a much worse place
    // to find out. Throws BadGatewayException on rejection, which the controller lets
    // through as-is (same pattern as the payment paths).
    await this.daraja.verifyCredentials({
      mpesaConsumerKey: dto.consumerKey,
      mpesaConsumerSecretEncrypted: dto.consumerSecret,
    });

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        mpesaConsumerKey: dto.consumerKey,
        mpesaConsumerSecretEncrypted: this.encryption.encrypt(dto.consumerSecret),
        mpesaCredentialsConfiguredAt: new Date(),
      },
    });

    await this.auditLog.record({
      tenantId,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.app_credentials_configured",
    });

    return { configured: true };
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

    await this.notifyWebhookSecretRotated(tenantId, webhookUrl, webhookSecret);

    return { webhookUrl, webhookSecret };
  }

  /**
   * Mirrors provisionApiKeyOnActivation's notification pattern: tenant admins
   * get the raw secret (this endpoint is the only place a human on the tenant
   * side ever sees it — the caller here is an API key, not a dashboard user),
   * platform staff get a metadata-only notice. Best-effort — never fails the
   * webhook configuration itself.
   */
  private async notifyWebhookSecretRotated(tenantId: string, webhookUrl: string, webhookSecret: string) {
    try {
      // Run under this tenant's RLS context. These reads are on the RLS-enforced
      // connection and previously set no context at all, which is fine today (the
      // owner role is still exempt) and silently wrong the moment
      // 004_force_row_level_security.sql is applied: the `users` policy would match
      // nothing, `admins` would come back empty, and the tenant admin would never
      // receive the webhook secret — which is shown exactly once and is
      // unrecoverable afterwards. An empty result, not an error, is the whole
      // hazard here.
      //
      // One context covers both reads: the policy is
      // `tenantId IS NULL OR tenantId = current_setting(...)`, so SUPER_ADMIN rows
      // (tenantId null) still match while scoped to this tenant.
      const { tenant, admins, staff } = await this.prisma.withTenantContext(tenantId, async (tx) => {
        const [tenant, admins, staff] = await Promise.all([
          tx.tenant.findUnique({ where: { id: tenantId }, select: { name: true } }),
          tx.user.findMany({ where: { tenantId, role: "TENANT_ADMIN" }, select: { email: true } }),
          tx.user.findMany({ where: { role: "SUPER_ADMIN" }, select: { email: true } }),
        ]);
        return { tenant, admins, staff };
      });

      await Promise.all([
        ...admins.map((admin) =>
          this.emailService.sendWebhookSecretRotatedEmail(admin.email, webhookSecret, webhookUrl),
        ),
        ...staff.map((member) =>
          this.emailService.sendWebhookSecretStaffNotice(member.email, tenant?.name ?? tenantId, webhookUrl),
        ),
      ]);
    } catch (error) {
      this.logger.error(`Failed to notify tenant ${tenantId} of webhook secret rotation`, error as Error);
    }
  }

  /**
   * `type` picks which of the tenant's collection shortcodes to use, mirroring
   * InitiateStkPushDto.channel ("PAYBILL"/"TILL", default PAYBILL) — a tenant with
   * exactly one shortcode of that type never has to think about this; StkPushService
   * just passes dto.channel straight through.
   */
  async getMpesaCredentialsForPayment(
    tenantId: string,
    type: "PAYBILL" | "TILL" = "PAYBILL",
  ): Promise<TenantMpesaCredentials> {
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

    if (!tenant.mpesaConsumerKey || !tenant.mpesaConsumerSecretEncrypted) {
      throw new ForbiddenException(
        "M-Pesa credentials aren't configured for this tenant yet — set them up before initiating payments",
      );
    }

    const shortcode = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.tenantShortcode.findFirst({ where: { tenantId, type, isDefault: true } }),
    );
    if (!shortcode || !shortcode.mpesaPasskeyEncrypted) {
      throw new ForbiddenException(
        `No default ${type} shortcode with a passkey is configured for this tenant yet — set one up before initiating payments`,
      );
    }

    return {
      shortcode: shortcode.shortcode,
      mpesaConsumerKey: tenant.mpesaConsumerKey,
      mpesaConsumerSecretEncrypted: this.encryption.decrypt(tenant.mpesaConsumerSecretEncrypted),
      mpesaPasskeyEncrypted: this.encryption.decrypt(shortcode.mpesaPasskeyEncrypted),
    };
  }

  /**
   * Payout counterpart to getMpesaCredentialsForPayment. shortcodeId is required,
   * not defaulted — B2cService.initiate takes it straight from the caller
   * (InitiateB2cDto.shortcodeId): unlike collections, which shortcode pays out is
   * never an implicit choice, since it's the one moving money OUT of the tenant.
   */
  async getMpesaCredentialsForPayout(tenantId: string, shortcodeId: string): Promise<TenantPayoutCredentials> {
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

    const shortcode = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.tenantShortcode.findFirst({ where: { id: shortcodeId, tenantId, type: "B2C" } }),
    );
    if (!shortcode) {
      throw new NotFoundException("This B2C shortcode doesn't exist for this tenant");
    }

    // Deliberately a different message from the one above. A tenant that has been
    // collecting successfully for months hits THIS branch the first time they try to
    // pay out, and telling them their "M-Pesa credentials aren't configured" would be
    // actively misleading — theirs plainly are. B2C initiator access is a separate
    // registration on Safaricom's side, not something the collection setup implies.
    if (!shortcode.mpesaInitiatorName || !shortcode.mpesaSecurityCredentialEncrypted) {
      throw new ForbiddenException(
        "B2C payout credentials aren't configured for this shortcode yet — an initiator name and security " +
          "credential are required before sending payments",
      );
    }

    return {
      shortcode: shortcode.shortcode,
      mpesaConsumerKey: tenant.mpesaConsumerKey,
      mpesaConsumerSecretEncrypted: this.encryption.decrypt(tenant.mpesaConsumerSecretEncrypted),
      initiatorName: shortcode.mpesaInitiatorName,
      // Decrypts the AES layer only. What comes out is still Safaricom's
      // RSA-encrypted blob, which is exactly what the B2C request expects.
      securityCredential: this.encryption.decrypt(shortcode.mpesaSecurityCredentialEncrypted),
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
    // of leaving an orphaned Tenant nothing points to. The initial shortcode is
    // created just after, once the tenant id this race decided on is final — see
    // createInitialShortcode's own comment for why it can't join this transaction.
    const tenant = await this.prisma.$transaction(async (tx) => {
      const created = await tx.tenant.create({ data: { name: dto.name, status: "pending_kyc" } });

      const linked = await tx.user.updateMany({
        where: { id: actor.id, tenantId: null },
        data: { tenantId: created.id },
      });
      if (linked.count !== 1) {
        throw new ConflictException("Account is already associated with a tenant");
      }

      return created;
    });
    await this.createInitialShortcode(tenant.id, dto.businessShortcode);

    await this.auditLog.record({
      tenantId: tenant.id,
      actorType: "user",
      actorId: actor.id,
      action: "tenant.onboarded_self",
      targetType: "Tenant",
      targetId: tenant.id,
      metadata: { name: tenant.name, businessShortcode: dto.businessShortcode },
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

      // A tenant admin's self-service is pausing and resuming an ALREADY-APPROVED
      // tenant, nothing more. Both the current status and the target must be one of
      // these — checking only the target was the bug: `pending_kyc -> active` passed
      // every guard, so a self-registered admin could approve their own KYC and, via
      // provisionApiKeyOnActivation below, have a live API key emailed to them.
      //
      // Gating on `before.status` too is what closes it properly. Rejecting only
      // `pending_kyc -> active` would have left `pending_kyc -> suspended -> active`
      // open, since the second hop starts from a status this rule permits — the same
      // self-approval in two requests.
      const SELF_SERVICE_STATUSES = ["active", "suspended"];

      if (before.status === "removed" || dto.status === "removed") {
        // Unchanged: "removed" is a platform-only kill switch in both directions.
        throw new ForbiddenException("Only platform staff can remove or reinstate a tenant");
      }
      if (!SELF_SERVICE_STATUSES.includes(before.status)) {
        throw new ForbiddenException(
          "Only platform staff can change the status of a tenant that is still in KYC review",
        );
      }
      if (!SELF_SERVICE_STATUSES.includes(dto.status)) {
        throw new ForbiddenException("Only platform staff can move a tenant into KYC review");
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

      // Same RLS-context reasoning as notifyWebhookSecretRotated above: without it,
      // this read returns zero admins once FORCE lands, and the one-time API key
      // provisioned just above is never delivered to anyone.
      const admins = await this.prisma.withTenantContext(tenantId, (tx) =>
        tx.user.findMany({
          where: { tenantId, role: "TENANT_ADMIN" },
          select: { email: true },
        }),
      );

      await Promise.all(
        admins.map((admin) => this.emailService.sendApiKeyProvisionedEmail(admin.email, provisioned.rawKey)),
      );
    } catch (error) {
      this.logger.error(`Failed to auto-provision an API key for tenant ${tenantId}`, error as Error);
    }
  }

  /**
   * The unique constraint that can fire here now comes from the
   * tenants_activation_shortcode_uniqueness trigger (manual-sql/003_tenant_shortcodes.sql),
   * raised with ERRCODE unique_violation the same way a real index would be — fired
   * specifically by THIS update, when moving a tenant to "active" collides with
   * another active tenant already holding one of its shortcodes. pending_kyc tenants
   * may still share Safaricom's sandbox shortcode freely; this only ever surfaces
   * once a shortcode collides with another tenant that's actually live.
   */
  private async rejectingShortcodeConflict<T>(op: Promise<T>): Promise<T> {
    try {
      return await op;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new ConflictException("A shortcode on this tenant is already in use by another active tenant");
      }
      throw error;
    }
  }
}

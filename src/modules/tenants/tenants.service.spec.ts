import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { TenantsService } from "./tenants.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { CredentialsEncryptionService } from "./credentials-encryption.service";
import { ApiKeysService } from "../api-keys/api-keys.service";
import { EmailService } from "../auth/email.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function uniqueConstraintError(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
  });
}

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

describe("TenantsService", () => {
  let service: TenantsService;
  let prisma: PrismaService;
  let auditLog: AuditLogService;
  let encryption: CredentialsEncryptionService;
  let apiKeysService: ApiKeysService;
  let emailService: EmailService;
  let daraja: DarajaClient;

  beforeEach(async () => {
    const prismaMock: any = {
      tenant: {
        create: jest.fn(),
        update: jest.fn(),
        findUnique: jest.fn(),
        // Default covers updateStatus's pre-update "before" read for every test that
        // doesn't care about it — only the "auto-provisioning on activation" tests
        // below override this per-call to exercise a real status transition.
        findUniqueOrThrow: jest.fn().mockResolvedValue({ status: "pending_kyc" }),
        findMany: jest.fn(),
      },
      tenantShortcode: {
        create: jest.fn().mockResolvedValue({ id: "shortcode-1" }),
        findFirst: jest.fn(),
      },
      // Defaulted empty so tests that don't care about webhook/API-key notification
      // content (most of them) don't have to stub every lookup individually — only
      // the notification-focused tests below override this per-call.
      user: { update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    };
    // onboardSelf runs tenant.create + user.updateMany inside $transaction — mirror
    // that by running the callback against this same mock instead of a real transaction,
    // so tests can drive tenant.create/user.updateMany exactly as before.
    prismaMock.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prismaMock));
    // withTenantContext is used for every TenantShortcode read/write (RLS-scoped) —
    // mirrors the real PrismaService signature but runs the callback against this
    // same mock instead of a real transaction.
    prismaMock.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(prismaMock));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: CredentialsEncryptionService, useValue: { encrypt: jest.fn(), decrypt: jest.fn() } },
        { provide: ApiKeysService, useValue: { provisionDefaultKeyIfNeeded: jest.fn() } },
        {
          provide: EmailService,
          useValue: {
            sendApiKeyProvisionedEmail: jest.fn(),
            sendWebhookSecretRotatedEmail: jest.fn(),
            sendWebhookSecretStaffNotice: jest.fn(),
          },
        },
        {
          provide: DarajaClient,
          useValue: {
            verifyCredentials: jest.fn().mockResolvedValue(undefined),
            registerC2bUrl: jest.fn().mockResolvedValue(undefined),
          },
        },
      ],
    }).compile();

    service = module.get(TenantsService);
    prisma = module.get(PrismaService);
    auditLog = module.get(AuditLogService);
    encryption = module.get(CredentialsEncryptionService);
    apiKeysService = module.get(ApiKeysService);
    emailService = module.get(EmailService);
    daraja = module.get(DarajaClient);
  });

  describe("setAppCredentials", () => {
    const dto = { consumerKey: "ck", consumerSecret: "cs" };

    it("forbids a TENANT_ADMIN from configuring another tenant's credentials", async () => {
      await expect(
        service.setAppCredentials("other-tenant", dto, user({ tenantId: "tenant-1" })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it("allows SUPER_ADMIN to configure any tenant's credentials", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      await service.setAppCredentials("other-tenant", dto, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(prisma.tenant.update).toHaveBeenCalled();
    });

    it("encrypts consumerSecret before persisting, and never returns it", async () => {
      jest.spyOn(encryption, "encrypt").mockImplementation((v) => `encrypted(${v})`);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      const result = await service.setAppCredentials("tenant-1", dto, user());

      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ mpesaConsumerSecretEncrypted: "encrypted(cs)" }),
        }),
      );
      expect(result).toEqual({ configured: true });
      expect(JSON.stringify(result)).not.toContain("cs");
    });

    it("verifies the consumer key/secret against Daraja before persisting anything", async () => {
      jest.spyOn(daraja, "verifyCredentials").mockRejectedValueOnce(new Error("bad credentials"));

      await expect(service.setAppCredentials("tenant-1", dto, user())).rejects.toThrow("bad credentials");
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });
  });

  describe("configureWebhook", () => {
    it("generates a secret, encrypts it before persisting, and returns the raw secret exactly once", async () => {
      jest.spyOn(encryption, "encrypt").mockImplementation((v) => `encrypted(${v})`);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      const result = await service.configureWebhook("tenant-1", "https://example.com/webhooks/scriptpay", "key-1");

      expect(prisma.tenant.update).toHaveBeenCalledWith({
        where: { id: "tenant-1" },
        data: {
          webhookUrl: "https://example.com/webhooks/scriptpay",
          webhookSecretEncrypted: expect.stringMatching(/^encrypted\(whsec_[0-9a-f]{64}\)$/),
          webhookConfiguredAt: expect.any(Date),
        },
      });
      expect(result.webhookUrl).toBe("https://example.com/webhooks/scriptpay");
      expect(result.webhookSecret).toMatch(/^whsec_[0-9a-f]{64}$/);
    });

    it("audit-logs the configuring API key as the actor, not a user", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      await service.configureWebhook("tenant-1", "https://example.com/webhooks/scriptpay", "key-1");

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: "tenant-1",
          actorType: "api_key",
          actorId: "key-1",
          action: "tenant.webhook_configured",
        }),
      );
    });

    it("emails the raw secret to every TENANT_ADMIN and a metadata-only notice to every SUPER_ADMIN", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);
      jest.spyOn(prisma.tenant, "findUnique").mockResolvedValueOnce({ name: "ScriptTagg" } as any);
      jest
        .spyOn(prisma.user, "findMany")
        .mockResolvedValueOnce([{ email: "admin@scripttagg.test" }] as any) // TENANT_ADMIN
        .mockResolvedValueOnce([{ email: "staff@scriptpay.test" }] as any); // SUPER_ADMIN

      const result = await service.configureWebhook(
        "tenant-1",
        "https://example.com/webhooks/scriptpay",
        "key-1",
      );

      expect(emailService.sendWebhookSecretRotatedEmail).toHaveBeenCalledWith(
        "admin@scripttagg.test",
        result.webhookSecret,
        "https://example.com/webhooks/scriptpay",
      );
      expect(emailService.sendWebhookSecretStaffNotice).toHaveBeenCalledWith(
        "staff@scriptpay.test",
        "ScriptTagg",
        "https://example.com/webhooks/scriptpay",
      );
      const staffCallArgs = (emailService.sendWebhookSecretStaffNotice as jest.Mock).mock.calls[0];
      expect(JSON.stringify(staffCallArgs)).not.toContain(result.webhookSecret);
    });

    it("does not let a notification failure surface as a webhook-configuration failure", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);
      jest.spyOn(prisma.user, "findMany").mockRejectedValueOnce(new Error("db down"));

      await expect(
        service.configureWebhook("tenant-1", "https://example.com/webhooks/scriptpay", "key-1"),
      ).resolves.toEqual(expect.objectContaining({ webhookUrl: "https://example.com/webhooks/scriptpay" }));
    });
  });

  describe("getMpesaCredentialsForPayment", () => {
    function mockTenant(overrides: Record<string, unknown> = {}) {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({
        status: "active",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "enc-cs",
        ...overrides,
      } as any);
    }

    it("throws when app credentials are not yet configured", async () => {
      mockTenant({ mpesaConsumerKey: null, mpesaConsumerSecretEncrypted: null });

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).rejects.toThrow(ForbiddenException);
    });

    it("throws when the tenant has no default shortcode of the requested type", async () => {
      mockTenant();
      jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce(null);

      await expect(service.getMpesaCredentialsForPayment("tenant-1", "PAYBILL")).rejects.toThrow(ForbiddenException);
    });

    it("looks up the default shortcode of the given type, decrypts, and returns credentials", async () => {
      mockTenant();
      jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce({
        shortcode: "174379",
        mpesaPasskeyEncrypted: "enc-pk",
      } as any);
      jest.spyOn(encryption, "decrypt").mockImplementation((v) => v.replace("enc-", "plain-"));

      const result = await service.getMpesaCredentialsForPayment("tenant-1", "PAYBILL");

      expect(prisma.tenantShortcode.findFirst).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", type: "PAYBILL", isDefault: true },
      });
      expect(result).toEqual({
        shortcode: "174379",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "plain-cs",
        mpesaPasskeyEncrypted: "plain-pk",
      });
    });

    it("defaults to PAYBILL when no type is given", async () => {
      mockTenant();
      jest
        .spyOn(prisma.tenantShortcode, "findFirst")
        .mockResolvedValueOnce({ shortcode: "174379", mpesaPasskeyEncrypted: "enc-pk" } as any);

      await service.getMpesaCredentialsForPayment("tenant-1");

      expect(prisma.tenantShortcode.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ type: "PAYBILL" }) }),
      );
    });

    it("refuses to hand out credentials for a suspended tenant, even with everything configured", async () => {
      // Suspending a tenant does not revoke their API keys, so without this check
      // nothing between ApiKeyGuard and Daraja stopped a suspended merchant from
      // continuing to charge customers.
      mockTenant({ status: "suspended" });

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).rejects.toThrow(ForbiddenException);
      expect(prisma.tenantShortcode.findFirst).not.toHaveBeenCalled();
    });

    it("refuses to hand out credentials for a removed tenant, same as a suspended one", async () => {
      mockTenant({ status: "removed" });

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).rejects.toThrow(ForbiddenException);
      expect(prisma.tenantShortcode.findFirst).not.toHaveBeenCalled();
    });

    it("still allows a pending_kyc tenant to transact, so they can test against the sandbox", async () => {
      mockTenant({ status: "pending_kyc" });
      jest
        .spyOn(prisma.tenantShortcode, "findFirst")
        .mockResolvedValueOnce({ shortcode: "174379", mpesaPasskeyEncrypted: "enc-pk" } as any);
      jest.spyOn(encryption, "decrypt").mockImplementation((v) => v.replace("enc-", "plain-"));

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).resolves.toMatchObject({
        mpesaConsumerKey: "ck",
      });
    });
  });

  describe("getMpesaCredentialsForPayout", () => {
    function mockTenant(overrides: Record<string, unknown> = {}) {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({
        status: "active",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "enc-cs",
        ...overrides,
      } as any);
    }

    it("throws NotFoundException when the shortcode doesn't belong to this tenant or isn't type B2C", async () => {
      mockTenant();
      jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce(null);

      await expect(service.getMpesaCredentialsForPayout("tenant-1", "sc-1")).rejects.toThrow(NotFoundException);
    });

    it("throws when the B2C shortcode has no initiator/security credential configured", async () => {
      mockTenant();
      jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce({
        shortcode: "600000",
        mpesaInitiatorName: null,
        mpesaSecurityCredentialEncrypted: null,
      } as any);

      await expect(service.getMpesaCredentialsForPayout("tenant-1", "sc-1")).rejects.toThrow(ForbiddenException);
    });

    it("decrypts and returns payout credentials for the named B2C shortcode", async () => {
      mockTenant();
      jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce({
        shortcode: "600000",
        mpesaInitiatorName: "testapi",
        mpesaSecurityCredentialEncrypted: "enc-sec",
      } as any);
      jest.spyOn(encryption, "decrypt").mockImplementation((v) => v.replace("enc-", "plain-"));

      const result = await service.getMpesaCredentialsForPayout("tenant-1", "sc-1");

      expect(prisma.tenantShortcode.findFirst).toHaveBeenCalledWith({
        where: { id: "sc-1", tenantId: "tenant-1", type: "B2C" },
      });
      expect(result).toEqual({
        shortcode: "600000",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "plain-cs",
        initiatorName: "testapi",
        securityCredential: "plain-sec",
      });
    });

    it("refuses to hand out payout credentials for a suspended tenant", async () => {
      mockTenant({ status: "suspended" });

      await expect(service.getMpesaCredentialsForPayout("tenant-1", "sc-1")).rejects.toThrow(ForbiddenException);
      expect(prisma.tenantShortcode.findFirst).not.toHaveBeenCalled();
    });
  });

  describe("findOne", () => {
    it("forbids a TENANT_ADMIN from reading another tenant's record", async () => {
      await expect(service.findOne("other-tenant", user({ tenantId: "tenant-1" }))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("lets a TENANT_ADMIN read their own tenant", async () => {
      jest.spyOn(prisma.tenant, "findUnique").mockResolvedValueOnce({ id: "tenant-1" } as any);

      const result = await service.findOne("tenant-1", user({ tenantId: "tenant-1" }));

      expect(result).toEqual({ id: "tenant-1" });
    });

    it("throws NotFoundException when the tenant does not exist", async () => {
      jest.spyOn(prisma.tenant, "findUnique").mockResolvedValueOnce(null);

      await expect(service.findOne("tenant-1", user({ tenantId: "tenant-1" }))).rejects.toThrow(NotFoundException);
    });

    it("lets SUPER_ADMIN read any tenant", async () => {
      jest.spyOn(prisma.tenant, "findUnique").mockResolvedValueOnce({ id: "other-tenant" } as any);

      const result = await service.findOne("other-tenant", user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(result).toEqual({ id: "other-tenant" });
    });
  });

  describe("create", () => {
    const dto = { name: "Acme", businessShortcode: "174379" };

    it("creates the tenant and an initial default PAYBILL shortcode", async () => {
      jest.spyOn(prisma.tenant, "create").mockResolvedValueOnce({ id: "tenant-new", name: "Acme" } as any);

      const result = await service.create(dto, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(prisma.tenant.create).toHaveBeenCalledWith({ data: { name: "Acme", status: "pending_kyc" } });
      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-new", expect.any(Function));
      expect(prisma.tenantShortcode.create).toHaveBeenCalledWith({
        data: { tenantId: "tenant-new", type: "PAYBILL", shortcode: "174379", isDefault: true },
      });
      expect(result.id).toBe("tenant-new");
    });
  });

  describe("onboardSelf", () => {
    const dto = { name: "Acme", businessShortcode: "174379" };

    it("forbids onboarding when the account already has a tenant", async () => {
      await expect(service.onboardSelf(dto, user({ tenantId: "tenant-1" }))).rejects.toThrow(ForbiddenException);
      expect(prisma.tenant.create).not.toHaveBeenCalled();
    });

    it("forbids onboarding by a non-TENANT_ADMIN role", async () => {
      await expect(
        service.onboardSelf(dto, user({ role: "TENANT_STAFF", tenantId: null })),
      ).rejects.toThrow(ForbiddenException);
    });

    it("creates the tenant, attaches it to the caller's own account, and creates the initial shortcode", async () => {
      jest.spyOn(prisma.tenant, "create").mockResolvedValueOnce({ id: "tenant-new", name: "Acme" } as any);
      jest.spyOn(prisma.user, "updateMany").mockResolvedValueOnce({ count: 1 });

      const result = await service.onboardSelf(dto, user({ tenantId: null, role: "TENANT_ADMIN" }));

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "u-1", tenantId: null },
        data: { tenantId: "tenant-new" },
      });
      expect(prisma.tenantShortcode.create).toHaveBeenCalledWith({
        data: { tenantId: "tenant-new", type: "PAYBILL", shortcode: "174379", isDefault: true },
      });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.onboarded_self" }));
      expect(result.id).toBe("tenant-new");
    });

    it("rejects a double-submit that races the tenantId:null check, instead of creating an orphaned tenant", async () => {
      // Both requests read the same stale actor.tenantId: null from the JWT and pass
      // the forbidden-check above — this simulates the loser of that race: by the time
      // its user.updateMany runs, the winner has already claimed the account, so the
      // conditional WHERE tenantId: null matches nothing.
      jest.spyOn(prisma.tenant, "create").mockResolvedValueOnce({ id: "tenant-orphan", name: "Acme" } as any);
      jest.spyOn(prisma.user, "updateMany").mockResolvedValueOnce({ count: 0 });

      await expect(service.onboardSelf(dto, user({ tenantId: null, role: "TENANT_ADMIN" }))).rejects.toThrow(
        "Account is already associated with a tenant",
      );

      // Both writes happened inside the same $transaction — in a real database this
      // throw rolls the tenant.create back with it, rather than leaving it orphaned.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(prisma.tenantShortcode.create).not.toHaveBeenCalled();
      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });

  describe("updateStatus", () => {
    it("lets SUPER_ADMIN move any tenant into pending_kyc", async () => {
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "other-tenant", status: "pending_kyc" } as any);

      await service.updateStatus(
        "other-tenant",
        { status: "pending_kyc" },
        user({ role: "SUPER_ADMIN", tenantId: null }),
      );

      expect(prisma.tenant.update).toHaveBeenCalled();
    });

    it("forbids a TENANT_ADMIN from changing another tenant's status", async () => {
      await expect(
        service.updateStatus("other-tenant", { status: "suspended" }, user({ tenantId: "tenant-1" })),
      ).rejects.toThrow(ForbiddenException);
    });

    it("forbids a TENANT_ADMIN from self-approving out of KYC review", async () => {
      await expect(
        service.updateStatus("tenant-1", { status: "pending_kyc" }, user({ tenantId: "tenant-1" })),
      ).rejects.toThrow("Only platform staff can move a tenant into KYC review");
    });

    it("lets a TENANT_ADMIN suspend their own tenant", async () => {
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "suspended" } as any);

      const result = await service.updateStatus("tenant-1", { status: "suspended" }, user({ tenantId: "tenant-1" }));

      expect(result.status).toBe("suspended");
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.status_changed" }));
    });

    it("turns a shortcode collision into a clear 409 when activating a tenant onto an already-claimed shortcode", async () => {
      // In a real database this comes from the tenants_activation_shortcode_uniqueness
      // trigger (manual-sql/003_tenant_shortcodes.sql), surfaced by Prisma as the same
      // P2002 a native unique index would raise.
      jest.spyOn(prisma.tenant, "update").mockRejectedValueOnce(uniqueConstraintError());

      await expect(
        service.updateStatus("tenant-1", { status: "active" }, user({ role: "SUPER_ADMIN", tenantId: null })),
      ).rejects.toThrow(ConflictException);
    });

    it("lets SUPER_ADMIN remove a tenant", async () => {
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "removed" } as any);

      const result = await service.updateStatus(
        "tenant-1",
        { status: "removed" },
        user({ role: "SUPER_ADMIN", tenantId: null }),
      );

      expect(result.status).toBe("removed");
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "tenant.status_changed", metadata: { newStatus: "removed" } }),
      );
    });

    it("forbids a TENANT_ADMIN from removing their own tenant", async () => {
      await expect(
        service.updateStatus("tenant-1", { status: "removed" }, user({ tenantId: "tenant-1" })),
      ).rejects.toThrow("Only platform staff can remove or reinstate a tenant");
    });

    it("forbids a TENANT_ADMIN from reinstating their own tenant once removed", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "removed" } as any);

      await expect(
        service.updateStatus("tenant-1", { status: "active" }, user({ tenantId: "tenant-1" })),
      ).rejects.toThrow("Only platform staff can remove or reinstate a tenant");
    });

    it("lets SUPER_ADMIN reinstate a removed tenant back to active", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "removed" } as any);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "active" } as any);

      const result = await service.updateStatus(
        "tenant-1",
        { status: "active" },
        user({ role: "SUPER_ADMIN", tenantId: null }),
      );

      expect(result.status).toBe("active");
    });
  });

  describe("updateStatus — API key auto-provisioning on activation", () => {
    it("provisions a default key and emails every TENANT_ADMIN when a tenant transitions into active", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "pending_kyc" } as any);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "active" } as any);
      jest
        .spyOn(apiKeysService, "provisionDefaultKeyIfNeeded")
        .mockResolvedValueOnce({ id: "key-1", rawKey: "sp_rawvalue", keyPrefix: "sp_rawva", scopes: [] });
      jest
        .spyOn(prisma.user, "findMany")
        .mockResolvedValueOnce([{ email: "owner@tenant1.test" }, { email: "second-admin@tenant1.test" }] as any);

      await service.updateStatus("tenant-1", { status: "active" }, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(apiKeysService.provisionDefaultKeyIfNeeded).toHaveBeenCalledWith("tenant-1");
      expect(prisma.user.findMany).toHaveBeenCalledWith({
        where: { tenantId: "tenant-1", role: "TENANT_ADMIN" },
        select: { email: true },
      });
      expect(emailService.sendApiKeyProvisionedEmail).toHaveBeenCalledWith("owner@tenant1.test", "sp_rawvalue");
      expect(emailService.sendApiKeyProvisionedEmail).toHaveBeenCalledWith(
        "second-admin@tenant1.test",
        "sp_rawvalue",
      );
    });

    it("does not email anyone when the tenant already held a live key (idempotent re-activation)", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "suspended" } as any);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "active" } as any);
      jest.spyOn(apiKeysService, "provisionDefaultKeyIfNeeded").mockResolvedValueOnce(null);

      await service.updateStatus("tenant-1", { status: "active" }, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(emailService.sendApiKeyProvisionedEmail).not.toHaveBeenCalled();
    });

    it("does not provision anything when the tenant was already active (no real transition)", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "active" } as any);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "active" } as any);

      await service.updateStatus("tenant-1", { status: "active" }, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(apiKeysService.provisionDefaultKeyIfNeeded).not.toHaveBeenCalled();
    });

    it("does not provision anything when moving to a non-active status", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "active" } as any);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "suspended" } as any);

      await service.updateStatus("tenant-1", { status: "suspended" }, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(apiKeysService.provisionDefaultKeyIfNeeded).not.toHaveBeenCalled();
    });

    it("swallows a provisioning failure without failing the status change itself", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({ status: "pending_kyc" } as any);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({ id: "tenant-1", status: "active" } as any);
      jest.spyOn(apiKeysService, "provisionDefaultKeyIfNeeded").mockRejectedValueOnce(new Error("db down"));

      const result = await service.updateStatus(
        "tenant-1",
        { status: "active" },
        user({ role: "SUPER_ADMIN", tenantId: null }),
      );

      expect(result.status).toBe("active");
    });
  });
});

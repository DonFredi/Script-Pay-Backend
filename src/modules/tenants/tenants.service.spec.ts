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
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed on the fields: (`businessShortcode`)", {
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
      user: { update: jest.fn(), updateMany: jest.fn(), findMany: jest.fn() },
    };
    // onboardSelf runs tenant.create + user.updateMany inside $transaction — mirror
    // that by running the callback against this same mock instead of a real transaction,
    // so tests can drive tenant.create/user.updateMany exactly as before.
    prismaMock.$transaction = jest.fn((fn: (tx: unknown) => unknown) => fn(prismaMock));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantsService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: CredentialsEncryptionService, useValue: { encrypt: jest.fn(), decrypt: jest.fn() } },
        { provide: ApiKeysService, useValue: { provisionDefaultKeyIfNeeded: jest.fn() } },
        { provide: EmailService, useValue: { sendApiKeyProvisionedEmail: jest.fn() } },
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

  describe("setMpesaCredentials", () => {
    const dto = { businessShortcode: "174379", consumerKey: "ck", consumerSecret: "cs", passkey: "pk" };

    it("forbids a TENANT_ADMIN from configuring another tenant's credentials", async () => {
      await expect(
        service.setMpesaCredentials("other-tenant", dto, user({ tenantId: "tenant-1" })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it("allows SUPER_ADMIN to configure any tenant's credentials", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      await service.setMpesaCredentials("other-tenant", dto, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(prisma.tenant.update).toHaveBeenCalled();
    });

    it("encrypts consumerSecret and passkey before persisting, and never returns them", async () => {
      jest.spyOn(encryption, "encrypt").mockImplementation((v) => `encrypted(${v})`);
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      const result = await service.setMpesaCredentials("tenant-1", dto, user());

      expect(prisma.tenant.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            mpesaConsumerSecretEncrypted: "encrypted(cs)",
            mpesaPasskeyEncrypted: "encrypted(pk)",
          }),
        }),
      );
      expect(result).toEqual({ configured: true, c2bUrlRegistered: true });
      expect(JSON.stringify(result)).not.toContain("cs");
      expect(JSON.stringify(result)).not.toContain("pk");
    });

    it("verifies the consumer key/secret against Daraja before persisting anything", async () => {
      jest.spyOn(daraja, "verifyCredentials").mockRejectedValueOnce(new Error("bad credentials"));

      await expect(service.setMpesaCredentials("tenant-1", dto, user())).rejects.toThrow("bad credentials");
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    });

    it("auto-registers the C2B confirmation URL for the shortcode after saving", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);

      await service.setMpesaCredentials("tenant-1", dto, user());

      expect(daraja.registerC2bUrl).toHaveBeenCalledWith({
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "cs",
        shortcode: "174379",
      });
    });

    it("saves credentials successfully even when C2B URL registration fails, and reports it in the result", async () => {
      jest.spyOn(encryption, "encrypt").mockReturnValue("enc-value");
      jest.spyOn(prisma.tenant, "update").mockResolvedValueOnce({} as any);
      jest.spyOn(daraja, "registerC2bUrl").mockRejectedValueOnce(new Error("Daraja rejected C2B URL registration"));

      const result = await service.setMpesaCredentials("tenant-1", dto, user());

      expect(result).toEqual({ configured: true, c2bUrlRegistered: false });
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "daraja.c2b_url_registration_failed" }),
      );
    });

    it("turns a shortcode collision with another active tenant into a clear 409, not a raw DB error", async () => {
      jest.spyOn(prisma.tenant, "update").mockRejectedValueOnce(uniqueConstraintError());

      await expect(service.setMpesaCredentials("tenant-1", dto, user())).rejects.toThrow(ConflictException);
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
  });

  describe("getMpesaCredentialsForPayment", () => {
    it("throws when credentials are not yet configured", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({
        businessShortcode: "174379",
        mpesaConsumerKey: null,
        mpesaConsumerSecretEncrypted: null,
        mpesaPasskeyEncrypted: null,
      } as any);

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).rejects.toThrow(ForbiddenException);
    });

    it("decrypts and returns credentials when configured", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({
        businessShortcode: "174379",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "enc-cs",
        mpesaPasskeyEncrypted: "enc-pk",
      } as any);
      jest.spyOn(encryption, "decrypt").mockImplementation((v) => v.replace("enc-", "plain-"));

      const result = await service.getMpesaCredentialsForPayment("tenant-1");

      expect(result).toEqual({
        shortcode: "174379",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "plain-cs",
        mpesaPasskeyEncrypted: "plain-pk",
      });
    });

    it("refuses to hand out credentials for a suspended tenant, even with everything configured", async () => {
      // Suspending a tenant does not revoke their API keys, so without this check
      // nothing between ApiKeyGuard and Daraja stopped a suspended merchant from
      // continuing to charge customers.
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({
        status: "suspended",
        businessShortcode: "174379",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "enc-cs",
        mpesaPasskeyEncrypted: "enc-pk",
      } as any);

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).rejects.toThrow(ForbiddenException);
      expect(encryption.decrypt).not.toHaveBeenCalled();
    });

    it("still allows a pending_kyc tenant to transact, so they can test against the sandbox", async () => {
      jest.spyOn(prisma.tenant, "findUniqueOrThrow").mockResolvedValueOnce({
        status: "pending_kyc",
        businessShortcode: "174379",
        mpesaConsumerKey: "ck",
        mpesaConsumerSecretEncrypted: "enc-cs",
        mpesaPasskeyEncrypted: "enc-pk",
      } as any);
      jest.spyOn(encryption, "decrypt").mockImplementation((v) => v.replace("enc-", "plain-"));

      await expect(service.getMpesaCredentialsForPayment("tenant-1")).resolves.toMatchObject({
        mpesaConsumerKey: "ck",
      });
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

    it("creates the tenant and attaches it to the caller's own account", async () => {
      jest.spyOn(prisma.tenant, "create").mockResolvedValueOnce({ id: "tenant-new", ...dto } as any);
      jest.spyOn(prisma.user, "updateMany").mockResolvedValueOnce({ count: 1 });

      const result = await service.onboardSelf(dto, user({ tenantId: null, role: "TENANT_ADMIN" }));

      expect(prisma.user.updateMany).toHaveBeenCalledWith({
        where: { id: "u-1", tenantId: null },
        data: { tenantId: "tenant-new" },
      });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "tenant.onboarded_self" }));
      expect(result.id).toBe("tenant-new");
    });

    it("rejects a double-submit that races the tenantId:null check, instead of creating an orphaned tenant", async () => {
      // Both requests read the same stale actor.tenantId: null from the JWT and pass
      // the forbidden-check above — this simulates the loser of that race: by the time
      // its user.updateMany runs, the winner has already claimed the account, so the
      // conditional WHERE tenantId: null matches nothing.
      jest.spyOn(prisma.tenant, "create").mockResolvedValueOnce({ id: "tenant-orphan", ...dto } as any);
      jest.spyOn(prisma.user, "updateMany").mockResolvedValueOnce({ count: 0 });

      await expect(service.onboardSelf(dto, user({ tenantId: null, role: "TENANT_ADMIN" }))).rejects.toThrow(
        "Account is already associated with a tenant",
      );

      // Both writes happened inside the same $transaction — in a real database this
      // throw rolls the tenant.create back with it, rather than leaving it orphaned.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
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
      jest.spyOn(prisma.tenant, "update").mockRejectedValueOnce(uniqueConstraintError());

      await expect(
        service.updateStatus("tenant-1", { status: "active" }, user({ role: "SUPER_ADMIN", tenantId: null })),
      ).rejects.toThrow(ConflictException);
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

import { Test, TestingModule } from "@nestjs/testing";
import { BadGatewayException, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { TenantShortcodesService } from "./tenant-shortcodes.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { CredentialsEncryptionService } from "./credentials-encryption.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

/**
 * Covers registerC2bUrl only. The rest of this service is exercised through the
 * controller and the existing tenants tests; this operation is new and is the one
 * with real consequences — it is what points Safaricom at a different host.
 */

const user = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  id: "user-1",
  email: "a@b.test",
  role: "TENANT_ADMIN",
  tenantId: "tenant-1",
  ...over,
});

const CONFIGURED_TENANT = {
  id: "tenant-1",
  mpesaConsumerKey: "ck-1",
  mpesaConsumerSecretEncrypted: "enc-secret",
};

const PAYBILL = {
  id: "sc-1",
  tenantId: "tenant-1",
  type: "PAYBILL",
  shortcode: "174379",
};

describe("TenantShortcodesService.registerC2bUrl", () => {
  let service: TenantShortcodesService;
  let prisma: any;
  let daraja: { registerC2bUrl: jest.Mock; verifyCredentials: jest.Mock };
  let auditLog: { record: jest.Mock };

  beforeEach(async () => {
    const tx = { tenantShortcode: { findFirst: jest.fn().mockResolvedValue(PAYBILL) } };
    prisma = {
      tenant: { findUniqueOrThrow: jest.fn().mockResolvedValue(CONFIGURED_TENANT) },
      withTenantContext: jest.fn((_id: string, fn: (t: unknown) => unknown) => fn(tx)),
      __tx: tx,
    };
    daraja = { registerC2bUrl: jest.fn().mockResolvedValue(undefined), verifyCredentials: jest.fn() };
    auditLog = { record: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantShortcodesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DarajaClient, useValue: daraja },
        { provide: AuditLogService, useValue: auditLog },
        { provide: CredentialsEncryptionService, useValue: { decrypt: (v: string) => `dec(${v})`, encrypt: (v: string) => v } },
      ],
    }).compile();

    service = module.get(TenantShortcodesService);
  });

  it("re-sends the shortcode to Daraja with the tenant's decrypted credentials", async () => {
    const result = await service.registerC2bUrl("tenant-1", "sc-1", user());

    expect(daraja.registerC2bUrl).toHaveBeenCalledWith({
      mpesaConsumerKey: "ck-1",
      mpesaConsumerSecretEncrypted: "dec(enc-secret)",
      shortcode: "174379",
    });
    expect(result).toEqual({ registered: true, shortcode: "174379", type: "PAYBILL" });
  });

  it("records an audit entry naming the shortcode", async () => {
    await service.registerC2bUrl("tenant-1", "sc-1", user());

    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        action: "daraja.c2b_url_registered",
        targetId: "sc-1",
      }),
    );
  });

  // The whole point of the endpoint is to learn whether Safaricom accepted the new
  // URLs. create() swallows this failure deliberately — losing a best-effort
  // registration must not roll back saving the shortcode — but reporting success
  // here would leave the caller believing callbacks are fixed when they are not.
  it("propagates a Daraja rejection instead of reporting success", async () => {
    daraja.registerC2bUrl.mockRejectedValueOnce(new BadGatewayException("Invalid Initiator Information"));

    await expect(service.registerC2bUrl("tenant-1", "sc-1", user())).rejects.toThrow(BadGatewayException);
    expect(auditLog.record).not.toHaveBeenCalled();
  });

  // A B2C shortcode's ResultURL travels with each payout request, so there is
  // nothing stored at Safaricom to re-register.
  it("rejects a B2C shortcode without calling Daraja", async () => {
    prisma.__tx.tenantShortcode.findFirst.mockResolvedValueOnce({ ...PAYBILL, type: "B2C" });

    await expect(service.registerC2bUrl("tenant-1", "sc-1", user())).rejects.toThrow(BadRequestException);
    expect(daraja.registerC2bUrl).not.toHaveBeenCalled();
  });

  it("refuses to act on another tenant's shortcode", async () => {
    await expect(service.registerC2bUrl("tenant-2", "sc-1", user({ tenantId: "tenant-1" }))).rejects.toThrow(
      ForbiddenException,
    );
    expect(daraja.registerC2bUrl).not.toHaveBeenCalled();
  });

  it("lets SUPER_ADMIN act on any tenant's shortcode", async () => {
    await expect(
      service.registerC2bUrl("tenant-1", "sc-1", user({ role: "SUPER_ADMIN", tenantId: null })),
    ).resolves.toEqual(expect.objectContaining({ registered: true }));
  });

  it("404s on a shortcode that isn't this tenant's", async () => {
    prisma.__tx.tenantShortcode.findFirst.mockResolvedValueOnce(null);

    await expect(service.registerC2bUrl("tenant-1", "sc-1", user())).rejects.toThrow(NotFoundException);
  });

  it("refuses when the tenant has no Daraja app credentials to authenticate with", async () => {
    prisma.tenant.findUniqueOrThrow.mockResolvedValueOnce({ id: "tenant-1", mpesaConsumerKey: null });

    await expect(service.registerC2bUrl("tenant-1", "sc-1", user())).rejects.toThrow(ForbiddenException);
    expect(daraja.registerC2bUrl).not.toHaveBeenCalled();
  });
});

describe("TenantShortcodesService.update credential/type rules", () => {
  let service: TenantShortcodesService;
  let tx: { tenantShortcode: { findFirst: jest.Mock; update: jest.Mock; updateMany: jest.Mock } };

  const B2C_ROW = { id: "sc-2", tenantId: "tenant-1", type: "B2C", shortcode: "600992", isDefault: false };

  beforeEach(async () => {
    tx = {
      tenantShortcode: {
        findFirst: jest.fn(),
        update: jest.fn((args: { data: Record<string, unknown> }) => ({ ...B2C_ROW, ...args.data })),
        updateMany: jest.fn(),
      },
    };
    const prisma = { withTenantContext: jest.fn((_id: string, fn: (t: unknown) => unknown) => fn(tx)) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantShortcodesService,
        { provide: PrismaService, useValue: prisma },
        { provide: DarajaClient, useValue: {} },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: CredentialsEncryptionService, useValue: { encrypt: (v: string) => `enc(${v})`, decrypt: (v: string) => v } },
      ],
    }).compile();
    service = module.get(TenantShortcodesService);
  });

  it("stores new B2C credentials on a B2C shortcode", async () => {
    tx.tenantShortcode.findFirst.mockResolvedValue(B2C_ROW);
    const result = await service.update("tenant-1", "sc-2", { initiatorName: "testapi", securityCredential: "Ab3d==" }, user());

    expect(tx.tenantShortcode.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mpesaInitiatorName: "testapi", mpesaSecurityCredentialEncrypted: "enc(Ab3d==)" }),
      }),
    );
    expect(result.payoutConfigured).toBe(true);
  });

  it("rejects a passkey sent to a B2C shortcode without writing anything", async () => {
    tx.tenantShortcode.findFirst.mockResolvedValue(B2C_ROW);
    await expect(service.update("tenant-1", "sc-2", { passkey: "pk" }, user())).rejects.toThrow(BadRequestException);
    expect(tx.tenantShortcode.update).not.toHaveBeenCalled();
  });

  it("rejects B2C credentials sent to a Paybill shortcode without writing anything", async () => {
    tx.tenantShortcode.findFirst.mockResolvedValue(PAYBILL);
    await expect(
      service.update("tenant-1", "sc-1", { initiatorName: "testapi", securityCredential: "Ab3d==" }, user()),
    ).rejects.toThrow(BadRequestException);
    expect(tx.tenantShortcode.update).not.toHaveBeenCalled();
  });
});

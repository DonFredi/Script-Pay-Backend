import { Test, TestingModule } from "@nestjs/testing";
import { ApiKeysService } from "./api-keys.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";

describe("ApiKeysService", () => {
  let service: ApiKeysService;
  let prisma: PrismaService;
  let auditLog: AuditLogService;

  beforeEach(async () => {
    const prismaMock: any = {
      apiKey: { create: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), updateMany: jest.fn() },
    };
    // Mirrors the real PrismaService.withTenantContext signature but runs the callback
    // against this same mock instead of a real transaction — lets tests assert both
    // that the tenant context was set (the fix) and that the query still ran correctly.
    prismaMock.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(prismaMock));

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ApiKeysService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(ApiKeysService);
    prisma = module.get(PrismaService);
    auditLog = module.get(AuditLogService);
  });

  describe("create", () => {
    it("returns the raw key, persists only its hash and prefix, and audit-logs without the raw key", async () => {
      jest
        .spyOn(prisma.apiKey, "create")
        .mockImplementation((({ data }: any) => Promise.resolve({ id: "key-1", ...data })) as any);

      const result = await service.create("tenant-1", ["PAYMENTS_INITIATE"], "actor-1");

      expect(result.rawKey).toMatch(/^sp_[0-9a-f]{80}$/);
      expect(result.keyPrefix).toBe(result.rawKey.slice(0, 8));

      const createArgs = (prisma.apiKey.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.keyHash).not.toBe(result.rawKey);
      expect(createArgs.data.keyHash).toMatch(/^\$argon2/);
      expect(createArgs.data.keyPrefix).toBe(result.keyPrefix);

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "api_key.created",
          metadata: expect.not.objectContaining({ rawKey: expect.anything() }),
        }),
      );
      const metadata = (auditLog.record as jest.Mock).mock.calls[0][0].metadata;
      expect(JSON.stringify(metadata)).not.toContain(result.rawKey);
    });

    it("generates a different raw key on every call", async () => {
      jest
        .spyOn(prisma.apiKey, "create")
        .mockImplementation((({ data }: any) => Promise.resolve({ id: "key-x", ...data })) as any);

      const first = await service.create("tenant-1", [], "actor-1");
      const second = await service.create("tenant-1", [], "actor-1");

      expect(first.rawKey).not.toBe(second.rawKey);
    });

    it("creates the key under that tenant's RLS context", async () => {
      jest
        .spyOn(prisma.apiKey, "create")
        .mockImplementation((({ data }: any) => Promise.resolve({ id: "key-1", ...data })) as any);

      await service.create("tenant-1", [], "actor-1");

      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
    });
  });

  describe("provisionDefaultKeyIfNeeded", () => {
    it("creates a system-issued key with the default scopes when the tenant has no live key", async () => {
      jest.spyOn(prisma.apiKey, "findFirst").mockResolvedValueOnce(null);
      jest
        .spyOn(prisma.apiKey, "create")
        .mockImplementation((({ data }: any) => Promise.resolve({ id: "key-1", ...data })) as any);

      const result = await service.provisionDefaultKeyIfNeeded("tenant-1");

      expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({ where: { tenantId: "tenant-1", revokedAt: null } });
      expect(result).not.toBeNull();
      expect(result!.rawKey).toMatch(/^sp_[0-9a-f]{80}$/);
      const createArgs = (prisma.apiKey.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.scopes).toEqual(["PAYMENTS_INITIATE", "PAYMENTS_READ", "WEBHOOKS_MANAGE"]);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "api_key.created", actorType: "system" }),
      );
      expect((auditLog.record as jest.Mock).mock.calls[0][0].actorId).toBeUndefined();
    });

    it("returns null and creates nothing when the tenant already holds a live key", async () => {
      jest.spyOn(prisma.apiKey, "findFirst").mockResolvedValueOnce({ id: "existing-key" } as any);

      const result = await service.provisionDefaultKeyIfNeeded("tenant-1");

      expect(result).toBeNull();
      expect(prisma.apiKey.create).not.toHaveBeenCalled();
    });
  });

  describe("listForTenant", () => {
    it("never selects the keyHash column", async () => {
      jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([]);

      await service.listForTenant("tenant-1");

      const args = (prisma.apiKey.findMany as jest.Mock).mock.calls[0][0];
      expect(args.select.keyHash).toBeUndefined();
      expect(args.where).toEqual({ tenantId: "tenant-1" });
      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
    });
  });

  describe("revoke", () => {
    it("scopes revocation by tenantId (cannot revoke another tenant's key) and audit-logs on success", async () => {
      jest.spyOn(prisma.apiKey, "updateMany").mockResolvedValueOnce({ count: 1 });

      await service.revoke("tenant-1", "key-1", "actor-1");

      expect(prisma.apiKey.updateMany).toHaveBeenCalledWith({
        where: { id: "key-1", tenantId: "tenant-1" },
        data: { revokedAt: expect.any(Date) },
      });
      expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "api_key.revoked" }));
      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
    });

    it("does not audit-log when nothing matched (wrong tenant or unknown key)", async () => {
      jest.spyOn(prisma.apiKey, "updateMany").mockResolvedValueOnce({ count: 0 });

      await service.revoke("tenant-1", "someone-elses-key", "actor-1");

      expect(auditLog.record).not.toHaveBeenCalled();
    });
  });
});

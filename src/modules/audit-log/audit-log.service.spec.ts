import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

describe("AuditLogService", () => {
  let service: AuditLogService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        { provide: PrismaService, useValue: { auditLog: { create: jest.fn(), findMany: jest.fn() } } },
      ],
    }).compile();

    service = module.get(AuditLogService);
    prisma = module.get(PrismaService);
  });

  describe("record", () => {
    it("writes the entry", async () => {
      jest.spyOn(prisma.auditLog, "create").mockResolvedValueOnce({} as any);

      await service.record({ actorType: "system", action: "test.event" });

      expect(prisma.auditLog.create).toHaveBeenCalled();
    });

    it("never throws even if the write fails — an audit gap must not break the caller's business operation", async () => {
      jest.spyOn(prisma.auditLog, "create").mockRejectedValueOnce(new Error("db down"));

      await expect(service.record({ actorType: "system", action: "test.event" })).resolves.toBeUndefined();
    });
  });

  describe("list", () => {
    it("lets a SUPER_ADMIN query any tenant's log", async () => {
      jest.spyOn(prisma.auditLog, "findMany").mockResolvedValueOnce([]);

      await service.list({ tenantId: "other-tenant" }, user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: "other-tenant" }) }),
      );
    });

    it("lets a SUPER_ADMIN query across all tenants when tenantId is omitted", async () => {
      jest.spyOn(prisma.auditLog, "findMany").mockResolvedValueOnce([]);

      await service.list({}, user({ role: "SUPER_ADMIN", tenantId: null }));

      const args = (prisma.auditLog.findMany as jest.Mock).mock.calls[0][0];
      expect(args.where.tenantId).toBeUndefined();
    });

    it("blocks a TENANT_ADMIN from viewing another tenant's log", async () => {
      await expect(
        service.list({ tenantId: "other-tenant" }, user({ role: "TENANT_ADMIN", tenantId: "tenant-1" })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it("forces a TENANT_ADMIN's query to their own tenant even when tenantId is omitted", async () => {
      jest.spyOn(prisma.auditLog, "findMany").mockResolvedValueOnce([]);

      await service.list({}, user({ role: "TENANT_ADMIN", tenantId: "tenant-1" }));

      expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ tenantId: "tenant-1" }) }),
      );
    });
  });
});

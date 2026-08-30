import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { AuditLogService } from "./audit-log.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

describe("AuditLogService", () => {
  let service: AuditLogService;
  let prisma: PrismaPrivilegedService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuditLogService,
        {
          provide: PrismaPrivilegedService,
          useValue: { auditLog: { create: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() } },
        },
      ],
    }).compile();

    service = module.get(AuditLogService);
    prisma = module.get(PrismaPrivilegedService);
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

  describe("findOne", () => {
    it("throws NotFoundException when the entry does not exist", async () => {
      jest.spyOn(prisma.auditLog, "findUnique").mockResolvedValueOnce(null);

      await expect(service.findOne("missing", user({ role: "SUPER_ADMIN", tenantId: null }))).rejects.toThrow(
        NotFoundException,
      );
    });

    it("lets a SUPER_ADMIN read any tenant's entry", async () => {
      jest.spyOn(prisma.auditLog, "findUnique").mockResolvedValueOnce({ id: "log-1", tenantId: "other-tenant" } as any);

      const result = await service.findOne("log-1", user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(result).toEqual({ id: "log-1", tenantId: "other-tenant" });
    });

    it("lets a TENANT_ADMIN read their own tenant's entry", async () => {
      jest.spyOn(prisma.auditLog, "findUnique").mockResolvedValueOnce({ id: "log-1", tenantId: "tenant-1" } as any);

      const result = await service.findOne("log-1", user({ tenantId: "tenant-1" }));

      expect(result).toEqual({ id: "log-1", tenantId: "tenant-1" });
    });

    it("forbids a TENANT_ADMIN from reading another tenant's entry", async () => {
      jest.spyOn(prisma.auditLog, "findUnique").mockResolvedValueOnce({ id: "log-1", tenantId: "other-tenant" } as any);

      await expect(service.findOne("log-1", user({ tenantId: "tenant-1" }))).rejects.toThrow(ForbiddenException);
    });
  });
});

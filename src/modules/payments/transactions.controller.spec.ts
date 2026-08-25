import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { TransactionsController } from "./transactions.controller";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

describe("TransactionsController", () => {
  let controller: TransactionsController;
  let prisma: PrismaService;

  beforeEach(() => {
    const prismaMock: any = {
      transaction: { findMany: jest.fn(), findUnique: jest.fn() },
    };
    // Mirrors PrismaService.withTenantContext's real signature, running the callback
    // against this same mock rather than a real transaction — lets tests assert both
    // that the tenant context was set (the fix) and that the query still ran correctly.
    prismaMock.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(prismaMock));

    // Instantiated directly rather than via Test.createTestingModule: this controller
    // carries @UseGuards() class metadata, and Nest's testing DI tries to resolve
    // those guards' own dependencies (TokenService, etc.) even when the controller is
    // only under test as a plain class — irrelevant noise for a unit test that calls
    // its methods directly and never goes through the HTTP/guard pipeline.
    prisma = prismaMock;
    controller = new TransactionsController(prisma);
  });

  describe("list", () => {
    it("scopes a tenant admin's own list under their own tenant's RLS context", async () => {
      jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([]);

      await controller.list(user({ tenantId: "tenant-1" }));

      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
      expect(prisma.transaction.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tenantId: "tenant-1" } }),
      );
    });

    it("requires SUPER_ADMIN to pass an explicit ?tenantId= — no unscoped cross-tenant listing", async () => {
      await expect(controller.list(user({ role: "SUPER_ADMIN", tenantId: null }))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it("scopes SUPER_ADMIN's list under the explicitly-requested tenant's RLS context", async () => {
      jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([]);

      await controller.list(user({ role: "SUPER_ADMIN", tenantId: null }), undefined, "tenant-2");

      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-2", expect.any(Function));
    });
  });

  describe("findOne", () => {
    it("scopes a tenant admin's read under their own tenant's RLS context", async () => {
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce({ id: "tx-1", tenantId: "tenant-1" } as any);

      const result = await controller.findOne("tx-1", user({ tenantId: "tenant-1" }));

      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
      expect(result).toEqual({ id: "tx-1", tenantId: "tenant-1" });
    });

    it("forbids a tenant admin from reading another tenant's transaction", async () => {
      // Simulates RLS not yet applying in this test double — the app-layer check
      // below is what must still catch this even if the DB-layer one hasn't run.
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce({ id: "tx-1", tenantId: "tenant-2" } as any);

      await expect(controller.findOne("tx-1", user({ tenantId: "tenant-1" }))).rejects.toThrow(ForbiddenException);
    });

    it("throws NotFoundException when no transaction matches", async () => {
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(null);

      await expect(controller.findOne("tx-missing", user({ tenantId: "tenant-1" }))).rejects.toThrow(
        NotFoundException,
      );
    });

    it("does not set a tenant RLS context for SUPER_ADMIN, who has no single target tenant here", async () => {
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce({ id: "tx-1", tenantId: "tenant-9" } as any);

      const result = await controller.findOne("tx-1", user({ role: "SUPER_ADMIN", tenantId: null }));

      expect(prisma.withTenantContext).not.toHaveBeenCalled();
      expect(result).toEqual({ id: "tx-1", tenantId: "tenant-9" });
    });

    it("rejects an account with no associated tenant", async () => {
      await expect(controller.findOne("tx-1", user({ role: "TENANT_ADMIN", tenantId: null }))).rejects.toThrow(
        ForbiddenException,
      );
      expect(prisma.withTenantContext).not.toHaveBeenCalled();
    });
  });
});

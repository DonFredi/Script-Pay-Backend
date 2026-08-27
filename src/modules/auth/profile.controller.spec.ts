import type { Response } from "express";
import { ProfileController } from "./profile.controller";
import { PrismaService } from "../prisma/prisma.service";
import { RefreshTokenService } from "./refresh-token.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function fakeResponse(): Response {
  return { clearCookie: jest.fn() } as unknown as Response;
}

describe("ProfileController", () => {
  let controller: ProfileController;
  let prisma: PrismaService;
  let refreshTokens: RefreshTokenService;

  beforeEach(() => {
    const prismaMock: any = { user: { findUniqueOrThrow: jest.fn() } };
    // Mirrors PrismaService.withTenantContext's real signature, running the
    // callback against this same mock rather than a real transaction.
    prismaMock.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(prismaMock));
    prisma = prismaMock;
    refreshTokens = { revoke: jest.fn() } as any;
    controller = new ProfileController(prisma, refreshTokens);
  });

  describe("me", () => {
    it("scopes a tenant user's own profile read under their own tenant's RLS context", async () => {
      jest.spyOn(prisma.user, "findUniqueOrThrow").mockResolvedValueOnce({
        id: "u-1",
        username: "merchant-one",
        email: "merchant@example.com",
        role: "TENANT_ADMIN",
        tenantId: "tenant-1",
        emailVerified: true,
      } as any);

      const result = await controller.me({ id: "u-1", tenantId: "tenant-1" } as AuthenticatedUser);

      expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "u-1" } });
      expect(result).toEqual({
        id: "u-1",
        username: "merchant-one",
        email: "merchant@example.com",
        roles: ["TENANT_ADMIN"],
        tenantId: "tenant-1",
        emailVerified: true,
      });
    });

    it("skips tenant context for a caller with no tenantId (SUPER_ADMIN, or mid-onboarding) — their own row is NULL-tenant too", async () => {
      jest.spyOn(prisma.user, "findUniqueOrThrow").mockResolvedValueOnce({
        id: "u-9",
        username: "admin",
        email: "admin@example.com",
        role: "SUPER_ADMIN",
        tenantId: null,
        emailVerified: true,
      } as any);

      const result = await controller.me({ id: "u-9", tenantId: null } as AuthenticatedUser);

      expect(prisma.withTenantContext).not.toHaveBeenCalled();
      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({ where: { id: "u-9" } });
      expect(result.tenantId).toBeNull();
    });
  });

  describe("logout", () => {
    it("revokes the refresh token and clears all three auth cookies when a refresh token cookie is present", async () => {
      const req = { cookies: { refresh_token: "raw-refresh-token" } } as any;
      const res = fakeResponse();

      const result = await controller.logout(req, res);

      expect(refreshTokens.revoke).toHaveBeenCalledWith("raw-refresh-token");
      expect(res.clearCookie).toHaveBeenCalledWith("refresh_token", { path: "/" });
      expect(res.clearCookie).toHaveBeenCalledWith("access_token", { path: "/" });
      expect(res.clearCookie).toHaveBeenCalledWith("csrf-token", { path: "/" });
      expect(result).toEqual({ loggedOut: true });
    });

    it("still clears cookies and succeeds even with no refresh token cookie present", async () => {
      const req = { cookies: {} } as any;
      const res = fakeResponse();

      const result = await controller.logout(req, res);

      expect(refreshTokens.revoke).not.toHaveBeenCalled();
      expect(res.clearCookie).toHaveBeenCalledWith("refresh_token", { path: "/" });
      expect(result).toEqual({ loggedOut: true });
    });
  });
});

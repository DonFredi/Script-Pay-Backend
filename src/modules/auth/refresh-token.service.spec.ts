import { UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RefreshTokenService } from "./refresh-token.service";
import { PrismaService } from "../prisma/prisma.service";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("RefreshTokenService", () => {
  let service: RefreshTokenService;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = {
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    } as any;
    service = new RefreshTokenService(prisma);
  });

  describe("issue", () => {
    it("stores only the hash, never the raw token, and returns the raw token to the caller", async () => {
      jest.spyOn(prisma.refreshToken, "create").mockResolvedValueOnce({ id: "rt-1" } as any);

      const rawToken = await service.issue("user-1");

      const createArgs = (prisma.refreshToken.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data.userId).toBe("user-1");
      expect(createArgs.data.tokenHash).toBe(hash(rawToken));
      expect(createArgs.data.tokenHash).not.toBe(rawToken);
    });
  });

  describe("verifyAndRotate", () => {
    it("rejects a token that doesn't match any stored hash", async () => {
      jest.spyOn(prisma.refreshToken, "findUnique").mockResolvedValueOnce(null);

      await expect(service.verifyAndRotate("unknown-token")).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an expired token", async () => {
      jest.spyOn(prisma.refreshToken, "findUnique").mockResolvedValueOnce({
        id: "rt-1",
        userId: "user-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      await expect(service.verifyAndRotate("expired-token")).rejects.toThrow(UnauthorizedException);
    });

    it("rotates a valid token: revokes the old one, issues a new one chained via replacedByTokenId", async () => {
      jest.spyOn(prisma.refreshToken, "findUnique").mockResolvedValueOnce({
        id: "rt-old",
        userId: "user-1",
        revokedAt: null,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      } as any);
      jest.spyOn(prisma.refreshToken, "create").mockResolvedValueOnce({ id: "rt-new" } as any);

      const result = await service.verifyAndRotate("valid-token");

      expect(result.userId).toBe("user-1");
      expect(typeof result.newRawToken).toBe("string");
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: "rt-old" },
        data: { revokedAt: expect.any(Date), replacedByTokenId: "rt-new" },
      });
    });

    it("treats presenting an already-revoked token as theft: revokes every session for that user", async () => {
      jest.spyOn(prisma.refreshToken, "findUnique").mockResolvedValueOnce({
        id: "rt-1",
        userId: "user-1",
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      } as any);

      await expect(service.verifyAndRotate("reused-token")).rejects.toThrow(
        "Refresh token reuse detected — all sessions revoked",
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
      // Must not also try to rotate a token it just determined was compromised.
      expect(prisma.refreshToken.create).not.toHaveBeenCalled();
    });
  });

  describe("revoke", () => {
    it("revokes only the presented token, matched by its hash", async () => {
      await service.revoke("some-token");

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { tokenHash: hash("some-token"), revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });

  describe("revokeAllForUser", () => {
    it("revokes every active token for the user", async () => {
      await service.revokeAllForUser("user-1");

      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });
  });
});

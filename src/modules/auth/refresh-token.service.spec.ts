import { UnauthorizedException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { RefreshTokenService } from "./refresh-token.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("RefreshTokenService", () => {
  let service: RefreshTokenService;
  let prisma: PrismaService;
  let auditLog: AuditLogService;

  beforeEach(() => {
    prisma = {
      refreshToken: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
    } as any;
    auditLog = { record: jest.fn().mockResolvedValue(undefined) } as any;
    service = new RefreshTokenService(prisma, auditLog);
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
      // The theft signal has to outlive application logs — an account review weeks
      // later finds it through the audit log or not at all.
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "auth.refresh_token_reuse_detected", actorId: "user-1" }),
      );
    });

    it("forgives a race: a just-rotated token presented again within the grace window rotates from the live descendant instead of revoking everything", async () => {
      jest.spyOn(prisma.refreshToken, "findUnique").mockImplementation((({ where }: any) => {
        if (where.tokenHash) {
          return Promise.resolve({
            id: "rt-old",
            userId: "user-1",
            revokedAt: new Date(Date.now() - 1000), // rotated 1s ago — inside the window
            replacedByTokenId: "rt-live",
            expiresAt: new Date(Date.now() + 1000 * 60 * 60),
          } as any);
        }
        if (where.id === "rt-live") {
          return Promise.resolve({
            id: "rt-live",
            userId: "user-1",
            revokedAt: null,
            replacedByTokenId: null,
            expiresAt: new Date(Date.now() + 1000 * 60 * 60),
          } as any);
        }
        return Promise.resolve(null);
      }) as any);
      jest.spyOn(prisma.refreshToken, "create").mockResolvedValueOnce({ id: "rt-newer" } as any);

      const result = await service.verifyAndRotate("raced-token");

      expect(result.userId).toBe("user-1");
      expect(prisma.refreshToken.update).toHaveBeenCalledWith({
        where: { id: "rt-live" },
        data: { revokedAt: expect.any(Date), replacedByTokenId: "rt-newer" },
      });
      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
    });

    it("still treats reuse as theft once the grace window has elapsed, even with a live descendant", async () => {
      jest.spyOn(prisma.refreshToken, "findUnique").mockResolvedValueOnce({
        id: "rt-old",
        userId: "user-1",
        revokedAt: new Date(Date.now() - 60_000), // rotated a minute ago — outside the window
        replacedByTokenId: "rt-live",
        expiresAt: new Date(Date.now() + 1000 * 60 * 60),
      } as any);

      await expect(service.verifyAndRotate("stale-reused-token")).rejects.toThrow(
        "Refresh token reuse detected — all sessions revoked",
      );
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: "user-1", revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
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

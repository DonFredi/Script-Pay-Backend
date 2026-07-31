import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30);

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class RefreshTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: string): Promise<string> {
    const rawToken = randomBytes(48).toString("base64url");
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: hashToken(rawToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });
    return rawToken;
  }

  /**
   * Verifies the presented token, then ROTATES it: the old one is revoked and a new
   * one issued in its place, chained via replacedByTokenId. If a token that's already
   * been revoked is presented again, that's a strong signal it was stolen and used by
   * someone else after the legitimate user's own rotation already happened — in that
   * case we revoke every active token for the user, not just this one, forcing a
   * fresh login everywhere.
   */
  async verifyAndRotate(rawToken: string): Promise<{ userId: string; newRawToken: string }> {
    const tokenHash = hashToken(rawToken);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!existing) {
      throw new UnauthorizedException("Invalid refresh token");
    }

    if (existing.revokedAt) {
      // Reuse of a already-rotated token — treat as compromise, not a normal error.
      await this.revokeAllForUser(existing.userId);
      throw new UnauthorizedException("Refresh token reuse detected — all sessions revoked");
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }

    const newRawToken = randomBytes(48).toString("base64url");
    const newRecord = await this.prisma.refreshToken.create({
      data: {
        userId: existing.userId,
        tokenHash: hashToken(newRawToken),
        expiresAt: new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    await this.prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenId: newRecord.id },
    });

    return { userId: existing.userId, newRawToken };
  }

  async revoke(rawToken: string): Promise<void> {
    const tokenHash = hashToken(rawToken);
    await this.prisma.refreshToken.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Public — called both internally (reuse detection) and externally (password reset). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  get refreshTtlDays(): number {
    return REFRESH_TTL_DAYS;
  }
}

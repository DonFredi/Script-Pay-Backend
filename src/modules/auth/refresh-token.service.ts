import { Injectable, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import type { RefreshToken } from "@prisma/client";

const REFRESH_TTL_DAYS = Number(process.env.JWT_REFRESH_TTL_DAYS ?? 30);

// Concurrent /auth/refresh calls with the same token (multiple tabs, a frontend
// interceptor firing twice) can present an already-rotated token milliseconds after
// a sibling request rotated it. Without this window, that legitimate race trips the
// same branch as real token theft and revokes every session for the user. Within the
// window, we walk the rotation chain to the still-live token and rotate from there
// instead — only a token that never resolves to a live descendant (a genuinely reused
// or explicitly revoked token) is treated as compromise.
const REUSE_GRACE_WINDOW_MS = 10_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

@Injectable()
export class RefreshTokenService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
  ) {}

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
      const withinGraceWindow = Date.now() - existing.revokedAt.getTime() < REUSE_GRACE_WINDOW_MS;
      const current = withinGraceWindow ? await this.findLiveDescendant(existing) : null;

      if (!current) {
        // Reuse of an already-rotated token, outside the grace window (or with no live
        // descendant at all) — treat as compromise, not a normal error.
        await this.revokeAllForUser(existing.userId);
        // This is the strongest theft signal the system produces, so it goes to the
        // queryable audit trail rather than application logs alone — someone
        // reviewing an account weeks later needs to find it via GET /v1/audit-logs.
        await this.auditLog.record({
          actorType: "user",
          actorId: existing.userId,
          action: "auth.refresh_token_reuse_detected",
          targetType: "User",
          targetId: existing.userId,
          metadata: { revokedTokenId: existing.id },
        });
        throw new UnauthorizedException("Refresh token reuse detected — all sessions revoked");
      }

      return this.rotate(current);
    }

    if (existing.expiresAt < new Date()) {
      throw new UnauthorizedException("Refresh token expired");
    }

    return this.rotate(existing);
  }

  /** Follows replacedByTokenId to the chain's still-active tail, or null if it dead-ends revoked. */
  private async findLiveDescendant(token: RefreshToken): Promise<RefreshToken | null> {
    let current = token;
    const visited = new Set([current.id]);

    while (current.replacedByTokenId) {
      if (visited.has(current.replacedByTokenId)) return null;
      const next = await this.prisma.refreshToken.findUnique({ where: { id: current.replacedByTokenId } });
      if (!next) return null;
      visited.add(next.id);
      current = next;
    }

    return current.revokedAt ? null : current;
  }

  private async rotate(existing: { id: string; userId: string }): Promise<{ userId: string; newRawToken: string }> {
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

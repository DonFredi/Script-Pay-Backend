import { Injectable } from "@nestjs/common";
import { createHash, randomBytes } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Shared hashed-single-use-token pattern for both email verification and
 * password reset — same reasoning as RefreshToken: high-entropy random values,
 * so a fast hash (not argon2/bcrypt) is the correct tool, and only the hash is
 * ever persisted so a stolen DB backup doesn't hand out usable tokens.
 */
@Injectable()
export class VerificationTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issueEmailVerificationToken(userId: string): Promise<string> {
    const ttlHours = Number(process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 24);
    const rawToken = randomBytes(32).toString("base64url");
    await this.prisma.emailVerificationToken.create({
      data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + ttlHours * 60 * 60 * 1000) },
    });
    return rawToken;
  }

  async consumeEmailVerificationToken(rawToken: string): Promise<string> {
    const record = await this.prisma.emailVerificationToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new Error("Invalid or expired verification link");
    }
    await this.prisma.emailVerificationToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return record.userId;
  }

  async issuePasswordResetToken(userId: string): Promise<string> {
    const ttlMinutes = Number(process.env.PASSWORD_RESET_TTL_MINUTES ?? 30);
    const rawToken = randomBytes(32).toString("base64url");
    await this.prisma.passwordResetToken.create({
      data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000) },
    });
    return rawToken;
  }

  async consumePasswordResetToken(rawToken: string): Promise<string> {
    const record = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: hashToken(rawToken) } });
    if (!record || record.usedAt || record.expiresAt < new Date()) {
      throw new Error("Invalid or expired reset link");
    }
    await this.prisma.passwordResetToken.update({ where: { id: record.id }, data: { usedAt: new Date() } });
    return record.userId;
  }
}

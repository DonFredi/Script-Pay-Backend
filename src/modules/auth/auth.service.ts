import { ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import * as argon2 from "argon2";
import type { Role } from "@prisma/client";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { TokenService } from "./token.service";
import { RefreshTokenService } from "./refresh-token.service";
import { VerificationTokenService } from "./verification-token.service";
import { EmailService } from "./email.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import type {
  ForgotPasswordDto,
  LoginBodyDto,
  ResendVerificationDto,
  ResetPasswordDto,
  SignupDto,
  VerifyEmailDto,
} from "./auth.schema";

export interface SessionResult {
  user: {
    id: string;
    username: string | null;
    email: string;
    roles: string[];
    tenantId: string | null;
    emailVerified: boolean;
  };
  accessToken: string;
  refreshToken: string; // caller sets this as an httpOnly cookie, never returns it in JSON
}

@Injectable()
export class AuthService {
  constructor(
    // AuthService looks up users BY EMAIL, before any tenant identity exists to
    // scope by — see PrismaPrivilegedService's own doc comment for why this can't
    // go through PrismaService.withTenantContext.
    private readonly prisma: PrismaPrivilegedService,
    private readonly tokens: TokenService,
    private readonly refreshTokens: RefreshTokenService,
    private readonly verificationTokens: VerificationTokenService,
    private readonly email: EmailService,
    private readonly auditLog: AuditLogService,
  ) {}

  /**
   * Firebase previously owned password storage and identity verification
   * entirely. Now this backend does: passwords are hashed with argon2id (the
   * modern, recommended choice — deliberately slow and memory-hard, unlike the
   * fast SHA-256 used for refresh/reset tokens, because a password is
   * low-entropy and guessable, unlike a random token).
   */
  async signup(dto: SignupDto): Promise<SessionResult> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException("An account with this email already exists");
    }

    const passwordHash = await argon2.hash(dto.password);

    // New self-registrations get TENANT_ADMIN with no tenant yet — see the
    // onboarding module, which is where they provision their actual tenant
    // (business shortcode, etc.) before any payment endpoints become usable.
    const user = await this.prisma.user.create({
      data: {
        username: dto.username,
        email: dto.email,
        passwordHash,
        role: "TENANT_ADMIN",
        tenantId: null,
        emailVerified: false,
      },
    });

    const verificationToken = await this.verificationTokens.issueEmailVerificationToken(user.id);
    await this.email.sendVerificationEmail(user.email, verificationToken);

    await this.auditLog.record({
      actorType: "user",
      actorId: user.id,
      action: "user.registered",
      targetType: "User",
      targetId: user.id,
    });

    return this.issueSession(user.id, user.email, user.role, user.tenantId, user.username, user.emailVerified);
  }

  /**
   * Direct email+password verification — no more Firebase ID-token round-trip.
   * A generic "invalid email or password" error on any failure (wrong email,
   * wrong password) is deliberate: distinguishing the two lets an attacker
   * enumerate which emails have accounts.
   */
  async login(dto: LoginBodyDto): Promise<SessionResult> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!user) {
      // The failure reason stays out of the HTTP response (enumeration) but belongs
      // in the audit trail: "which account was targeted, how often, from when" is
      // the first question asked in an incident review, and the response the
      // attacker sees is unchanged either way.
      await this.auditLog.record({
        actorType: "user",
        action: "user.login_failed",
        metadata: { email: dto.email, reason: "unknown_email" },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    const passwordValid = await argon2.verify(user.passwordHash, dto.password);
    if (!passwordValid) {
      await this.auditLog.record({
        tenantId: user.tenantId,
        actorType: "user",
        actorId: user.id,
        action: "user.login_failed",
        targetType: "User",
        targetId: user.id,
        metadata: { email: dto.email, reason: "bad_password" },
      });
      throw new UnauthorizedException("Invalid email or password");
    }

    await this.auditLog.record({
      tenantId: user.tenantId,
      actorType: "user",
      actorId: user.id,
      action: "user.login",
      targetType: "User",
      targetId: user.id,
    });

    return this.issueSession(user.id, user.email, user.role, user.tenantId, user.username, user.emailVerified);
  }

  async refresh(rawRefreshToken: string): Promise<{ accessToken: string; refreshToken: string }> {
    const { userId, newRawToken } = await this.refreshTokens.verifyAndRotate(rawRefreshToken);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
    });
    return { accessToken, refreshToken: newRawToken };
  }

  async logout(rawRefreshToken: string | undefined): Promise<void> {
    if (rawRefreshToken) {
      await this.refreshTokens.revoke(rawRefreshToken);
    }
  }

  /**
   * Always returns success regardless of whether the email exists — telling the
   * caller "no account with that email" would let an attacker enumerate which
   * emails are registered. The email itself only actually gets sent if the
   * account exists; from the API response, both cases look identical.
   */
  async requestPasswordReset(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (user) {
      const token = await this.verificationTokens.issuePasswordResetToken(user.id);
      await this.email.sendPasswordResetEmail(user.email, token);
    }
  }

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    let userId: string;
    try {
      userId = await this.verificationTokens.consumePasswordResetToken(dto.token);
    } catch {
      throw new UnauthorizedException("Invalid or expired reset link");
    }

    const passwordHash = await argon2.hash(dto.password);
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash } });

    // A password reset is a strong signal to end every other active session —
    // if the reset was triggered because the password leaked, stale sessions
    // elsewhere should not continue working.
    await this.refreshTokens.revokeAllForUser(userId);

    await this.auditLog.record({
      actorType: "user",
      actorId: userId,
      action: "user.password_reset",
      targetType: "User",
      targetId: userId,
    });
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    let userId: string;
    try {
      userId = await this.verificationTokens.consumeEmailVerificationToken(dto.token);
    } catch {
      throw new UnauthorizedException("Invalid or expired verification link");
    }
    await this.prisma.user.update({ where: { id: userId }, data: { emailVerified: true } });
  }

  /** Silently no-ops for an already-verified or unknown email — same enumeration-avoidance reasoning as requestPasswordReset. */
  async resendVerification(dto: ResendVerificationDto): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (user && !user.emailVerified) {
      const token = await this.verificationTokens.issueEmailVerificationToken(user.id);
      await this.email.sendVerificationEmail(user.email, token);
    }
  }

  private async issueSession(
    userId: string,
    email: string,
    role: Role,
    tenantId: string | null,
    username: string | null,
    emailVerified: boolean,
  ): Promise<SessionResult> {
    const accessToken = await this.tokens.signAccessToken({ sub: userId, email, role, tenantId });
    const refreshToken = await this.refreshTokens.issue(userId);
    return {
      user: { id: userId, username, email, roles: [role], tenantId, emailVerified },
      accessToken,
      refreshToken,
    };
  }
}

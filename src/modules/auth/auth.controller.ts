import { Body, Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import {
  forgotPasswordSchema,
  loginSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  signupSchema,
  verifyEmailSchema,
  type ForgotPasswordDto,
  type LoginBodyDto,
  type ResendVerificationDto,
  type ResetPasswordDto,
  type SignupDto,
  type VerifyEmailDto,
} from "./auth.schema";
import { StrictPaymentThrottle } from "../../common/throttle-tiers";

const REFRESH_COOKIE = "refresh_token";
const REFRESH_COOKIE_PATH = "/auth/refresh"; // scope the cookie tightly — it's only ever sent on this one path

/**
 * Paths here match the frontend's already-built auth modules exactly. Firebase
 * is gone entirely now — login takes email+password directly (this backend
 * verifies the argon2 hash itself), and email verification / password reset are
 * this backend's own responsibility (via Resend), not Firebase's built-in flows.
 */
@Controller("auth")
@UseGuards(ThrottlerGuard)
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  @Post("signup")
  @StrictPaymentThrottle() // account creation is rare and sensitive, same tight ceiling as payment initiation
  async signup(@Body(new ZodValidationPipe(signupSchema)) dto: SignupDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.authService.signup(dto);
    this.setRefreshCookie(res, session.refreshToken);
    this.setAccessCookie(res, session.accessToken);
    return { user: session.user, accessToken: session.accessToken };
  }

  @Post("login")
  @StrictPaymentThrottle()
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginBodyDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.authService.login(dto);
    this.setRefreshCookie(res, session.refreshToken);
    this.setAccessCookie(res, session.accessToken);
    return { user: session.user, accessToken: session.accessToken };
  }

  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!rawRefreshToken) {
      // No cookie at all — not an error worth alerting on, just "not logged in."
      return { accessToken: null };
    }

    const { accessToken, refreshToken } = await this.authService.refresh(rawRefreshToken);
    this.setRefreshCookie(res, refreshToken);
    this.setAccessCookie(res, accessToken);
    return { accessToken };
  }

  @Post("forgot-password")
  @StrictPaymentThrottle()
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) dto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(dto);
    // Always the same response whether or not the email exists — see
    // AuthService.requestPasswordReset for why.
    return { message: "If an account exists for that email, a reset link has been sent." };
  }

  @Post("reset-password")
  @StrictPaymentThrottle()
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { message: "Password updated. Please log in again." };
  }

  @Post("verify-email")
  async verifyEmail(@Body(new ZodValidationPipe(verifyEmailSchema)) dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto);
    return { message: "Email verified." };
  }

  @Post("resend-verification")
  @StrictPaymentThrottle()
  async resendVerification(@Body(new ZodValidationPipe(resendVerificationSchema)) dto: ResendVerificationDto) {
    await this.authService.resendVerification(dto);
    return { message: "If that account needs verification, a new link has been sent." };
  }

  private setRefreshCookie(res: Response, token: string) {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: REFRESH_COOKIE_PATH,
      maxAge: this.refreshTokens.refreshTtlDays * 24 * 60 * 60 * 1000,
    });
  }

  /**
   * Never read by this backend's own guards (AccessTokenGuard only ever reads the
   * Authorization header, matching the axios in-memory-token pattern used for
   * actual API calls). Its only consumer is the frontend's own Edge middleware —
   * see that file's comments for why this exists as a second, httpOnly-cookie
   * copy of the same token.
   */
  private setAccessCookie(res: Response, token: string) {
    res.cookie("access_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60 * 1000,
    });
  }
}

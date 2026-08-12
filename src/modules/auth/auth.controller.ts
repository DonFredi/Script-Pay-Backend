import { Body, Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CsrfGuard, generateCsrfToken } from "../../common/guards/csrf.guard"; // ← ADD IMPORT
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
const REFRESH_COOKIE_PATH = "/auth/refresh";

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
  @StrictPaymentThrottle()
  async signup(@Body(new ZodValidationPipe(signupSchema)) dto: SignupDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.authService.signup(dto);
    this.setRefreshCookie(res, session.refreshToken);
    this.setAccessCookie(res, session.accessToken);
    this.setCsrfCookie(res); // ← ADD THIS LINE
    return { user: session.user, accessToken: session.accessToken };
  }

  @Post("login")
  @StrictPaymentThrottle()
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginBodyDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.authService.login(dto);
    this.setRefreshCookie(res, session.refreshToken);
    this.setAccessCookie(res, session.accessToken);
    this.setCsrfCookie(res); // ← ADD THIS LINE
    return { user: session.user, accessToken: session.accessToken };
  }

  @Post("refresh")
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!rawRefreshToken) {
      return { accessToken: null };
    }

    const { accessToken, refreshToken } = await this.authService.refresh(rawRefreshToken);
    this.setRefreshCookie(res, refreshToken);
    this.setAccessCookie(res, accessToken);
    return { accessToken };
  }

  @Post("forgot-password")
  @StrictPaymentThrottle()
  @UseGuards(CsrfGuard) // ← ADD CSRF GUARD
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) dto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(dto);
    return { message: "If an account exists for that email, a reset link has been sent." };
  }

  @Post("reset-password")
  @StrictPaymentThrottle()
  @UseGuards(CsrfGuard) // ← ADD CSRF GUARD
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { message: "Password updated. Please log in again." };
  }

  @Post("verify-email")
  @UseGuards(CsrfGuard) // ← ADD CSRF GUARD
  async verifyEmail(@Body(new ZodValidationPipe(verifyEmailSchema)) dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto);
    return { message: "Email verified." };
  }

  @Post("resend-verification")
  @StrictPaymentThrottle()
  @UseGuards(CsrfGuard) // ← ADD CSRF GUARD
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

  private setAccessCookie(res: Response, token: string) {
    res.cookie("access_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 15 * 60 * 1000,
    });
  }

  // ← ADD THIS METHOD
  private setCsrfCookie(res: Response) {
    const csrfToken = generateCsrfToken();
    res.cookie("csrf-token", csrfToken, {
      httpOnly: false, // ← JavaScript MUST read this (not httpOnly)
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  }
}

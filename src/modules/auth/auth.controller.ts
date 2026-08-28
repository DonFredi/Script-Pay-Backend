import { Body, Controller, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { ThrottlerGuard } from "@nestjs/throttler";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { CsrfGuard, generateCsrfToken } from "../../common/guards/csrf.guard";
import { RefreshCsrfGuard } from "./refresh-csrf.guard";
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
// path: "/" — deliberately NOT scoped to just the refresh endpoint. It used to be
// ("/api/backend/auth/refresh", matching the frontend's proxy prefix), and that was
// a real bug: ProfileController.logout's clearCookie used a DIFFERENT path
// ("/auth/refresh"), which doesn't match a cookie's path for clearing purposes — so
// logout never actually cleared it. Worse, because the cookie's real path was
// scoped that narrowly, the browser never even SENT it to /profile/logout in the
// first place, so logout's revoke() call silently never ran either — the refresh
// token stayed valid, so reloading after "logging out" silently logged back in.
// httpOnly already blocks JS access, so path scoping bought no real security here —
// just a bug. Every cookie this app sets now uses path: "/" for that reason.
const REFRESH_COOKIE_PATH = "/";

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
    this.setCsrfCookie(res);
    return { user: session.user, accessToken: session.accessToken };
  }

  @Post("login")
  @StrictPaymentThrottle()
  async login(@Body(new ZodValidationPipe(loginSchema)) dto: LoginBodyDto, @Res({ passthrough: true }) res: Response) {
    const session = await this.authService.login(dto);
    this.setRefreshCookie(res, session.refreshToken);
    this.setAccessCookie(res, session.accessToken);
    this.setCsrfCookie(res);
    return { user: session.user, accessToken: session.accessToken };
  }

  // CSRF protection here matches every other state-changing route on this controller.
  // It was previously the one POST without it — which made /auth/refresh the only
  // backend route a same-site attacker could trigger with no CSRF token. The damage
  // was bounded (it only reads an httpOnly cookie and reissues session cookies —
  // nothing readable cross-origin), but a forged refresh still rotates the victim's
  // refresh token, and a rotated-token race outside RefreshTokenService's 10s grace
  // window trips the theft branch and revokes every session for that user.
  // The frontend's apiPrivate already sends X-CSRF-Token on this call.
  //
  // RefreshCsrfGuard rather than plain CsrfGuard: it enforces CSRF whenever a
  // refresh_token cookie is actually present, but lets a cookie-less request
  // through to the no-op path below, so a logged-out visitor still gets
  // { accessToken: null } instead of a 403. See that guard for why the exemption
  // gives up nothing.
  @Post("refresh")
  @UseGuards(RefreshCsrfGuard)
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (!rawRefreshToken) {
      return { accessToken: null };
    }

    const { accessToken, refreshToken } = await this.authService.refresh(rawRefreshToken);
    this.setRefreshCookie(res, refreshToken);
    this.setAccessCookie(res, accessToken);
    // Sessions stay alive indefinitely via silent refresh, but nothing used to
    // reissue this cookie after the initial login, so a session that outlived the
    // csrf cookie lost CSRF protection entirely (every state-changing request,
    // logout included, failed with "CSRF token missing") until the user logged in
    // again. Reissuing it here keeps it exactly as fresh as the session itself.
    this.setCsrfCookie(res);
    return { accessToken };
  }

  @Post("forgot-password")
  @StrictPaymentThrottle()
  @UseGuards(CsrfGuard)
  async forgotPassword(@Body(new ZodValidationPipe(forgotPasswordSchema)) dto: ForgotPasswordDto) {
    await this.authService.requestPasswordReset(dto);
    return { message: "If an account exists for that email, a reset link has been sent." };
  }

  @Post("reset-password")
  @StrictPaymentThrottle()
  @UseGuards(CsrfGuard)
  async resetPassword(@Body(new ZodValidationPipe(resetPasswordSchema)) dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { message: "Password updated. Please log in again." };
  }

  @Post("verify-email")
  @UseGuards(CsrfGuard)
  async verifyEmail(@Body(new ZodValidationPipe(verifyEmailSchema)) dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto);
    return { message: "Email verified." };
  }

  @Post("resend-verification")
  @StrictPaymentThrottle()
  @UseGuards(CsrfGuard)
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

  private setCsrfCookie(res: Response) {
    const csrfToken = generateCsrfToken();
    res.cookie("csrf-token", csrfToken, {
      httpOnly: false, // the frontend must be able to read this to echo it back as X-CSRF-Token
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      // Deliberately the SAME lifetime as the refresh cookie, not a shorter fixed 7
      // days. Now that /auth/refresh is itself CsrfGuard-protected, a csrf-token that
      // outlives-less-than the refresh token is a lockout: a session idle past the
      // csrf cookie's expiry would present a still-valid refresh_token with no
      // csrf-token, get 403 from the guard, and have no way to obtain a new csrf
      // cookie (only login and refresh issue one) — a silent forced re-login. Tying
      // the two together means the only cookie that can expire first is the 15-minute
      // access token, which is exactly what refresh exists to replace.
      maxAge: this.refreshTokens.refreshTtlDays * 24 * 60 * 60 * 1000,
    });
  }
}

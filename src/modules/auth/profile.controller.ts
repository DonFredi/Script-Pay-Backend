import { Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AccessTokenGuard } from "./access-token.guard";
import { RefreshTokenService } from "./refresh-token.service";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { ReadThrottle } from "../../common/throttle-tiers";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";

const REFRESH_COOKIE = "refresh_token";
// Must match AuthController's REFRESH_COOKIE_PATH exactly — a cookie can only be
// cleared (or, before this was fixed, even read here at all) via a Set-Cookie whose
// path matches the cookie's actual stored path. See that file's own comment for
// the bug this caused when the two paths didn't match.
const REFRESH_COOKIE_PATH = "/";

/**
 * Deliberately a separate controller from AuthController, matching the frontend's
 * own split: me.api.ts calls GET /profile, logout.api.ts calls POST /profile/logout
 * (not /auth/logout) — this mirrors that exactly rather than introducing a
 * different path the frontend doesn't already expect.
 */
// Both routes were entirely unrated — GET /profile is polled by the dashboard on
// every session rehydrate.
//
// The throttler is attached per-method rather than on the controller, and that is
// the guard-ordering rule doing real work: NestJS runs controller-level guards
// BEFORE method-level ones, so a controller-level TenantAwareThrottlerGuard would
// run before this file's method-level AccessTokenGuard had set request.user and
// would silently fall back to per-IP tracking for every tenant. Only the tier
// decorator, which no guard order affects, belongs at controller level.
@Controller("profile")
@ReadThrottle()
export class ProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  @Get()
  @UseGuards(AccessTokenGuard, TenantAwareThrottlerGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    // A tenant-less caller (SUPER_ADMIN, or a user mid-onboarding) has a NULL
    // tenantId on their own row too — the RLS policy's `tenantId IS NULL` branch
    // matches that unconditionally, so no context needs to be set for them.
    const record = user.tenantId
      ? await this.prisma.withTenantContext(user.tenantId, (tx) => tx.user.findUniqueOrThrow({ where: { id: user.id } }))
      : await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return {
      id: record.id,
      username: record.username,
      email: record.email,
      roles: [record.role],
      tenantId: record.tenantId,
      emailVerified: record.emailVerified,
    };
  }

  @Post("logout")
  // No AccessTokenGuard here, deliberately (logout works off the refresh cookie
  // alone), so the throttler has no request.user to read and tracks by IP — which is
  // the correct fallback for an endpoint that must stay reachable with a dead token.
  @UseGuards(CsrfGuard, TenantAwareThrottlerGuard)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (rawRefreshToken) {
      await this.refreshTokens.revoke(rawRefreshToken);
    }
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    res.clearCookie("access_token", { path: "/" });
    res.clearCookie("csrf-token", { path: "/" });
    return { loggedOut: true };
  }
}

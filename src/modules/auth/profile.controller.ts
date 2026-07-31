import { Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AccessTokenGuard } from "./access-token.guard";
import { RefreshTokenService } from "./refresh-token.service";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { PrismaService } from "../prisma/prisma.service";

const REFRESH_COOKIE = "refresh_token";
const REFRESH_COOKIE_PATH = "/auth/refresh";

/**
 * Deliberately a separate controller from AuthController, matching the frontend's
 * own split: me.api.ts calls GET /profile, logout.api.ts calls POST /profile/logout
 * (not /auth/logout) — this mirrors that exactly rather than introducing a
 * different path the frontend doesn't already expect.
 */
@Controller("profile")
export class ProfileController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  @Get()
  @UseGuards(AccessTokenGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    const record = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return {
      id: record.id,
      username: record.username,
      email: record.email,
      roles: [record.role], // array form matches the frontend's User.roles shape
      tenantId: record.tenantId, // frontend uses this to decide if onboarding is needed
      emailVerified: record.emailVerified,
    };
  }

  @Post("logout")
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    // Logout doesn't require AccessTokenGuard — an expired/missing access token
    // shouldn't block someone from clearing out their (still-valid) refresh cookie.
    if (rawRefreshToken) {
      await this.refreshTokens.revoke(rawRefreshToken);
    }
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    res.clearCookie("access_token", { path: "/" });
    return { loggedOut: true };
  }
}

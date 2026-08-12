import { Controller, Get, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { AccessTokenGuard } from "./access-token.guard";
import { RefreshTokenService } from "./refresh-token.service";
import { CsrfGuard } from "../../common/guards/csrf.guard"; // ← ADD IMPORT
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
      roles: [record.role],
      tenantId: record.tenantId,
      emailVerified: record.emailVerified,
    };
  }

  @Post("logout")
  @UseGuards(CsrfGuard) // ← ADD CSRF GUARD
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const rawRefreshToken = req.cookies?.[REFRESH_COOKIE];
    if (rawRefreshToken) {
      await this.refreshTokens.revoke(rawRefreshToken);
    }
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
    res.clearCookie("access_token", { path: "/" });
    res.clearCookie("csrf-token", { path: "/" }); // ← ADD THIS LINE
    return { loggedOut: true };
  }
}

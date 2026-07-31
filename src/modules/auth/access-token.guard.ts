import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { TokenService } from "./token.service";

/**
 * Replaces the earlier FirebaseAuthGuard everywhere except inside AuthService
 * itself. Firebase is only ever consulted at /auth/login and /auth/signup to
 * verify identity — every other request in the app is authenticated against
 * the backend's own short-lived access token instead. This is what makes real
 * signature verification possible on the frontend's Edge middleware too (see
 * that file's comments) — Firebase Admin can't run there, but jose-verifying
 * our own JWT can.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(private readonly tokens: TokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers["authorization"];

    if (!authHeader?.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing access token");
    }

    const token = authHeader.slice("Bearer ".length);

    try {
      const claims = await this.tokens.verifyAccessToken(token);
      request.user = {
        id: claims.sub,
        email: claims.email,
        role: claims.role,
        tenantId: claims.tenantId,
      };
      return true;
    } catch {
      throw new UnauthorizedException("Invalid or expired access token");
    }
  }
}

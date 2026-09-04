import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { TokenService } from "./token.service";

/**
 * Verifies the backend's own short-lived access token on every protected route.
 *
 * Replaced the earlier FirebaseAuthGuard. Firebase is gone entirely — it is not
 * consulted at login, at signup, or anywhere else; AuthService verifies an argon2id
 * password hash directly and this backend signs its own JWTs. (The wording here used
 * to claim Firebase was still consulted at /auth/login and /auth/signup, which has
 * not been true since that removal.)
 *
 * Issuing our own token is also what makes real signature verification possible in
 * the frontend's Edge middleware: Firebase Admin cannot run on Edge, jose can.
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

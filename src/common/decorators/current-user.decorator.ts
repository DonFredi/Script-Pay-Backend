import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Role } from "@prisma/client";

export interface AuthenticatedUser {
  id: string;
  email: string;
  role: Role;
  tenantId: string | null;
}

/**
 * Populated by AccessTokenGuard after verifying the backend's own JWT. Firebase is
 * only ever consulted at login/signup time (see AuthService) — every other request
 * trusts the claims embedded in this token, which were set by us, from our own
 * database, at the moment the token was issued.
 */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthenticatedUser => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});

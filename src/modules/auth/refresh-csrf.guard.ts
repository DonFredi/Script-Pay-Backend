import { ExecutionContext, Injectable } from "@nestjs/common";
import type { Request } from "express";
import { CsrfGuard } from "../../common/guards/csrf.guard";

// Same cookie name AuthController/ProfileController use. Duplicated here rather
// than imported from a controller, matching how those two already each declare
// their own copy.
const REFRESH_COOKIE = "refresh_token";

/**
 * CsrfGuard for POST /auth/refresh, with one narrow exemption: a request carrying
 * no refresh_token cookie at all.
 *
 * Plain CsrfGuard would 403 a logged-out visitor, because their browser sends
 * neither the csrf-token cookie nor the header. That breaks a contract the
 * frontend depends on and documents by name in AuthProvider.tsx: on first load it
 * calls this endpoint blind to find out whether a session exists, and expects
 * `{ accessToken: null }` — "not an error" — when one doesn't.
 *
 * Exempting that case costs nothing, because it is exactly the case the handler
 * already treats as a no-op: with no refresh_token it returns immediately, before
 * issuing a single cookie or touching the database. There is no state change for
 * a forged request to cause, and nothing readable for it to return. The moment a
 * session cookie IS present — the only situation where a forged refresh could
 * rotate someone's token — full CSRF validation applies.
 */
@Injectable()
export class RefreshCsrfGuard extends CsrfGuard {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();

    if (!request.cookies?.[REFRESH_COOKIE]) {
      return true;
    }

    return super.canActivate(context);
  }
}

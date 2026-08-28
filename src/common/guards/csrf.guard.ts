import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";
import { Request } from "express";
import { createHash, randomBytes } from "crypto";

/**
 * CSRF Protection Guard
 *
 * Double-submit cookie pattern:
 * 1. On login, set CSRF token in non-httpOnly cookie
 * 2. Frontend must send same token in X-CSRF-Token header
 * 3. Backend verifies they match
 *
 * Protection against: Cross-Site Request Forgery attacks
 * Does NOT protect: GET requests (only POST, PUT, DELETE, PATCH)
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly logger = new Logger(CsrfGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const method = request.method.toUpperCase();

    // Only protect state-changing methods
    if (!["POST", "PUT", "DELETE", "PATCH"].includes(method)) {
      return true; // GET, HEAD, OPTIONS are safe
    }

    // Skip CSRF for webhooks (they come from Safaricom, not browser)
    if (request.path.includes("/webhooks/")) {
      return true;
    }

    // Read token from cookie (set by browser automatically)
    const tokenFromCookie = request.cookies?.["csrf-token"];

    // Read token from header (frontend must include it)
    const tokenFromHeader = request.headers["x-csrf-token"] as string;

    // Both must exist
    if (!tokenFromCookie || !tokenFromHeader) {
      this.logger.warn(
        `CSRF token missing: endpoint=${request.path}, method=${method}, hasCookie=${!!tokenFromCookie}, hasHeader=${!!tokenFromHeader}`,
      );
      throw new ForbiddenException("CSRF token missing");
    }

    // They must match (double-submit validation)
    if (tokenFromCookie !== tokenFromHeader) {
      this.logger.warn(`CSRF token mismatch: endpoint=${request.path}, method=${method}`);
      throw new ForbiddenException("CSRF token mismatch");
    }

    // Token is valid
    return true;
  }
}

/**
 * Generate a new CSRF token
 * Call this after login to give client a new token
 *
 * @returns 64-character hex string (256 bits of entropy)
 */
export function generateCsrfToken(): string {
  const randomData = randomBytes(32);
  return createHash("sha256").update(randomData).digest("hex");
}

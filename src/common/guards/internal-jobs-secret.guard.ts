import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { Request } from "express";
import { timingSafeEqual } from "crypto";

/**
 * Guards the job-trigger endpoints, which an external scheduler calls on a timer
 * (see InternalJobsController and job-scheduling.ts).
 *
 * These routes move money: they settle transactions, write ledger entries and
 * release payout reservations. An unauthenticated caller who found the path could
 * drive the pollers as fast as they liked. Nothing else in this codebase fits —
 * ApiKeyGuard resolves a tenant, and these jobs are deliberately cross-tenant;
 * AccessTokenGuard wants a human session a cron does not have.
 *
 * The secret travels in a HEADER rather than the `?token=` query param
 * DarajaWebhookSecretGuard has to use. That guard has no choice: Safaricom builds
 * the callback URL from what we register with them. Here we control both ends, and
 * a header keeps the secret out of access logs, proxy logs and browser history.
 *
 * Fails closed when INTERNAL_JOBS_SECRET is unset — an empty expected value must
 * never match an empty provided one, or forgetting to configure the secret would
 * silently expose the endpoints instead of disabling them.
 */
@Injectable()
export class InternalJobsSecretGuard implements CanActivate {
  private readonly logger = new Logger(InternalJobsSecretGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = process.env.INTERNAL_JOBS_SECRET ?? "";
    const headerValue = request.headers["x-internal-jobs-secret"];
    const provided = typeof headerValue === "string" ? headerValue : "";

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);

    // timingSafeEqual throws on length mismatch rather than returning false, so the
    // length comparison has to come first. Leaking "wrong length" is not meaningful
    // against a 256-bit random secret.
    const isValid =
      expectedBuf.length > 0 && expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);

    if (!isValid) {
      this.logger.warn(
        `Rejected internal job trigger with invalid/missing secret: path=${request.path}` +
          (expected.length === 0 ? " (INTERNAL_JOBS_SECRET is not configured — every call will be rejected)" : ""),
      );
      throw new ForbiddenException("Invalid job secret");
    }

    return true;
  }
}

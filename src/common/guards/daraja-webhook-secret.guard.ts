import { CanActivate, ExecutionContext, ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { Request } from "express";
import { timingSafeEqual } from "crypto";

/**
 * Daraja never signs its webhook payloads, so a shared secret is the only thing
 * that tells a genuine Safaricom callback apart from anyone who discovers a
 * `/v1/webhooks/daraja/*` path and POSTs a forged one. The secret is embedded as
 * a `?token=` query param in the CallBackURL/ResultURL/QueueTimeOutURL/
 * ConfirmationURL registered with Safaricom (see DarajaClient.buildWebhookUrl) and
 * checked here on every inbound callback.
 *
 * IP-allowlisting Safaricom's published callback ranges at the load balancer/WAF
 * is still recommended as defense in depth — this guard doesn't replace that.
 */
@Injectable()
export class DarajaWebhookSecretGuard implements CanActivate {
  private readonly logger = new Logger(DarajaWebhookSecretGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const expected = process.env.DARAJA_WEBHOOK_SECRET ?? "";
    const provided = typeof request.query?.token === "string" ? request.query.token : "";

    const expectedBuf = Buffer.from(expected);
    const providedBuf = Buffer.from(provided);

    // timingSafeEqual throws on mismatched buffer lengths rather than returning
    // false, so the length check must happen first — an attacker learning "the
    // token is the wrong length" isn't a meaningful leak against a 256-bit secret.
    const isValid =
      expectedBuf.length > 0 && expectedBuf.length === providedBuf.length && timingSafeEqual(expectedBuf, providedBuf);

    if (!isValid) {
      this.logger.warn(`Rejected Daraja webhook call with invalid/missing token: path=${request.path}`);
      throw new ForbiddenException("Invalid webhook token");
    }

    return true;
  }
}

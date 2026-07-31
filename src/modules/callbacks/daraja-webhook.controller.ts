import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { WebhookThrottle } from "../../common/throttle-tiers";
import { SkipResponseTransform } from "../../common/decorators/skip-response-transform.decorator";
import { WebhookIngestService } from "./webhook-ingest.service";

/**
 * Design principle: this endpoint does the MINIMUM possible work — record the raw
 * event (idempotently) and enqueue it, then return 200 immediately. Safaricom retries
 * callbacks aggressively on anything other than a fast 2xx; the actual business logic
 * (updating transaction status, writing ledger entries) happens in a queue consumer
 * (see reconciliation/webhook-processor) where retries and failures are handled
 * explicitly instead of by hoping Safaricom's retry timing lines up with our processing time.
 *
 * No signature verification exists on Daraja callbacks (Safaricom doesn't HMAC-sign them).
 * Trust is instead established by matching the callback's CheckoutRequestID against a
 * transaction WE initiated and are expecting — an unsolicited callback for an unknown
 * CheckoutRequestID is logged and dropped, never blindly trusted.
 *
 * @SkipResponseTransform on the whole controller: Safaricom expects exactly
 * { ResultCode, ResultDesc } back, not our {success, message, statusCode, payload}
 * envelope — wrapping this would likely make Daraja treat it as a failed callback.
 */
@Controller("v1/webhooks/daraja")
@UseGuards(ThrottlerGuard)
@WebhookThrottle()
@SkipResponseTransform()
export class DarajaWebhookController {
  constructor(private readonly ingest: WebhookIngestService) {}

  @Post("stk-callback")
  @HttpCode(200)
  async handleStkCallback(@Body() rawPayload: unknown) {
    await this.ingest.ingest("daraja_stk_callback", rawPayload);
    // Always 200 — once accepted into our system, Safaricom's job is done.
    // Any downstream processing failure is OUR problem to retry, not theirs.
    return { ResultCode: 0, ResultDesc: "Accepted" };
  }

  @Post("c2b-confirmation")
  @HttpCode(200)
  async handleC2bConfirmation(@Body() rawPayload: unknown) {
    await this.ingest.ingest("daraja_c2b_confirmation", rawPayload);
    return { ResultCode: 0, ResultDesc: "Accepted" };
  }
}

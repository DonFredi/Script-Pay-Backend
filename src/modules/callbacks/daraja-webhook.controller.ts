import { Body, Controller, HttpCode, Post, UseGuards, Logger, BadRequestException } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { WebhookThrottle } from "../../common/throttle-tiers";
import { SkipResponseTransform } from "../../common/decorators/skip-response-transform.decorator";
import { DarajaWebhookSecretGuard } from "../../common/guards/daraja-webhook-secret.guard";
import { WebhookIngestService } from "./webhook-ingest.service";
import { WebhookPollerService } from "./webhook-poller.service";
import { redactCallbackPayload } from "./redact-callback-payload";

/**
 * Daraja Webhook Controller
 *
 * Receives callbacks from Safaricom M-Pesa for:
 * 1. STK Push (payment prompt) responses
 * 2. C2B (paybill/till) confirmations
 *
 * Design:
 * - Return 200 OK immediately (Safaricom requirement)
 * - Actual processing happens async (see webhook-processor)
 * - Idempotency handled via unique constraint on (source, naturalKey)
 *
 * @SkipResponseTransform: Safaricom expects exactly { ResultCode, ResultDesc }
 * not our {success, message, statusCode, payload} envelope
 *
 * DarajaWebhookSecretGuard: Daraja doesn't sign its payloads, so every route here
 * requires a `?token=` query param matching DARAJA_WEBHOOK_SECRET — see that
 * guard's own doc comment. Without it, this controller would accept a forged
 * callback from anyone who discovered the path.
 */
@Controller("v1/webhooks/daraja")
@UseGuards(ThrottlerGuard, DarajaWebhookSecretGuard)
@WebhookThrottle()
@SkipResponseTransform()
export class DarajaWebhookController {
  private readonly logger = new Logger(DarajaWebhookController.name);

  constructor(
    private readonly ingest: WebhookIngestService,
    private readonly poller: WebhookPollerService,
  ) {}

  /**
   * Nudges the poller to drain what was just ingested, WITHOUT awaiting it — the 200
   * to Safaricom must not wait on our own processing.
   *
   * The row in `webhook_events` is still the queue and the scheduled poll is still
   * what guarantees delivery; this only removes the waiting. Under
   * `JOB_SCHEDULER=external` the scheduler is Supabase Cron, and pg_cron's finest
   * granularity is one minute — so a customer could enter their M-Pesa PIN and the
   * merchant's dashboard would keep saying PROCESSING for up to a further 60 seconds,
   * purely because nothing looked at the row. The instance is already awake and
   * holding this request; draining now costs nothing and makes settlement land in
   * about the time the DB round-trips take.
   *
   * Safe to fire on every callback, duplicates included: `pollUnprocessedEvents` no-ops
   * when a run is already in flight, and each transition locks its transaction row
   * before reading it, so a poll racing the cron cannot double-settle anything.
   *
   * The `.catch()` is not optional — an unhandled rejection from a floating promise
   * terminates the Node process by default, which would turn a single bad callback
   * into a backend-wide outage. Same reasoning as `ApiKeyGuard`'s `lastUsedAt` write.
   */
  private kickProcessing(): void {
    this.poller.pollUnprocessedEvents().catch((error: unknown) => {
      this.logger.warn(`Post-ingest processing kick failed, leaving it to the scheduled poll: ${String(error)}`);
    });
  }

  /**
   * STK Push Callback
   * Safaricom calls this when user enters PIN (or cancels)
   *
   * Expected response: { ResultCode: 0, ResultDesc: "Accepted" }
   */
  @Post("stk-callback")
  @HttpCode(200)
  async handleStkCallback(@Body() rawPayload: unknown) {
    try {
      this.logger.log("Received STK callback");

      // Validate basic structure
      if (!rawPayload || typeof rawPayload !== "object") {
        throw new BadRequestException("Invalid payload: must be an object");
      }

      // Ingest webhook (stores in DB, queues for processing)
      await this.ingest.ingest("daraja_stk_callback", rawPayload);
      this.kickProcessing();

      // Always return 200 to Safaricom (success or not, we've accepted it)
      return { ResultCode: 0, ResultDesc: "Accepted" };
    } catch (error) {
      // Log error but still return 200 (so Safaricom doesn't retry indefinitely)
      this.logger.error(`Failed to ingest STK callback: ${String(error)}`, {
        error: String(error),
        // Never the raw payload — it carries the payer's phone number, name and
        // amount. See redact-callback-payload.ts.
        ...redactCallbackPayload(rawPayload),
      });

      // Return 200 anyway (Safaricom will eventually stop retrying)
      return { ResultCode: 0, ResultDesc: "Accepted" };
    }
  }

  /**
   * C2B Confirmation Callback
   * Safaricom calls this to confirm payment to paybill/till
   *
   * Expected response: { ResultCode: 0, ResultDesc: "Accepted" }
   */
  @Post("c2b-confirmation")
  @HttpCode(200)
  async handleC2bConfirmation(@Body() rawPayload: unknown) {
    try {
      this.logger.log("Received C2B confirmation callback");

      if (!rawPayload || typeof rawPayload !== "object") {
        throw new BadRequestException("Invalid payload: must be an object");
      }

      await this.ingest.ingest("daraja_c2b_confirmation", rawPayload);
      this.kickProcessing();

      return { ResultCode: 0, ResultDesc: "Accepted" };
    } catch (error) {
      this.logger.error(`Failed to ingest C2B confirmation: ${String(error)}`, {
        error: String(error),
        // Never the raw payload — it carries the payer's phone number, name and
        // amount. See redact-callback-payload.ts.
        ...redactCallbackPayload(rawPayload),
      });

      return { ResultCode: 0, ResultDesc: "Accepted" };
    }
  }

  /**
   * B2C Result Callback (Safaricom -> ResultURL)
   * The authoritative outcome of a payout: whether the money actually left the
   * shortcode. Unlike the sync response to the payment request, a ResultCode of 0
   * here does mean completed.
   */
  @Post("b2c-result")
  @HttpCode(200)
  async handleB2cResult(@Body() rawPayload: unknown) {
    try {
      this.logger.log("Received B2C result callback");

      if (!rawPayload || typeof rawPayload !== "object") {
        throw new BadRequestException("Invalid payload: must be an object");
      }

      await this.ingest.ingest("daraja_b2c_result", rawPayload);
      this.kickProcessing();

      return { ResultCode: 0, ResultDesc: "Accepted" };
    } catch (error) {
      this.logger.error(`Failed to ingest B2C result: ${String(error)}`, {
        error: String(error),
        // Never the raw payload — it carries the payer's phone number, name and
        // amount. See redact-callback-payload.ts.
        ...redactCallbackPayload(rawPayload),
      });

      return { ResultCode: 0, ResultDesc: "Accepted" };
    }
  }

  /**
   * B2C Queue Timeout Callback (Safaricom -> QueueTimeOutURL)
   *
   * Fires when Safaricom couldn't process a payout request within its queue window.
   * This is NOT a failure notice — the payout may still complete and post a real
   * result afterwards — so ingestion is all that happens here; see
   * WebhookPollerService.processB2cTimeout for why nothing is transitioned or
   * released off the back of it.
   */
  @Post("b2c-timeout")
  @HttpCode(200)
  async handleB2cTimeout(@Body() rawPayload: unknown) {
    try {
      this.logger.warn("Received B2C queue-timeout callback");

      if (!rawPayload || typeof rawPayload !== "object") {
        throw new BadRequestException("Invalid payload: must be an object");
      }

      await this.ingest.ingest("daraja_b2c_timeout", rawPayload);
      this.kickProcessing();

      return { ResultCode: 0, ResultDesc: "Accepted" };
    } catch (error) {
      this.logger.error(`Failed to ingest B2C timeout: ${String(error)}`, {
        error: String(error),
        // Never the raw payload — it carries the payer's phone number, name and
        // amount. See redact-callback-payload.ts.
        ...redactCallbackPayload(rawPayload),
      });

      return { ResultCode: 0, ResultDesc: "Accepted" };
    }
  }
}

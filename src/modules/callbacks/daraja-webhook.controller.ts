import { Body, Controller, HttpCode, Post, UseGuards, Logger, BadRequestException } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { WebhookThrottle } from "../../common/throttle-tiers";
import { SkipResponseTransform } from "../../common/decorators/skip-response-transform.decorator";
import { WebhookIngestService } from "./webhook-ingest.service";

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
 */
@Controller("v1/webhooks/daraja")
@UseGuards(ThrottlerGuard)
@WebhookThrottle()
@SkipResponseTransform()
export class DarajaWebhookController {
  private readonly logger = new Logger(DarajaWebhookController.name);

  constructor(private readonly ingest: WebhookIngestService) {}

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

      // Always return 200 to Safaricom (success or not, we've accepted it)
      return { ResultCode: 0, ResultDesc: "Accepted" };
    } catch (error) {
      // Log error but still return 200 (so Safaricom doesn't retry indefinitely)
      this.logger.error(`Failed to ingest STK callback: ${error}`, {
        error: String(error),
        payload: rawPayload,
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

      return { ResultCode: 0, ResultDesc: "Accepted" };
    } catch (error) {
      this.logger.error(`Failed to ingest C2B confirmation: ${error}`, {
        error: String(error),
        payload: rawPayload,
      });

      return { ResultCode: 0, ResultDesc: "Accepted" };
    }
  }
}

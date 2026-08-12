import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { extractNaturalKey } from "./extract-natural-key";
import type { DarajaStkCallback, DarajaC2bCallback, NormalizedWebhookPayload } from "./daraja-callback.interface";

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Ingest raw webhook from Safaricom
   *
   * This is the IDEMPOTENCY boundary:
   * 1. Extract unique key from payload
   * 2. Check if already processed (unique constraint)
   * 3. Store raw event in database
   * 4. Queue for async processing (webhook-processor)
   *
   * This method returns immediately (200 OK to Safaricom)
   * Actual business logic happens async in webhook-processor
   */
  async ingest(source: "daraja_stk_callback" | "daraja_c2b_confirmation", rawPayload: unknown): Promise<void> {
    // 1. Validate payload structure
    if (!rawPayload || typeof rawPayload !== "object") {
      this.logger.warn(`Invalid ${source} payload: not an object`, { rawPayload });
      throw new BadRequestException(`Invalid ${source} payload`);
    }

    // 2. Extract unique key (for idempotency)
    const naturalKey = extractNaturalKey(source, rawPayload);
    if (!naturalKey) {
      this.logger.warn(`No extractable natural key from ${source} callback`, { rawPayload });
      throw new BadRequestException("Cannot extract unique identifier from callback");
    }

    this.logger.log(`Ingesting ${source} callback: ${naturalKey}`);

    try {
      // 3. Store webhook event (idempotently via unique constraint)
      const event = await this.prisma.webhookEvent.create({
        data: {
          source,
          naturalKey,
          //   status: "pending",
          payload: rawPayload as object,
        },
      });

      this.logger.log(`Stored webhook event: ${event.id} (${naturalKey})`);

      // 4. Queue for async processing
      // The processor will run independently and retry on failure
      //   try {
      //     await this.processor.enqueueForProcessing(event.id, source, rawPayload);
      //   } catch (queueError) {
      //     // If queueing fails, that's OK — webhook-poller will pick it up
      //     this.logger.warn(`Failed to queue webhook for processing: ${queueError}`, { eventId: event.id });
      //   }

      return;
    } catch (error: unknown) {
      // Handle database errors
      if (isUniqueConstraintViolation(error)) {
        // This webhook was already processed — that's expected
        // Safaricom retries aggressively, we handle it gracefully
        this.logger.log(`Duplicate ${source} callback for ${naturalKey} — already recorded`);
        return;
      }

      // Unexpected database error
      this.logger.error(`Failed to store webhook event: ${error}`, {
        source,
        naturalKey,
        error: String(error),
      });
      throw error;
    }
  }

  /**
   * Manually normalize a Daraja callback to our internal format
   * (For testing or manual processing)
   */
  normalizePayload(
    source: "daraja_stk_callback" | "daraja_c2b_confirmation",
    rawPayload: unknown,
  ): NormalizedWebhookPayload {
    if (source === "daraja_stk_callback") {
      return this.normalizeStkCallback(rawPayload);
    } else {
      return this.normalizeC2bCallback(rawPayload);
    }
  }

  private normalizeStkCallback(rawPayload: unknown): NormalizedWebhookPayload {
    if (!rawPayload || typeof rawPayload !== "object") {
      throw new BadRequestException("Invalid STK callback payload");
    }

    const payload = rawPayload as DarajaStkCallback;
    const stk = payload.Body?.stkCallback;

    if (!stk) {
      throw new BadRequestException("Missing Body.stkCallback in STK callback");
    }

    // Extract metadata items
    const metadata = stk.CallbackMetadata?.Item ?? [];
    const metaMap = new Map(metadata.map((item) => [item.Name, item.Value]));

    return {
      checkoutRequestId: stk.CheckoutRequestID,
      mpesaReceiptNumber: metaMap.get("MpesaReceiptNumber") as string | undefined,
      resultCode: stk.ResultCode,
      resultDesc: stk.ResultDesc,
      success: stk.ResultCode === 0,
      amount: metaMap.get("Amount") ? Number(metaMap.get("Amount")) : undefined,
      transactionDate: metaMap.get("TransactionDate") ? new Date(String(metaMap.get("TransactionDate"))) : undefined,
      msisdn: metaMap.get("PhoneNumber") ? String(metaMap.get("PhoneNumber")) : undefined,
      callbackType: "stk_push",
      receivedAt: new Date(),
      rawPayload,
    };
  }

  private normalizeC2bCallback(rawPayload: unknown): NormalizedWebhookPayload {
    if (!rawPayload || typeof rawPayload !== "object") {
      throw new BadRequestException("Invalid C2B callback payload");
    }

    const payload = rawPayload as DarajaC2bCallback;
    const stk = payload.Body?.stkCallback;

    if (!stk) {
      throw new BadRequestException("Missing Body.stkCallback in C2B callback");
    }

    const metadata = stk.CallbackMetadata?.Item ?? [];
    const metaMap = new Map(metadata.map((item) => [item.Name, item.Value]));

    return {
      checkoutRequestId: stk.CheckoutRequestID,
      mpesaReceiptNumber: metaMap.get("MpesaReceiptNumber") as string | undefined,
      resultCode: stk.ResultCode,
      resultDesc: stk.ResultDesc,
      success: stk.ResultCode === 0,
      amount: metaMap.get("Amount") ? Number(metaMap.get("Amount")) : undefined,
      transactionDate: metaMap.get("TransactionDate") ? new Date(String(metaMap.get("TransactionDate"))) : undefined,
      msisdn: metaMap.get("PhoneNumber") ? String(metaMap.get("PhoneNumber")) : undefined,
      callbackType: "c2b",
      receivedAt: new Date(),
      rawPayload,
    };
  }
}

/**
 * Check if error is a unique constraint violation (duplicate webhook)
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002"
  );
}

import { Injectable, Logger, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { extractNaturalKey } from "./extract-natural-key";
import type {
  DarajaStkCallback,
  DarajaC2bCallback,
  NormalizedWebhookPayload,
  WebhookSource,
} from "./daraja-callback.interface";

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
  async ingest(source: WebhookSource, rawPayload: unknown): Promise<void> {
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
          payload: rawPayload,
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
      this.logger.error(`Failed to store webhook event: ${String(error)}`, {
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
      amount: metaMap.get("Amount") !== undefined ? Number(metaMap.get("Amount")) : undefined,
      transactionDate: parseDarajaTimestamp(metaMap.get("TransactionDate")),
      msisdn: metaMap.get("PhoneNumber") !== undefined ? String(metaMap.get("PhoneNumber")) : undefined,
      callbackType: "stk_push",
      receivedAt: new Date(),
      rawPayload,
    };
  }

  private normalizeC2bCallback(rawPayload: unknown): NormalizedWebhookPayload {
    if (!rawPayload || typeof rawPayload !== "object") {
      throw new BadRequestException("Invalid C2B callback payload");
    }

    // A C2B confirmation is FLAT — it has no Body.stkCallback wrapper, no
    // CheckoutRequestID and no CallbackMetadata. This method used to read the STK
    // shape, so it threw "Missing Body.stkCallback" on every genuine C2B payload
    // Safaricom sends. TransID is the only identifier such a payload carries, which
    // is why extractNaturalKey keys C2B idempotency on it.
    const payload = rawPayload as DarajaC2bCallback;

    if (typeof payload.TransID !== "string" || payload.TransID.length === 0) {
      throw new BadRequestException("Missing TransID in C2B confirmation");
    }

    return {
      mpesaReceiptNumber: payload.TransID,
      // Safaricom only sends a confirmation for a payment that already went
      // through — there is no failure variant of this callback to represent.
      resultCode: 0,
      resultDesc: "C2B confirmation received",
      success: true,
      amount: payload.TransAmount !== undefined ? Number(payload.TransAmount) : undefined,
      transactionDate: parseDarajaTimestamp(payload.TransTime),
      msisdn: payload.MSISDN !== undefined ? String(payload.MSISDN) : undefined,
      callbackType: "c2b",
      receivedAt: new Date(),
      rawPayload,
    };
  }
}

/**
 * Daraja stamps times as YYYYMMDDHHmmss in Nairobi local time (UTC+3), e.g.
 * 20231129133424. That is not a format the Date constructor understands — passing
 * it straight to `new Date(...)` yields an Invalid Date, which is what this code
 * used to do, silently producing a NaN timestamp rather than failing. Parse the
 * fields out explicitly and pin the offset, so the value doesn't shift with
 * whatever timezone the server happens to run in.
 */
export function parseDarajaTimestamp(value: string | number | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;

  const digits = String(value).trim();
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(digits);
  if (!match) return undefined;

  const [, year, month, day, hour, minute, second] = match;
  const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}+03:00`);

  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Check if error is a unique constraint violation (duplicate webhook)
 */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002"
  );
}

import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { extractNaturalKey } from "./extract-natural-key";

@Injectable()
export class WebhookIngestService {
  private readonly logger = new Logger(WebhookIngestService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * THIS is the idempotency boundary. The unique constraint on (source, naturalKey)
   * in the database — not application logic — is what guarantees a duplicate
   * Safaricom retry can never be processed twice. Previously also enqueued a
   * BullMQ job here; WebhookPollerService now picks up unprocessed rows directly
   * from this table on its own schedule instead (see that file for why).
   */
  async ingest(source: string, rawPayload: unknown): Promise<void> {
    const naturalKey = extractNaturalKey(source, rawPayload);

    if (!naturalKey) {
      this.logger.warn(`Received ${source} callback with no extractable natural key — dropping`, { rawPayload });
      return;
    }

    try {
      await this.prisma.webhookEvent.create({
        data: { source, naturalKey, payload: rawPayload as object },
      });
    } catch (error: unknown) {
      if (isUniqueConstraintViolation(error)) {
        this.logger.log(`Duplicate ${source} callback for ${naturalKey} — already recorded, skipping`);
        return;
      }
      throw error;
    }
  }
}

function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "P2002";
}

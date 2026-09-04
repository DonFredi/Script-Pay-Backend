import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { inProcessCronEnabled } from "../jobs/job-scheduling";
import { createHmac } from "node:crypto";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { CredentialsEncryptionService } from "../tenants/credentials-encryption.service";
import { AlertsService } from "../alerts/alerts.service";

const MAX_ATTEMPTS = 5;
// Indexed by (attempts - 1) at the moment an attempt just failed — 30s, 2m, 10m,
// 30m, 1h. A third-party tenant server can be down for a while; this backs off much
// further than WebhookPollerService's flat 10s retry cadence, which is fine there
// because Safaricom itself also retries independently — here, ScriptPay is the only
// thing that will ever retry.
const BACKOFF_SECONDS = [30, 120, 600, 1800, 3600];
const DELIVERY_TIMEOUT_MS = 10_000;

type PendingDelivery = {
  id: string;
  tenantId: string;
  payload: unknown;
  attempts: number;
  tenant: { webhookUrl: string | null; webhookSecretEncrypted: string | null };
};

/**
 * Outbound mirror of WebhookPollerService: that one polls for unprocessed INBOUND
 * Daraja callbacks; this one polls for unprocessed OUTBOUND TenantWebhookDelivery
 * rows enqueued by TransactionStateMachine.transitionToSettled/transitionToFailed.
 * Same architectural choice (Postgres-table polling over Redis/BullMQ) applied to
 * the other direction — see docs/decisions.md's entry for why WebhookPollerService
 * itself isn't a queue technology.
 */
@Injectable()
export class TenantWebhookPollerService {
  private readonly logger = new Logger(TenantWebhookPollerService.name);
  private isPolling = false; // prevents overlapping runs if one poll takes longer than the interval

  constructor(
    // Scans across every tenant's pending deliveries in one pass, never one tenant
    // at a time — same cross-tenant reasoning as WebhookPollerService. See
    // PrismaPrivilegedService's own doc comment.
    private readonly prisma: PrismaPrivilegedService,
    private readonly encryption: CredentialsEncryptionService,
    private readonly alerts: AlertsService,
  ) {}

  /** Cron entry point — see WebhookPollerService.scheduledPoll for why it's a wrapper. */
  @Cron(CronExpression.EVERY_10_SECONDS)
  async scheduledPoll() {
    if (!inProcessCronEnabled()) return;
    await this.pollPendingDeliveries();
  }

  async pollPendingDeliveries() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const deliveries = await this.prisma.tenantWebhookDelivery.findMany({
        where: { status: "PENDING", nextAttemptAt: { lte: new Date() } },
        orderBy: { nextAttemptAt: "asc" },
        take: 20,
        include: { tenant: { select: { webhookUrl: true, webhookSecretEncrypted: true } } },
      });

      for (const delivery of deliveries) {
        await this.attemptDelivery(delivery);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async attemptDelivery(delivery: PendingDelivery) {
    if (!delivery.tenant.webhookUrl || !delivery.tenant.webhookSecretEncrypted) {
      // The tenant rotated/removed their webhook config after this was enqueued —
      // nothing sane to retry against. Terminal, not a transient failure.
      await this.prisma.tenantWebhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", lastError: "tenant webhook is no longer configured" },
      });
      return;
    }

    const body = JSON.stringify(delivery.payload);
    const secret = this.encryption.decrypt(delivery.tenant.webhookSecretEncrypted);
    const signature = createHmac("sha256", secret).update(body).digest("hex");

    try {
      const response = await fetch(delivery.tenant.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-ScriptPay-Signature": `sha256=${signature}` },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });

      if (response.ok) {
        await this.prisma.tenantWebhookDelivery.update({
          where: { id: delivery.id },
          data: { status: "DELIVERED", deliveredAt: new Date() },
        });
        return;
      }

      await this.recordFailure(delivery, `HTTP ${response.status}`);
    } catch (error) {
      await this.recordFailure(delivery, (error as Error).message);
    }
  }

  private async recordFailure(delivery: PendingDelivery, reason: string) {
    const attempts = delivery.attempts + 1;
    this.logger.warn(`Tenant webhook delivery ${delivery.id} failed (attempt ${attempts}): ${reason}`);

    if (attempts >= MAX_ATTEMPTS) {
      await this.prisma.tenantWebhookDelivery.update({
        where: { id: delivery.id },
        data: { status: "FAILED", attempts, lastError: reason },
      });
      await this.alerts.send({
        title: "Tenant webhook delivery failed after all retries",
        detail: `Delivery ${delivery.id} for tenant ${delivery.tenantId} could not be delivered after ${MAX_ATTEMPTS} attempts.`,
        severity: "critical",
        context: { deliveryId: delivery.id, tenantId: delivery.tenantId, lastError: reason },
      });
      return;
    }

    await this.prisma.tenantWebhookDelivery.update({
      where: { id: delivery.id },
      data: {
        attempts,
        lastError: reason,
        nextAttemptAt: new Date(Date.now() + BACKOFF_SECONDS[attempts - 1] * 1000),
      },
    });
  }
}

import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AlertsService } from "../alerts/alerts.service";

const MAX_ATTEMPTS = 5;

/**
 * Replaces the earlier BullMQ/Redis-based WebhookProcessor. WebhookIngestService
 * already writes every inbound event to Postgres immediately with processedAt:
 * null — that row IS the queue. This polls for unprocessed rows on an interval
 * and processes them directly, removing the Redis dependency at the cost of a
 * small polling delay instead of near-instant processing. Fine at current
 * volume; revisit if throughput ever becomes a real bottleneck.
 */
@Injectable()
export class WebhookPollerService {
  private readonly logger = new Logger(WebhookPollerService.name);
  private isPolling = false; // prevents overlapping runs if one poll takes longer than the interval

  constructor(
    private readonly prisma: PrismaService,
    private readonly stateMachine: TransactionStateMachine,
    private readonly auditLog: AuditLogService,
    private readonly alerts: AlertsService,
  ) {}

  @Cron(CronExpression.EVERY_10_SECONDS)
  async pollUnprocessedEvents() {
    if (this.isPolling) return;
    this.isPolling = true;

    try {
      const events = await this.prisma.webhookEvent.findMany({
        where: { processedAt: null, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { receivedAt: "asc" },
        take: 20,
      });

      for (const event of events) {
        await this.processEvent(event);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async processEvent(event: { id: string; source: string; payload: unknown; attempts: number }) {
    try {
      if (event.source === "daraja_stk_callback") {
        await this.processStkCallback(event.payload as any);
      } else if (event.source === "daraja_c2b_confirmation") {
        await this.processC2bConfirmation(event.payload as any);
      }

      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
    } catch (error) {
      const newAttempts = event.attempts + 1;
      this.logger.error(`Failed processing webhook event ${event.id} (attempt ${newAttempts})`, error as Error);

      await this.prisma.webhookEvent.update({
        where: { id: event.id },
        data: { attempts: newAttempts, processingError: (error as Error).message },
      });

      if (newAttempts >= MAX_ATTEMPTS) {
        await this.alerts.send({
          title: "Webhook processing failed after all retries",
          detail: `Event ${event.id} (${event.source}) could not be processed after ${MAX_ATTEMPTS} attempts.`,
          severity: "critical",
          context: { webhookEventId: event.id, source: event.source, errorMessage: (error as Error).message },
        });
      }
    }
  }

  private async processStkCallback(payload: any) {
    const stkCallback = payload?.Body?.stkCallback;
    const checkoutRequestId = stkCallback?.CheckoutRequestID;
    const resultCode = stkCallback?.ResultCode;

    const transaction = await this.prisma.transaction.findUnique({ where: { checkoutRequestId } });

    if (!transaction) {
      this.logger.warn(`Callback for unknown CheckoutRequestID ${checkoutRequestId} — ignoring`);
      await this.auditLog.record({
        actorType: "system",
        action: "daraja.callback_unmatched",
        metadata: { checkoutRequestId },
      });
      return;
    }

    if (resultCode === 0) {
      const metadata = stkCallback.CallbackMetadata?.Item ?? [];
      const receiptItem = metadata.find((i: any) => i.Name === "MpesaReceiptNumber");
      await this.stateMachine.transitionToSettled(transaction.id, { mpesaReceiptNumber: receiptItem?.Value });
      await this.auditLog.record({
        tenantId: transaction.tenantId,
        actorType: "system",
        action: "daraja.callback_settled",
        targetType: "Transaction",
        targetId: transaction.id,
        metadata: { checkoutRequestId, mpesaReceiptNumber: receiptItem?.Value },
      });
    } else {
      await this.stateMachine.transitionToFailed(transaction.id, {
        failureReason: stkCallback.ResultDesc ?? "unknown_failure",
      });
      await this.auditLog.record({
        tenantId: transaction.tenantId,
        actorType: "system",
        action: "daraja.callback_failed",
        targetType: "Transaction",
        targetId: transaction.id,
        metadata: { checkoutRequestId, resultCode, resultDesc: stkCallback.ResultDesc },
      });
      await this.alerts.send({
        title: "STK push failed at Safaricom",
        detail: `Transaction ${transaction.id}: ${stkCallback.ResultDesc ?? "no reason given"}.`,
        severity: "warning",
        context: { transactionId: transaction.id, tenantId: transaction.tenantId, resultCode },
      });
    }
  }

  private async processC2bConfirmation(payload: any) {
    const businessShortCode = payload?.BusinessShortCode;
    const transId = payload?.TransID;
    const amount = payload?.TransAmount;
    const msisdn = payload?.MSISDN;
    const channel = payload?.TransactionType === "Buy Goods" ? "TILL" : "PAYBILL";

    // Scoped to status: 'active' to match the partial unique index on
    // businessShortcode (prisma/manual-sql/002_tenant_shortcode_unique_active.sql) —
    // pending_kyc tenants may share Safaricom's sandbox shortcode while testing, so
    // only an active tenant can be the unambiguous real target for a live payment.
    const matches = await this.prisma.tenant.findMany({
      where: { businessShortcode: businessShortCode, status: "active" },
    });

    if (matches.length === 0) {
      this.logger.warn(`C2B confirmation for unknown/inactive shortcode ${businessShortCode} — ignoring`);
      await this.auditLog.record({
        actorType: "system",
        action: "daraja.c2b_unmatched",
        metadata: { businessShortCode, transId },
      });
      return;
    }

    if (matches.length > 1) {
      // Should be unreachable given the partial unique index — if this ever fires,
      // something bypassed it (a manual DB edit, the index missing in this
      // environment). Refuse to guess which tenant a real customer payment belongs
      // to; fail loudly instead of silently misrouting money.
      this.logger.error(
        `C2B confirmation for shortcode ${businessShortCode} matched ${matches.length} active tenants — refusing to process`,
      );
      await this.auditLog.record({
        actorType: "system",
        action: "daraja.c2b_ambiguous_shortcode",
        metadata: { businessShortCode, transId, matchedTenantIds: matches.map((t) => t.id) },
      });
      await this.alerts.send({
        title: "Ambiguous C2B shortcode match — payment not processed",
        detail: `${matches.length} active tenants share shortcode ${businessShortCode}. A real customer payment (${transId}) could not be safely routed.`,
        severity: "critical",
        context: { businessShortCode, transId, matchedTenantIds: matches.map((t) => t.id) },
      });
      return;
    }

    const tenant = matches[0];

    const amountMinorUnits = Math.round(Number(amount) * 100);

    const transaction = await this.stateMachine.recordInboundSettlement({
      tenantId: tenant.id,
      channel,
      amountMinorUnits,
      msisdn,
      mpesaReceiptNumber: transId,
    });

    await this.auditLog.record({
      tenantId: tenant.id,
      actorType: "system",
      action: "daraja.c2b_settled",
      targetType: "Transaction",
      targetId: transaction.id,
      metadata: { transId, amountMinorUnits, channel },
    });
  }
}

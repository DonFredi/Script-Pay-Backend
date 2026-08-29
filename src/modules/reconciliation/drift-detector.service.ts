import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { TenantsService } from "../tenants/tenants.service";
import { AlertsService } from "../alerts/alerts.service";
import { AuditLogService } from "../audit-log/audit-log.service";

/**
 * Webhooks can be lost (network blips, our own downtime during a deploy). This job
 * is the safety net: periodically, find transactions stuck in PROCESSING past a
 * reasonable window and actively query Daraja's transaction status API rather than
 * waiting indefinitely for a callback that may never arrive.
 *
 * This is what turns reconciliation from "hope the callback arrives" into an
 * active, provable process — the actual pain point named at the start of this project.
 */
@Injectable()
export class DriftDetectorService {
  private readonly logger = new Logger(DriftDetectorService.name);
  private static readonly STUCK_THRESHOLD_MINUTES = 15;

  /**
   * Payouts get a tighter window than collections. A stuck collection means a customer's
   * money may or may not have arrived; a stuck payout means the TENANT's funds are
   * already reserved and unspendable while nobody knows whether they left. The second
   * costs the tenant something every minute it goes unresolved.
   */
  private static readonly PAYOUT_STUCK_THRESHOLD_MINUTES = 5;

  constructor(
    // Scans across every tenant's stuck transactions in one pass — see
    // PrismaPrivilegedService's own doc comment.
    private readonly prisma: PrismaPrivilegedService,
    private readonly daraja: DarajaClient,
    private readonly stateMachine: TransactionStateMachine,
    private readonly tenantsService: TenantsService,
    private readonly alerts: AlertsService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectStuckTransactions() {
    const cutoff = new Date(Date.now() - DriftDetectorService.STUCK_THRESHOLD_MINUTES * 60_000);

    const stuckTransactions = await this.prisma.transaction.findMany({
      // The direction filter is load-bearing, not cosmetic. Before payouts existed
      // this query matched every PROCESSING row, and a B2C row reaching the loop
      // below would be handed to queryStkPushStatus — an API that knows nothing
      // about it. It happened to be skipped only because `if
      // (!transaction.checkoutRequestId) continue` caught the null column, which is
      // an accident of schema shape rather than a decision, and it meant stuck
      // payouts were silently ignored forever. They are handled by
      // detectStuckPayouts below instead.
      where: { status: "PROCESSING", direction: "INBOUND", updatedAt: { lt: cutoff } },
      take: 100, // bounded batch — never let one run try to process an unbounded backlog
    });

    if (stuckTransactions.length === 0) return;

    this.logger.log(`Found ${stuckTransactions.length} transactions stuck in PROCESSING — querying Daraja directly`);

    for (const transaction of stuckTransactions) {
      if (!transaction.checkoutRequestId) continue;

      try {
        const credentials = await this.tenantsService.getMpesaCredentialsForPayment(transaction.tenantId);
        const status = await this.daraja.queryStkPushStatus(credentials, transaction.checkoutRequestId);
        // Re-inject the queried result through the SAME idempotent path a webhook would use,
        // rather than duplicating state-transition logic here.
        await this.recordDriftAndReconcile(transaction.id, status);
      } catch (error) {
        this.logger.error(`Failed to query Daraja status for transaction ${transaction.id}`, error as Error);
      }
    }
  }

  /**
   * Payout counterpart to detectStuckTransactions. Deliberately does NOT resolve the
   * transaction itself, and that limitation is the whole design note here.
   *
   * The collection path can self-heal because Daraja's STK Push Query API answers
   * SYNCHRONOUSLY — ask it, get a ResultCode, apply it. Daraja's Transaction Status
   * API, the equivalent for a payout, does not: it accepts the query and posts the
   * real answer to a ResultURL later, which means auto-recovery here needs its own
   * callback route, its own ingest source, and a stored correlation between the
   * status query and the payout it was asking about (the query gets a fresh
   * OriginatorConversationID; the payout's own is not echoed back in a way that can
   * be relied on). That is a genuine piece of work, not a line of code, and guessing
   * at Safaricom's correlation semantics on a money-recovery path is exactly the kind
   * of invention this codebase has been bitten by before.
   *
   * So: escalate to a human, every stuck payout, exactly once. That is strictly better
   * than the previous behaviour, which was to silently skip them forever. Auto-recovery
   * is the follow-up, and this is the hook it will attach to.
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectStuckPayouts() {
    const cutoff = new Date(Date.now() - DriftDetectorService.PAYOUT_STUCK_THRESHOLD_MINUTES * 60_000);

    const stuckPayouts = await this.prisma.transaction.findMany({
      where: { status: "PROCESSING", direction: "OUTBOUND", updatedAt: { lt: cutoff } },
      take: 100,
    });

    if (stuckPayouts.length === 0) return;

    this.logger.warn(`Found ${stuckPayouts.length} payouts stuck in PROCESSING — escalating`);

    for (const payout of stuckPayouts) {
      try {
        // A drift-flagged record means this payout was already escalated on an earlier
        // run. Without this check the cron would re-alert every five minutes for as
        // long as the payout stays unresolved, which trains people to ignore the alert.
        const existing = await this.prisma.reconciliationRecord.findUnique({
          where: { transactionId: payout.id },
        });
        if (existing?.driftDetected) continue;

        await this.prisma.reconciliationRecord.upsert({
          where: { transactionId: payout.id },
          create: {
            tenantId: payout.tenantId,
            transactionId: payout.id,
            expectedAmount: payout.amountMinorUnits,
            driftDetected: true,
          },
          update: { driftDetected: true },
        });

        await this.auditLog.record({
          tenantId: payout.tenantId,
          actorType: "system",
          action: "payout.drift_detected",
          targetType: "Transaction",
          targetId: payout.id,
          metadata: {
            originatorConversationId: payout.originatorConversationId,
            conversationId: payout.conversationId,
            amountMinorUnits: payout.amountMinorUnits,
            stuckSinceMinutes: DriftDetectorService.PAYOUT_STUCK_THRESHOLD_MINUTES,
          },
        });

        await this.alerts.send({
          title: "Payout stuck in PROCESSING — manual reconciliation needed",
          detail:
            `Payout ${payout.id} (tenant ${payout.tenantId}) has been PROCESSING for over ` +
            `${DriftDetectorService.PAYOUT_STUCK_THRESHOLD_MINUTES} minutes with no result callback. ` +
            `Its funds remain reserved and unspendable. Check the payout in Safaricom's portal ` +
            `(OriginatorConversationID ${payout.originatorConversationId ?? "unknown"}) and resolve it there — ` +
            `it will NOT resolve itself.`,
          severity: "critical",
          context: {
            transactionId: payout.id,
            tenantId: payout.tenantId,
            originatorConversationId: payout.originatorConversationId,
            amountMinorUnits: payout.amountMinorUnits,
          },
        });
      } catch (error) {
        // One payout failing to escalate must not stop the rest of the batch.
        this.logger.error(`Failed to escalate stuck payout ${payout.id}`, error as Error);
      }
    }
  }

  private async recordDriftAndReconcile(
    transactionId: string,
    darajaStatus: { resultCode: number; mpesaReceiptNumber?: string; resultDesc?: string },
  ) {
    // Route through the SAME state-machine methods a webhook would call — this active
    // reconciliation path and the passive webhook path must never diverge in how they
    // apply a result, or you get two slightly-different definitions of "settled."
    //
    // resultCode === 0 is Safaricom's own authoritative success signal for this query —
    // settlement must NOT be gated on mpesaReceiptNumber also being present: the STK Push
    // Query API never returns one (only the async callback's CallbackMetadata does), so
    // requiring it here made this branch permanently unreachable. transitionToSettled
    // tolerates a missing receipt number and backfills it later if the real callback
    // eventually arrives.
    if (darajaStatus.resultCode === 0) {
      await this.stateMachine.transitionToSettled(transactionId, {
        mpesaReceiptNumber: darajaStatus.mpesaReceiptNumber,
      });
    } else {
      await this.stateMachine.transitionToFailed(transactionId, {
        failureReason: darajaStatus.resultDesc ?? "resolved_via_drift_detection",
      });
    }

    // The discrepancy stays visible even after resolution — a self-healing drift is
    // still a signal that webhook delivery had a problem, and a rising drift RATE
    // (tracked in aggregate via this flag) is worth alerting on, not just individual cases.
    await this.prisma.reconciliationRecord.updateMany({
      where: { transactionId },
      data: { driftDetected: true },
    });
  }
}

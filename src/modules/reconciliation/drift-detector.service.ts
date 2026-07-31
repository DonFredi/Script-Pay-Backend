import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { TenantsService } from "../tenants/tenants.service";

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

  constructor(
    private readonly prisma: PrismaService,
    private readonly daraja: DarajaClient,
    private readonly stateMachine: TransactionStateMachine,
    private readonly tenantsService: TenantsService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async detectStuckTransactions() {
    const cutoff = new Date(Date.now() - DriftDetectorService.STUCK_THRESHOLD_MINUTES * 60_000);

    const stuckTransactions = await this.prisma.transaction.findMany({
      where: { status: "PROCESSING", updatedAt: { lt: cutoff } },
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

  private async recordDriftAndReconcile(
    transactionId: string,
    darajaStatus: { resultCode: number; mpesaReceiptNumber?: string; resultDesc?: string },
  ) {
    // Route through the SAME state-machine methods a webhook would call — this active
    // reconciliation path and the passive webhook path must never diverge in how they
    // apply a result, or you get two slightly-different definitions of "settled."
    if (darajaStatus.resultCode === 0 && darajaStatus.mpesaReceiptNumber) {
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

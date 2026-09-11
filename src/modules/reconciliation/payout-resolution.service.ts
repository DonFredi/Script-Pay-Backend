import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { AuditLogService } from "../audit-log/audit-log.service";
import type { ResolvePayoutDto } from "./resolve-payout.dto";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

/**
 * The operator-facing counterpart to DriftDetectorService.detectStuckPayouts.
 *
 * A B2C payout only ever moves out of PROCESSING via a real Safaricom callback —
 * DriftDetectorService deliberately never resolves one itself (docs/decisions.md
 * entry 18: auto-recovery would need its own callback route and correlation
 * scheme, and guessing at that on a money-recovery path is exactly the kind of
 * invention this codebase has been bitten by before). Until that's built, a
 * payout Safaricom never answers stays stuck forever without a human.
 *
 * This service is that human's tool, replacing the one-off scripts written
 * directly against PRIVILEGED_DATABASE_URL to unstick the first batch of these
 * (see the incident this follows up on). It goes through the exact same
 * TransactionStateMachine methods a real callback would call — same ledger
 * writes, same webhook-delivery enqueue, same illegal-transition guard — so a
 * manual resolution can never disagree with what a real one would have done.
 */
@Injectable()
export class PayoutResolutionService {
  private readonly logger = new Logger(PayoutResolutionService.name);

  constructor(
    // Cross-tenant by necessity: a SUPER_ADMIN resolving a stuck payout has no
    // single tenant to scope the lookup by until after finding the transaction.
    // Same reasoning as TransactionsController.findOne's SUPER_ADMIN branch.
    private readonly prisma: PrismaPrivilegedService,
    private readonly stateMachine: TransactionStateMachine,
    private readonly auditLog: AuditLogService,
  ) {}

  async resolve(transactionId: string, dto: ResolvePayoutDto, caller: AuthenticatedUser) {
    const transaction = await this.prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!transaction) throw new NotFoundException("Transaction not found");

    if (transaction.direction !== "OUTBOUND") {
      throw new BadRequestException("This route only resolves payouts (direction: OUTBOUND) — not collections");
    }
    if (transaction.status !== "PROCESSING") {
      throw new ConflictException(
        `Payout ${transactionId} is already ${transaction.status} — nothing to resolve. ` +
          "If this needs correcting further, it requires a different action, not this one.",
      );
    }

    // The action name intentionally matches the manual-resolution precedent already
    // in the audit log (docs/decisions.md entry 36) rather than inventing a new one —
    // same shape of event, same namespace as the daraja.b2c_* actions B2cService and
    // WebhookPollerService already write.
    const action = dto.resolution === "SETTLED" ? "daraja.b2c_settled_manual_resolution" : "daraja.b2c_failed_manual_resolution";

    if (dto.resolution === "SETTLED") {
      await this.stateMachine.transitionPayoutToSettled(transactionId, {
        mpesaReceiptNumber: dto.mpesaReceiptNumber,
      });
    } else {
      await this.stateMachine.transitionPayoutToFailed(transactionId, {
        failureReason: `Manually resolved by ${caller.email ?? caller.id}: ${dto.reason}`,
      });
    }

    // Closes out the drift flag DriftDetectorService raised — a resolved payout
    // shouldn't keep reading as an open reconciliation problem.
    await this.prisma.reconciliationRecord.updateMany({
      where: { transactionId },
      data: {
        reconciledAt: new Date(),
        ...(dto.resolution === "SETTLED" ? { confirmedAmount: transaction.amountMinorUnits } : {}),
      },
    });

    await this.auditLog.record({
      tenantId: transaction.tenantId,
      actorType: "user",
      actorId: caller.id,
      action,
      targetType: "Transaction",
      targetId: transactionId,
      metadata: {
        originatorConversationId: transaction.originatorConversationId,
        conversationId: transaction.conversationId,
        amountMinorUnits: transaction.amountMinorUnits,
        resolution: dto.resolution,
        mpesaReceiptNumber: dto.mpesaReceiptNumber ?? null,
        reason: dto.reason,
      },
    });

    this.logger.warn(
      `Payout ${transactionId} (tenant ${transaction.tenantId}) manually resolved as ${dto.resolution} by ${caller.id}`,
    );

    return this.prisma.transaction.findUniqueOrThrow({ where: { id: transactionId } });
  }
}

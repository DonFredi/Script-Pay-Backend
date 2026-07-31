import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { TransactionStatus } from "@prisma/client";

/**
 * Every allowed transition is enumerated. An attempt to move a transaction through
 * an invalid transition (e.g. SETTLED -> PROCESSING) throws instead of silently
 * overwriting state — this is what makes "impossible" states actually impossible,
 * rather than merely unlikely.
 */
const ALLOWED_TRANSITIONS: Record<TransactionStatus, TransactionStatus[]> = {
  PENDING: ["PROCESSING", "FAILED"],
  PROCESSING: ["SETTLED", "FAILED"],
  SETTLED: ["REVERSED"],
  FAILED: [], // terminal — a failed transaction is retried as a NEW transaction, never mutated
  REVERSED: [], // terminal
};

@Injectable()
export class TransactionStateMachine {
  private readonly logger = new Logger(TransactionStateMachine.name);

  constructor(private readonly prisma: PrismaService) {}

  async transitionToSettled(transactionId: string, data: { mpesaReceiptNumber: string }) {
    await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      this.assertTransitionAllowed(transaction.status, "SETTLED");

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "SETTLED", mpesaReceiptNumber: data.mpesaReceiptNumber },
      });

      // Double-entry: credit the tenant's balance, debit a pending-settlement holding account.
      // Two entries, same transaction, always balanced — this IS the ledger, not a side effect of it.
      await tx.ledgerEntry.createMany({
        data: [
          {
            tenantId: transaction.tenantId,
            transactionId: transaction.id,
            account: "tenant_balance",
            direction: "credit",
            amountMinorUnits: transaction.amountMinorUnits,
          },
          {
            tenantId: transaction.tenantId,
            transactionId: transaction.id,
            account: "pending_settlement",
            direction: "debit",
            amountMinorUnits: transaction.amountMinorUnits,
          },
        ],
      });

      await tx.reconciliationRecord.create({
        data: {
          tenantId: transaction.tenantId,
          transactionId: transaction.id,
          expectedAmount: transaction.amountMinorUnits,
          confirmedAmount: transaction.amountMinorUnits,
          reconciledAt: new Date(),
        },
      });
    });
  }

  async transitionToFailed(transactionId: string, data: { failureReason: string }) {
    await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUniqueOrThrow({ where: { id: transactionId } });
      this.assertTransitionAllowed(transaction.status, "FAILED");

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", failureReason: data.failureReason },
      });
    });
  }

  /**
   * For inbound C2B (Paybill/Till) confirmations — these arrive AFTER the customer
   * already paid, with no PENDING transaction of ours to transition through the
   * state machine above. Creates the transaction record already SETTLED, plus the
   * same balanced ledger entries transitionToSettled writes for STK push, in one
   * DB transaction.
   */
  async recordInboundSettlement(params: {
    tenantId: string;
    channel: "PAYBILL" | "TILL";
    amountMinorUnits: number;
    msisdn: string;
    mpesaReceiptNumber: string;
  }) {
    return this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.create({
        data: {
          tenantId: params.tenantId,
          channel: params.channel,
          status: "SETTLED",
          amountMinorUnits: params.amountMinorUnits,
          msisdn: params.msisdn,
          mpesaReceiptNumber: params.mpesaReceiptNumber,
        },
      });

      await tx.ledgerEntry.createMany({
        data: [
          {
            tenantId: params.tenantId,
            transactionId: transaction.id,
            account: "tenant_balance",
            direction: "credit",
            amountMinorUnits: params.amountMinorUnits,
          },
          {
            tenantId: params.tenantId,
            transactionId: transaction.id,
            account: "pending_settlement",
            direction: "debit",
            amountMinorUnits: params.amountMinorUnits,
          },
        ],
      });

      await tx.reconciliationRecord.create({
        data: {
          tenantId: params.tenantId,
          transactionId: transaction.id,
          expectedAmount: params.amountMinorUnits,
          confirmedAmount: params.amountMinorUnits,
          reconciledAt: new Date(),
        },
      });

      return transaction;
    });
  }

  private assertTransitionAllowed(from: TransactionStatus, to: TransactionStatus) {
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw new Error(`Illegal transaction state transition: ${from} -> ${to}`);
    }
  }
}

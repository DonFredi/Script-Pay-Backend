import { Injectable, Logger } from "@nestjs/common";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { Prisma } from "@prisma/client";
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

  // Only ever invoked by WebhookPollerService/DriftDetectorService — both
  // cross-tenant background jobs with no single tenant to scope by. See
  // PrismaPrivilegedService's own doc comment.
  constructor(private readonly prisma: PrismaPrivilegedService) {}

  /**
   * mpesaReceiptNumber is OPTIONAL: DriftDetectorService settles a transaction from
   * Safaricom's STK Push Query API, whose response carries a ResultCode but never a
   * receipt number (that only ever arrives via the async callback's CallbackMetadata,
   * handled by WebhookPollerService). A resultCode of 0 is Safaricom's own authoritative
   * success signal, so settlement must not be gated on a field that API can never supply.
   */
  async transitionToSettled(transactionId: string, data: { mpesaReceiptNumber?: string }) {
    await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { tenant: { select: { webhookUrl: true } } },
      });

      if (transaction.status === "SETTLED") {
        // Already settled — most commonly Safaricom redelivering the same callback, but
        // also the expected shape of a real callback arriving AFTER drift detection already
        // settled this transaction without a receipt number: back-fill it instead of
        // treating "SETTLED -> SETTLED" as an illegal transition.
        if (!transaction.mpesaReceiptNumber && data.mpesaReceiptNumber) {
          await tx.transaction.update({
            where: { id: transactionId },
            data: { mpesaReceiptNumber: data.mpesaReceiptNumber },
          });
          return;
        }
        if (!data.mpesaReceiptNumber || transaction.mpesaReceiptNumber === data.mpesaReceiptNumber) {
          return; // idempotent duplicate delivery — nothing to do
        }
        throw new Error(
          `Transaction ${transactionId} already settled with a different receipt number ` +
            `(existing: ${transaction.mpesaReceiptNumber}, incoming: ${data.mpesaReceiptNumber})`,
        );
      }

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

      // Only on the transition that actually just happened, not the idempotent
      // early-returns above — a redelivered Safaricom callback must never cause a
      // second settlement notification to go out to the tenant.
      await this.enqueueWebhookDelivery(tx, transaction, "SETTLED", data.mpesaReceiptNumber ?? null);
    });
  }

  async transitionToFailed(transactionId: string, data: { failureReason: string }) {
    await this.prisma.$transaction(async (tx) => {
      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { tenant: { select: { webhookUrl: true } } },
      });
      this.assertTransitionAllowed(transaction.status, "FAILED");

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", failureReason: data.failureReason },
      });

      await this.enqueueWebhookDelivery(tx, transaction, "FAILED", null);
    });
  }

  /**
   * Deliberately NOT called from recordInboundSettlement (C2B/Paybill-Till) — that
   * path is out of scope for the ScriptPay-STK-Push-integration module spec this was
   * built for (see Script-Pay-Backend usage notes / scripttagg-leadgen CRM doc
   * Section 16.1), which only asked for notification on the STK-push-initiated
   * settle/fail transitions above. Revisit if a tenant integration ever needs C2B
   * settlement notifications too — not assumed here.
   */
  private async enqueueWebhookDelivery(
    tx: Prisma.TransactionClient,
    transaction: {
      id: string;
      tenantId: string;
      amountMinorUnits: number;
      metadata: unknown;
      mpesaReceiptNumber?: string | null;
      tenant?: { webhookUrl: string | null } | null;
    },
    status: "SETTLED" | "FAILED",
    mpesaReceiptNumber: string | null,
  ) {
    if (!transaction.tenant?.webhookUrl) return;

    await tx.tenantWebhookDelivery.create({
      data: {
        tenantId: transaction.tenantId,
        transactionId: transaction.id,
        payload: {
          transactionId: transaction.id,
          status,
          mpesaReceiptNumber: mpesaReceiptNumber ?? transaction.mpesaReceiptNumber ?? null,
          amountMinorUnits: transaction.amountMinorUnits,
          metadata: transaction.metadata ?? null,
          occurredAt: new Date().toISOString(),
        },
      },
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

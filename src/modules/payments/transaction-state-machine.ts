import { Injectable, Logger } from "@nestjs/common";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { Prisma } from "@prisma/client";
import type { TransactionStatus, TransactionChannel, TransactionDirection } from "@prisma/client";
import { LedgerAccount, LedgerDirection } from "../ledger/ledger.accounts";
import { LedgerService } from "../ledger/ledger.service";

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
  constructor(
    private readonly prisma: PrismaPrivilegedService,
    // Injected for its pure ledger-pair builders only — the balance read and its
    // FOR UPDATE lock belong to the request path, not to these callback-driven
    // transitions, which spend nothing and so have nothing to authorize.
    private readonly ledger: LedgerService,
  ) {}

  /**
   * mpesaReceiptNumber is OPTIONAL: DriftDetectorService settles a transaction from
   * Safaricom's STK Push Query API, whose response carries a ResultCode but never a
   * receipt number (that only ever arrives via the async callback's CallbackMetadata,
   * handled by WebhookPollerService). A resultCode of 0 is Safaricom's own authoritative
   * success signal, so settlement must not be gated on a field that API can never supply.
   */
  async transitionToSettled(transactionId: string, data: { mpesaReceiptNumber?: string }) {
    await this.prisma.$transaction(async (tx) => {
      // Lock BEFORE the read, not after: the point is that the status this method
      // decides on is the status at write time. A lock taken after the read leaves
      // the read itself unprotected, which is the race it exists to close.
      await this.lockTransaction(tx, transactionId);

      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { tenant: { select: { webhookUrl: true } } },
      });

      this.assertNotOutbound(transaction, "transitionToSettled");

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
            account: LedgerAccount.TENANT_BALANCE,
            direction: LedgerDirection.CREDIT,
            amountMinorUnits: transaction.amountMinorUnits,
          },
          {
            tenantId: transaction.tenantId,
            transactionId: transaction.id,
            account: LedgerAccount.PENDING_SETTLEMENT,
            direction: LedgerDirection.DEBIT,
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
      await this.lockTransaction(tx, transactionId);

      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { tenant: { select: { webhookUrl: true } } },
      });
      this.assertNotOutbound(transaction, "transitionToFailed");
      this.assertTransitionAllowed(transaction.status, "FAILED");

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", failureReason: data.failureReason },
      });

      await this.enqueueWebhookDelivery(tx, transaction, "FAILED", null);
    });
  }

  /**
   * Payout counterpart to transitionToSettled — a separate method rather than a
   * branch inside it because THE LEDGER DIRECTION IS OPPOSITE. transitionToSettled
   * credits tenant_balance; putting a payout through it would credit the tenant for
   * money they just sent, drifting the ledger by twice the payout on every single
   * disbursement.
   *
   * The reservation (B2cService, which owns the request's tenant context) has already
   * debited tenant_balance and credited payout_reserved. This discharges that
   * reservation into payouts_paid and deliberately leaves tenant_balance untouched:
   * the money left the spendable balance the moment the payout was authorized, not
   * now. Settlement is confirmation, not the deduction.
   *
   * mpesaReceiptNumber is optional for the same reason it is on the inbound path —
   * see that method's comment and decisions.md entry 5.
   */
  async transitionPayoutToSettled(transactionId: string, data: { mpesaReceiptNumber?: string }) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTransaction(tx, transactionId);

      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { tenant: { select: { webhookUrl: true } } },
      });

      this.assertOutbound(transaction, "transitionPayoutToSettled");

      if (transaction.status === "SETTLED") {
        // Identical duplicate-delivery handling to the inbound path: back-fill a
        // receipt number drift detection couldn't supply, otherwise no-op. Critically
        // this returns BEFORE the ledger writes below — a redelivered result callback
        // must never discharge the same reservation twice.
        if (!transaction.mpesaReceiptNumber && data.mpesaReceiptNumber) {
          await tx.transaction.update({
            where: { id: transactionId },
            data: { mpesaReceiptNumber: data.mpesaReceiptNumber },
          });
          return;
        }
        if (!data.mpesaReceiptNumber || transaction.mpesaReceiptNumber === data.mpesaReceiptNumber) {
          return;
        }
        throw new Error(
          `Payout ${transactionId} already settled with a different receipt number ` +
            `(existing: ${transaction.mpesaReceiptNumber}, incoming: ${data.mpesaReceiptNumber})`,
        );
      }

      this.assertTransitionAllowed(transaction.status, "SETTLED");

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "SETTLED", mpesaReceiptNumber: data.mpesaReceiptNumber },
      });

      await tx.ledgerEntry.createMany({
        data: this.ledger.settlementEntries({
          tenantId: transaction.tenantId,
          transactionId: transaction.id,
          amountMinorUnits: transaction.amountMinorUnits,
        }),
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

      await this.enqueueWebhookDelivery(tx, transaction, "SETTLED", data.mpesaReceiptNumber ?? null);
    });
  }

  /**
   * Payout failed at Safaricom. Writes the compensating pair that returns the
   * reserved funds to the tenant's spendable balance — without this the money stays
   * stranded in payout_reserved forever and the tenant is permanently poorer by a
   * payout that never happened.
   *
   * NOTE this must NOT be called from the queue-timeout callback. A timeout means
   * Safaricom could not process the request in time, not that the money stayed put;
   * the result callback may still arrive afterwards. Releasing the reservation on a
   * timeout and then having the payout succeed lets the same shillings be spent
   * twice. See the b2c-timeout handler for what happens there instead.
   */
  async transitionPayoutToFailed(transactionId: string, data: { failureReason: string }) {
    await this.prisma.$transaction(async (tx) => {
      await this.lockTransaction(tx, transactionId);

      const transaction = await tx.transaction.findUniqueOrThrow({
        where: { id: transactionId },
        include: { tenant: { select: { webhookUrl: true } } },
      });

      this.assertOutbound(transaction, "transitionPayoutToFailed");
      this.assertTransitionAllowed(transaction.status, "FAILED");

      await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", failureReason: data.failureReason },
      });

      await tx.ledgerEntry.createMany({
        data: this.ledger.releaseEntries({
          tenantId: transaction.tenantId,
          transactionId: transaction.id,
          amountMinorUnits: transaction.amountMinorUnits,
        }),
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
      channel?: TransactionChannel;
      direction?: TransactionDirection;
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
          // Added when payouts landed. Without these a tenant's webhook endpoint
          // sees "SETTLED, 500 shillings" and cannot tell money arriving from money
          // leaving. Additive for existing consumers, which simply ignore them.
          direction: transaction.direction ?? null,
          channel: transaction.channel ?? null,
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
            account: LedgerAccount.TENANT_BALANCE,
            direction: LedgerDirection.CREDIT,
            amountMinorUnits: params.amountMinorUnits,
          },
          {
            tenantId: params.tenantId,
            transactionId: transaction.id,
            account: LedgerAccount.PENDING_SETTLEMENT,
            direction: LedgerDirection.DEBIT,
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

  /**
   * The two direction guards below are asymmetric on purpose, and between them every
   * dangerous crossing is covered:
   *
   *   - a payout pushed through the INBOUND methods  → caught by assertNotOutbound
   *   - a collection pushed through the PAYOUT methods → caught by assertOutbound
   *
   * assertNotOutbound rejects only an explicit OUTBOUND rather than demanding an
   * explicit INBOUND, so it can't misfire on a caller that didn't select the column.
   * Nothing is lost by that leniency: real rows always carry a direction (NOT NULL
   * DEFAULT 'INBOUND'), and the one crossing it would otherwise catch is already
   * caught by its counterpart.
   *
   * Both throw rather than trusting WebhookPollerService to route every callback to
   * the right method, because the failure mode here isn't a wrong HTTP response —
   * it's ledger entries written in the wrong direction, which nothing downstream
   * would flag.
   */
  private assertNotOutbound(transaction: { id: string; direction?: TransactionDirection }, method: string) {
    if (transaction.direction === "OUTBOUND") {
      throw new Error(
        `${method} called for OUTBOUND transaction ${transaction.id} — ` +
          `a payout must not be settled through the collection path`,
      );
    }
  }

  private assertOutbound(transaction: { id: string; direction?: TransactionDirection }, method: string) {
    if (transaction.direction !== "OUTBOUND") {
      throw new Error(
        `${method} called for ${transaction.direction ?? "unknown-direction"} transaction ${transaction.id} — ` +
          `payout transitions must not be applied to a collection`,
      );
    }
  }

  /**
   * Serializes concurrent transitions of the SAME transaction against each other for
   * the rest of the caller's transaction. Every method below reads the row, decides
   * whether the transition is legal, and then writes ledger entries off that
   * decision — a read-decide-write sequence that is only safe if nothing else can
   * interleave between the read and the write.
   *
   * Under READ COMMITTED nothing stopped that interleaving: two callers could both
   * read status PROCESSING, both pass assertTransitionAllowed, and both write the
   * credit pair, crediting the tenant twice for one payment. Today that is prevented
   * only by there being a single poller process holding an in-memory `isPolling`
   * flag — an accident of deployment shape, not a property of this code. This makes
   * it a property of the code.
   *
   * Same instrument, and same reasoning, as LedgerService.lockTenantBalance: the
   * tagged template parameterizes transactionId over the wire, so there is nothing
   * to validate by hand here.
   */
  private async lockTransaction(tx: Prisma.TransactionClient, transactionId: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${transactionId} FOR UPDATE`;
  }

  private assertTransitionAllowed(from: TransactionStatus, to: TransactionStatus) {
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw new Error(`Illegal transaction state transition: ${from} -> ${to}`);
    }
  }
}

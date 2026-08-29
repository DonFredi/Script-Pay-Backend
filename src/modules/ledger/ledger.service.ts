import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { LedgerAccount, LedgerDirection } from "./ledger.accounts";
import { InsufficientBalanceException } from "./insufficient-balance.exception";

/**
 * Accepts either an interactive-transaction client or a full PrismaClient —
 * PrismaClient is structurally assignable to Prisma.TransactionClient, so
 * PrismaService.withTenantContext's callback argument (typed as PrismaClient) fits
 * here without a cast at the call site.
 */
export type LedgerTransactionClient = Prisma.TransactionClient;

export interface PayoutLedgerParams {
  tenantId: string;
  transactionId: string;
  amountMinorUnits: number;
}

/**
 * Reads the tenant balance the ledger already encodes, and guards the one operation
 * that can reduce it.
 *
 * NOTE this service has no injected Prisma client of its own, deliberately. Every
 * method takes the caller's transaction client instead, because a balance read that
 * runs on a different connection than the write it authorizes provides no guarantee
 * whatsoever — it's a number that was true a moment ago. Forcing the caller to hand
 * over its own transaction is what makes "check then spend" atomic.
 *
 * The schema has always described tenant balance as "a computed, auditable value
 * instead of a mutable hot counter" (see LedgerEntry in schema.prisma), but until
 * now nothing computed it — TransactionStateMachine wrote ledger entries and no
 * code path ever read them back. This is that read side.
 */
@Injectable()
export class LedgerService {
  private readonly logger = new Logger(LedgerService.name);

  /**
   * Sum of credits minus debits on the tenant_balance account.
   *
   * Reservations need no special handling here: reserving a payout DEBITS
   * tenant_balance directly (rather than only writing to payout_reserved), so
   * in-flight payouts are already subtracted from whatever this returns. That's
   * precisely why the reservation is modelled that way — a balance that ignored
   * committed-but-unconfirmed payouts would authorize the same shillings twice.
   *
   * Backed by the existing @@index([tenantId, account]) on ledger_entries.
   *
   * Safe to call outside a transaction for a read-only balance display. It is NOT
   * safe to call outside one to authorize a spend — use assertSufficientBalance.
   */
  async availableBalance(tx: LedgerTransactionClient, tenantId: string): Promise<number> {
    const grouped = await tx.ledgerEntry.groupBy({
      by: ["direction"],
      where: { tenantId, account: LedgerAccount.TENANT_BALANCE },
      _sum: { amountMinorUnits: true },
    });

    const sumFor = (direction: string) =>
      grouped.find((row) => row.direction === direction)?._sum.amountMinorUnits ?? 0;

    return sumFor(LedgerDirection.CREDIT) - sumFor(LedgerDirection.DEBIT);
  }

  /**
   * Takes a row-level lock on the tenant, serializing payouts for that tenant
   * against each other for the remainder of the caller's transaction.
   *
   * Why the tenant row and not the ledger: there is no single row representing a
   * balance to lock — the balance is an aggregate over many ledger_entries rows,
   * and you cannot lock rows that don't exist yet, which is exactly what a
   * concurrent payout is about to insert. Locking the tenant gives both racers a
   * common object to queue on.
   *
   * This only needs to guard payout-against-payout. Collections settling
   * concurrently are harmless: TransactionStateMachine only ever CREDITS
   * tenant_balance, so a collection landing mid-payout can only make the balance
   * larger, and the payout check is at worst reading a stale, lower figure — wrong
   * in the safe direction. Revisit that reasoning if reversals are ever implemented
   * (SETTLED -> REVERSED is legal in ALLOWED_TRANSITIONS but no code performs it
   * today), since a reversal WOULD debit tenant_balance and would race here.
   */
  async lockTenantBalance(tx: LedgerTransactionClient, tenantId: string): Promise<void> {
    // Tagged-template $queryRaw parameterizes tenantId over the wire — unlike
    // PrismaService.withTenantContext, which has to interpolate (Postgres SET
    // rejects bind parameters) and therefore validates the UUID shape itself first.
    // No such validation is needed here.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM tenants WHERE id = ${tenantId} FOR UPDATE
    `;

    if (rows.length === 0) {
      // Reachable in normal operation: a tenant deleted between the guard resolving
      // its API key and this transaction running. Never silently treat a missing
      // tenant as a zero balance — that reads as "declined for insufficient funds"
      // and would send someone hunting for money that was never the problem.
      throw new NotFoundException("Tenant not found");
    }
  }

  /**
   * The money boundary: lock, read, compare, in that order, inside the caller's
   * transaction. Returns the balance that was verified, so callers can log or
   * report it without a second read.
   *
   * Callers MUST perform the debiting write inside the same transaction. The lock
   * this takes is released when that transaction commits or rolls back; a caller
   * that checks here and writes afterwards has verified nothing.
   */
  async assertSufficientBalance(
    tx: LedgerTransactionClient,
    tenantId: string,
    amountMinorUnits: number,
  ): Promise<number> {
    this.assertInsideTransaction(tx);

    // The DTO layer validates this too. Repeated here because this is the last
    // point before money is authorized, and a negative amount would sail through a
    // `requested > available` comparison and then CREDIT the tenant on a write
    // labelled "debit" — a balance increase disguised as a payout.
    if (!Number.isInteger(amountMinorUnits) || amountMinorUnits <= 0) {
      throw new Error(`Payout amount must be a positive integer in minor units, received: ${amountMinorUnits}`);
    }

    await this.lockTenantBalance(tx, tenantId);
    const available = await this.availableBalance(tx, tenantId);

    if (amountMinorUnits > available) {
      this.logger.warn(
        `Payout declined for tenant ${tenantId}: requested ${amountMinorUnits}, available ${available} (minor units)`,
      );
      throw new InsufficientBalanceException(available, amountMinorUnits);
    }

    return available;
  }

  /**
   * The three balanced pairs that make up a payout's lifecycle, defined once so the
   * two paths that write them can never drift into different definitions of the same
   * movement — the mistake decisions.md entry 4 exists to prevent on the collection
   * side.
   *
   *   reserve → tenant_balance   debit  / payout_reserved credit
   *   settle  → payout_reserved  debit  / payouts_paid    credit
   *   release → payout_reserved  debit  / tenant_balance  credit
   *
   * Both paths are needed because a payout can fail in two structurally different
   * places: synchronously, when Daraja rejects the request (B2cService, on the
   * request's tenant-scoped connection), or asynchronously, when the result callback
   * reports failure (TransactionStateMachine, on the privileged connection). These
   * are pure — they build rows rather than writing them — so each caller keeps its
   * own connection and transaction.
   */
  reservationEntries(params: PayoutLedgerParams) {
    return this.pair(params, LedgerAccount.TENANT_BALANCE, LedgerAccount.PAYOUT_RESERVED);
  }

  settlementEntries(params: PayoutLedgerParams) {
    return this.pair(params, LedgerAccount.PAYOUT_RESERVED, LedgerAccount.PAYOUTS_PAID);
  }

  releaseEntries(params: PayoutLedgerParams) {
    return this.pair(params, LedgerAccount.PAYOUT_RESERVED, LedgerAccount.TENANT_BALANCE);
  }

  /** Debits `from`, credits `to`, same amount — balanced by construction. */
  private pair(params: PayoutLedgerParams, from: string, to: string) {
    return [
      {
        tenantId: params.tenantId,
        transactionId: params.transactionId,
        account: from,
        direction: LedgerDirection.DEBIT,
        amountMinorUnits: params.amountMinorUnits,
      },
      {
        tenantId: params.tenantId,
        transactionId: params.transactionId,
        account: to,
        direction: LedgerDirection.CREDIT,
        amountMinorUnits: params.amountMinorUnits,
      },
    ];
  }

  /**
   * A FOR UPDATE lock taken outside a transaction is released the instant its
   * statement finishes, so the whole check becomes decorative while still looking
   * correct in review. There's no Prisma API that reports "am I in a transaction",
   * but the interactive-transaction client omits $transaction while a plain
   * PrismaClient exposes it — that difference is the tell.
   *
   * If a future Prisma version stops omitting it, this throws on a legitimate call:
   * loud and immediate, rather than silently unguarding the spend path. That's the
   * correct direction for this check to fail in.
   */
  private assertInsideTransaction(tx: LedgerTransactionClient): void {
    if (typeof (tx as { $transaction?: unknown }).$transaction === "function") {
      throw new Error(
        "LedgerService.assertSufficientBalance must run inside a transaction — pass the client from " +
          "PrismaService.withTenantContext(...) or $transaction(...), not the PrismaService itself. " +
          "Outside a transaction the row lock is released immediately and the balance check guarantees nothing.",
      );
    }
  }
}

/**
 * The double-entry account and direction names used across the ledger.
 *
 * These were previously bare string literals inside TransactionStateMachine
 * ("tenant_balance", "pending_settlement", "credit", "debit") — perfectly fine
 * while exactly one file wrote them and nothing ever read them back. A payout
 * path breaks that assumption: it reads the balance those writes produce, so the
 * write side and the read side must agree on the exact spelling.
 *
 * A typo'd account name in a WHERE clause returns zero rows, not an error. On a
 * balance check that surfaces as "this tenant has no money" (annoying but safe),
 * or — if the typo lands on the debit side of the subtraction — as a balance
 * that looks LARGER than it is, which authorizes a payout that shouldn't happen.
 * Constants make that class of bug a compile error instead.
 */
export const LedgerAccount = {
  /**
   * The tenant's spendable money. Credited when a collection settles, debited the
   * moment a payout is reserved. This single account IS the balance — see
   * LedgerService.availableBalance.
   */
  TENANT_BALANCE: "tenant_balance",

  /** Contra account balancing an inbound settlement. */
  PENDING_SETTLEMENT: "pending_settlement",

  /**
   * Contra account holding funds committed to an in-flight payout. Written by the
   * reservation (Phase 4), cleared when Safaricom confirms or rejects it.
   */
  PAYOUT_RESERVED: "payout_reserved",

  /** Terminal account for payouts Safaricom has confirmed actually left the shortcode. */
  PAYOUTS_PAID: "payouts_paid",
} as const;

export type LedgerAccountName = (typeof LedgerAccount)[keyof typeof LedgerAccount];

export const LedgerDirection = {
  DEBIT: "debit",
  CREDIT: "credit",
} as const;

export type LedgerDirectionName = (typeof LedgerDirection)[keyof typeof LedgerDirection];

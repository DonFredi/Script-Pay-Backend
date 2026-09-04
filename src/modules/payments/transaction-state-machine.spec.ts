import { Test, TestingModule } from "@nestjs/testing";
import { TransactionStateMachine } from "./transaction-state-machine";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { LedgerService } from "../ledger/ledger.service";

describe("TransactionStateMachine", () => {
  let service: TransactionStateMachine;
  let tx: {
    transaction: { findUniqueOrThrow: jest.Mock; update: jest.Mock; create: jest.Mock };
    ledgerEntry: { createMany: jest.Mock };
    reconciliationRecord: { create: jest.Mock; updateMany: jest.Mock };
    tenantWebhookDelivery: { create: jest.Mock };
    // Backs lockTransaction's `SELECT ... FOR UPDATE`, which serializes concurrent
    // transitions of the same transaction — see that method's comment.
    $queryRaw: jest.Mock;
  };

  beforeEach(async () => {
    tx = {
      transaction: { findUniqueOrThrow: jest.fn(), update: jest.fn(), create: jest.fn() },
      ledgerEntry: { createMany: jest.fn() },
      reconciliationRecord: { create: jest.fn(), updateMany: jest.fn() },
      tenantWebhookDelivery: { create: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([{ id: "tx-1" }]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionStateMachine,
        // The real LedgerService, not a mock: the methods used here are pure builders
        // with no I/O, and asserting against the actual account/direction pairs is the
        // point of the payout ledger tests below.
        LedgerService,
        {
          provide: PrismaPrivilegedService,
          useValue: {
            $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(tx)),
          },
        },
      ],
    }).compile();

    service = module.get<TransactionStateMachine>(TransactionStateMachine);
  });

  // Without the lock, two callers processing the same Safaricom callback can both
  // read status PROCESSING, both pass assertTransitionAllowed, and both write the
  // credit pair — crediting the tenant twice for one payment. A single poller
  // process makes that unreachable today, but that is a property of the deployment,
  // not of this class, and it stops holding the moment a second instance exists.
  describe("row locking", () => {
    const lockedTransitions: Array<[string, () => Promise<unknown>]> = [
      ["transitionToSettled", () => service.transitionToSettled("tx-1", {})],
      ["transitionToFailed", () => service.transitionToFailed("tx-1", { failureReason: "nope" })],
      ["transitionPayoutToSettled", () => service.transitionPayoutToSettled("tx-1", {})],
      ["transitionPayoutToFailed", () => service.transitionPayoutToFailed("tx-1", { failureReason: "nope" })],
    ];

    it.each(lockedTransitions)("%s locks the row before reading it", async (name, run) => {
      const isPayout = name.includes("Payout");
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PROCESSING",
        amountMinorUnits: 50_000,
        direction: isPayout ? "OUTBOUND" : "INBOUND",
        metadata: null,
        tenant: { webhookUrl: null },
      });

      await run();

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
      // Order matters as much as presence: a lock taken after the read leaves the
      // read itself unprotected, which is the exact race being closed.
      expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        tx.transaction.findUniqueOrThrow.mock.invocationCallOrder[0],
      );
    });
  });

  describe("transitionToSettled", () => {
    it("moves PROCESSING -> SETTLED and writes balanced ledger entries", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PROCESSING",
        amountMinorUnits: 10000,
      });

      await service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC123" });

      expect(tx.transaction.update).toHaveBeenCalledWith({
        where: { id: "tx-1" },
        data: { status: "SETTLED", mpesaReceiptNumber: "REC123" },
      });

      const ledgerCall = tx.ledgerEntry.createMany.mock.calls[0][0];
      expect(ledgerCall.data).toEqual([
        expect.objectContaining({ account: "tenant_balance", direction: "credit", amountMinorUnits: 10000 }),
        expect.objectContaining({ account: "pending_settlement", direction: "debit", amountMinorUnits: 10000 }),
      ]);

      expect(tx.reconciliationRecord.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ transactionId: "tx-1", expectedAmount: 10000, confirmedAmount: 10000 }),
        }),
      );
      // No tenant.webhookUrl on this fixture — nothing to notify, so no delivery is queued.
      expect(tx.tenantWebhookDelivery.create).not.toHaveBeenCalled();
    });

    it("enqueues a webhook delivery when the tenant has a webhookUrl configured", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PROCESSING",
        direction: "INBOUND",
        channel: "STK_PUSH",
        amountMinorUnits: 10000,
        metadata: { orderRef: "abc" },
        tenant: { webhookUrl: "https://example.com/webhooks/scriptpay" },
      });

      await service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC123" });

      expect(tx.tenantWebhookDelivery.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-1",
          transactionId: "tx-1",
          payload: {
            transactionId: "tx-1",
            status: "SETTLED",
            // Present on collections too, not just payouts — a consumer shouldn't
            // have to infer direction from the absence of a field.
            direction: "INBOUND",
            channel: "STK_PUSH",
            mpesaReceiptNumber: "REC123",
            amountMinorUnits: 10000,
            metadata: { orderRef: "abc" },
            occurredAt: expect.any(String),
          },
        },
      });
    });

    it("does not enqueue a second delivery for an idempotent duplicate settlement", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        mpesaReceiptNumber: "REC123",
        amountMinorUnits: 10000,
        tenant: { webhookUrl: "https://example.com/webhooks/scriptpay" },
      });

      await service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC123" });

      expect(tx.tenantWebhookDelivery.create).not.toHaveBeenCalled();
    });

    it("settles PROCESSING -> SETTLED even with no receipt number yet (drift-detection path)", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PROCESSING",
        amountMinorUnits: 10000,
      });

      await service.transitionToSettled("tx-1", {});

      expect(tx.transaction.update).toHaveBeenCalledWith({
        where: { id: "tx-1" },
        data: { status: "SETTLED", mpesaReceiptNumber: undefined },
      });
      expect(tx.ledgerEntry.createMany).toHaveBeenCalled();
    });

    it("is idempotent when the same receipt number arrives twice (duplicate Safaricom delivery)", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        mpesaReceiptNumber: "REC123",
        amountMinorUnits: 10000,
      });

      await service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC123" });

      expect(tx.transaction.update).not.toHaveBeenCalled();
      expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it("is a no-op when re-settled with no receipt number and none was recorded before", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        mpesaReceiptNumber: null,
        amountMinorUnits: 10000,
      });

      await service.transitionToSettled("tx-1", {});

      expect(tx.transaction.update).not.toHaveBeenCalled();
    });

    it("back-fills a missing receipt number when the real callback arrives after drift detection already settled it", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        mpesaReceiptNumber: null,
        amountMinorUnits: 10000,
      });

      await service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC123" });

      expect(tx.transaction.update).toHaveBeenCalledWith({
        where: { id: "tx-1" },
        data: { mpesaReceiptNumber: "REC123" },
      });
      // Ledger/reconciliation entries were already written the first time it settled — don't duplicate them.
      expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it("throws if settled again with a genuinely different receipt number (data anomaly)", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        mpesaReceiptNumber: "REC123",
        amountMinorUnits: 10000,
      });

      await expect(service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC999" })).rejects.toThrow(
        "already settled with a different receipt number",
      );
      expect(tx.transaction.update).not.toHaveBeenCalled();
    });

    it("refuses PENDING -> SETTLED (must pass through PROCESSING)", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PENDING",
        amountMinorUnits: 10000,
      });

      await expect(service.transitionToSettled("tx-1", { mpesaReceiptNumber: "REC123" })).rejects.toThrow(
        "Illegal transaction state transition: PENDING -> SETTLED",
      );
    });
  });

  describe("transitionToFailed", () => {
    it("moves PROCESSING -> FAILED", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PROCESSING",
        amountMinorUnits: 10000,
      });

      await service.transitionToFailed("tx-1", { failureReason: "insufficient_funds" });

      expect(tx.transaction.update).toHaveBeenCalledWith({
        where: { id: "tx-1" },
        data: { status: "FAILED", failureReason: "insufficient_funds" },
      });
      expect(tx.tenantWebhookDelivery.create).not.toHaveBeenCalled();
    });

    it("enqueues a FAILED webhook delivery when the tenant has a webhookUrl configured", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "PROCESSING",
        direction: "INBOUND",
        channel: "STK_PUSH",
        amountMinorUnits: 10000,
        metadata: null,
        tenant: { webhookUrl: "https://example.com/webhooks/scriptpay" },
      });

      await service.transitionToFailed("tx-1", { failureReason: "insufficient_funds" });

      expect(tx.tenantWebhookDelivery.create).toHaveBeenCalledWith({
        data: {
          tenantId: "tenant-1",
          transactionId: "tx-1",
          payload: {
            transactionId: "tx-1",
            status: "FAILED",
            direction: "INBOUND",
            channel: "STK_PUSH",
            mpesaReceiptNumber: null,
            amountMinorUnits: 10000,
            metadata: null,
            occurredAt: expect.any(String),
          },
        },
      });
    });

    it("refuses to fail an already-terminal REVERSED transaction", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "REVERSED",
        amountMinorUnits: 10000,
      });

      await expect(service.transitionToFailed("tx-1", { failureReason: "x" })).rejects.toThrow(
        "Illegal transaction state transition: REVERSED -> FAILED",
      );
    });

    it("refuses to fail an already-SETTLED transaction (must be REVERSED, not overwritten)", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce({
        id: "tx-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        amountMinorUnits: 10000,
      });

      await expect(service.transitionToFailed("tx-1", { failureReason: "x" })).rejects.toThrow(
        "Illegal transaction state transition: SETTLED -> FAILED",
      );
    });
  });

  describe("recordInboundSettlement", () => {
    it("creates an already-SETTLED transaction with balanced ledger entries for C2B", async () => {
      tx.transaction.create.mockResolvedValueOnce({
        id: "tx-c2b-1",
        tenantId: "tenant-1",
        status: "SETTLED",
        amountMinorUnits: 5000,
      });

      const result = await service.recordInboundSettlement({
        tenantId: "tenant-1",
        channel: "TILL",
        amountMinorUnits: 5000,
        msisdn: "254712345678",
        mpesaReceiptNumber: "REC999",
      });

      expect(tx.transaction.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "SETTLED", amountMinorUnits: 5000 }),
        }),
      );
      expect(tx.ledgerEntry.createMany).toHaveBeenCalled();
      expect(tx.reconciliationRecord.create).toHaveBeenCalled();
      expect(result.id).toBe("tx-c2b-1");
    });
  });

  describe("payout transitions", () => {
    const payoutRow = (overrides: Record<string, unknown> = {}) => ({
      id: "payout-1",
      tenantId: "tenant-1",
      status: "PROCESSING",
      direction: "OUTBOUND",
      channel: "B2C",
      amountMinorUnits: 50000,
      ...overrides,
    });

    /** The ledger entries written by the call under test, as {account, direction} pairs. */
    const writtenEntries = () =>
      (tx.ledgerEntry.createMany.mock.calls[0]?.[0].data as Array<{ account: string; direction: string }>).map(
        ({ account, direction }) => ({ account, direction }),
      );

    describe("transitionPayoutToSettled", () => {
      it("discharges the reservation into payouts_paid", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow());

        await service.transitionPayoutToSettled("payout-1", { mpesaReceiptNumber: "REC-OUT-1" });

        expect(tx.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: expect.objectContaining({ status: "SETTLED" }) }),
        );
        expect(writtenEntries()).toEqual([
          { account: "payout_reserved", direction: "debit" },
          { account: "payouts_paid", direction: "credit" },
        ]);
      });

      // The whole reason this isn't a branch inside transitionToSettled: crediting
      // tenant_balance here would pay the tenant for money they just sent.
      it("does NOT touch tenant_balance — the reservation already deducted it", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow());

        await service.transitionPayoutToSettled("payout-1", { mpesaReceiptNumber: "REC-OUT-1" });

        expect(writtenEntries().some((e) => e.account === "tenant_balance")).toBe(false);
      });

      it("writes a reconciliation record", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow());

        await service.transitionPayoutToSettled("payout-1", { mpesaReceiptNumber: "REC-OUT-1" });

        expect(tx.reconciliationRecord.create).toHaveBeenCalled();
      });

      it("is idempotent on a redelivered callback — never discharges the reservation twice", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(
          payoutRow({ status: "SETTLED", mpesaReceiptNumber: "REC-OUT-1" }),
        );

        await service.transitionPayoutToSettled("payout-1", { mpesaReceiptNumber: "REC-OUT-1" });

        expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
      });

      it("back-fills a receipt number onto an already-settled payout without re-writing the ledger", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(
          payoutRow({ status: "SETTLED", mpesaReceiptNumber: null }),
        );

        await service.transitionPayoutToSettled("payout-1", { mpesaReceiptNumber: "REC-OUT-1" });

        expect(tx.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({ data: { mpesaReceiptNumber: "REC-OUT-1" } }),
        );
        expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
      });

      it("refuses a collection — payout ledger writes must never apply to an INBOUND row", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(
          payoutRow({ direction: "INBOUND", channel: "STK_PUSH" }),
        );

        await expect(service.transitionPayoutToSettled("payout-1", {})).rejects.toThrow(
          /must not be applied to a collection/,
        );
        expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
      });

      it("includes direction and channel in the tenant webhook payload", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(
          payoutRow({ tenant: { webhookUrl: "https://merchant.test/hook" } }),
        );

        await service.transitionPayoutToSettled("payout-1", { mpesaReceiptNumber: "REC-OUT-1" });

        const payload = tx.tenantWebhookDelivery.create.mock.calls[0][0].data.payload;
        expect(payload).toMatchObject({ status: "SETTLED", direction: "OUTBOUND", channel: "B2C" });
      });
    });

    describe("transitionPayoutToFailed", () => {
      it("returns the reserved funds to the tenant's spendable balance", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow());

        await service.transitionPayoutToFailed("payout-1", { failureReason: "insufficient float" });

        expect(tx.transaction.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({ status: "FAILED", failureReason: "insufficient float" }),
          }),
        );
        expect(writtenEntries()).toEqual([
          { account: "payout_reserved", direction: "debit" },
          { account: "tenant_balance", direction: "credit" },
        ]);
      });

      it("refuses a collection", async () => {
        tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow({ direction: "INBOUND" }));

        await expect(
          service.transitionPayoutToFailed("payout-1", { failureReason: "whatever" }),
        ).rejects.toThrow(/must not be applied to a collection/);
        expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
      });
    });

    // The mirror guard: the collection path must equally refuse a payout row, or a
    // misrouted callback would credit tenant_balance for money that left the account.
    it("transitionToSettled refuses an OUTBOUND transaction", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow());

      await expect(service.transitionToSettled("payout-1", {})).rejects.toThrow(
        /must not be settled through the collection path/,
      );
      expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
    });

    it("transitionToFailed refuses an OUTBOUND transaction", async () => {
      tx.transaction.findUniqueOrThrow.mockResolvedValueOnce(payoutRow());

      await expect(service.transitionToFailed("payout-1", { failureReason: "x" })).rejects.toThrow(
        /must not be settled through the collection path/,
      );
    });
  });
});

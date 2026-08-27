import { Test, TestingModule } from "@nestjs/testing";
import { TransactionStateMachine } from "./transaction-state-machine";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";

describe("TransactionStateMachine", () => {
  let service: TransactionStateMachine;
  let tx: {
    transaction: { findUniqueOrThrow: jest.Mock; update: jest.Mock; create: jest.Mock };
    ledgerEntry: { createMany: jest.Mock };
    reconciliationRecord: { create: jest.Mock; updateMany: jest.Mock };
    tenantWebhookDelivery: { create: jest.Mock };
  };

  beforeEach(async () => {
    tx = {
      transaction: { findUniqueOrThrow: jest.fn(), update: jest.fn(), create: jest.fn() },
      ledgerEntry: { createMany: jest.fn() },
      reconciliationRecord: { create: jest.fn(), updateMany: jest.fn() },
      tenantWebhookDelivery: { create: jest.fn() },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TransactionStateMachine,
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
});

import { Test, TestingModule } from "@nestjs/testing";
import { DriftDetectorService } from "./drift-detector.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { TenantsService } from "../tenants/tenants.service";
import { AlertsService } from "../alerts/alerts.service";
import { AuditLogService } from "../audit-log/audit-log.service";

describe("DriftDetectorService", () => {
  let service: DriftDetectorService;
  let prisma: PrismaPrivilegedService;
  let daraja: DarajaClient;
  let stateMachine: TransactionStateMachine;
  let tenantsService: TenantsService;
  let alerts: AlertsService;
  let auditLog: AuditLogService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriftDetectorService,
        {
          provide: PrismaPrivilegedService,
          useValue: {
            transaction: { findMany: jest.fn() },
            reconciliationRecord: { updateMany: jest.fn(), findUnique: jest.fn(), upsert: jest.fn() },
          },
        },
        { provide: DarajaClient, useValue: { queryStkPushStatus: jest.fn() } },
        {
          provide: TransactionStateMachine,
          useValue: { transitionToSettled: jest.fn(), transitionToFailed: jest.fn() },
        },
        { provide: TenantsService, useValue: { getMpesaCredentialsForPayment: jest.fn() } },
        { provide: AlertsService, useValue: { send: jest.fn() } },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(DriftDetectorService);
    prisma = module.get(PrismaPrivilegedService);
    daraja = module.get(DarajaClient);
    stateMachine = module.get(TransactionStateMachine);
    tenantsService = module.get(TenantsService);
    alerts = module.get(AlertsService);
    auditLog = module.get(AuditLogService);
  });

  it("does nothing when no transactions are stuck in PROCESSING", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([]);

    await service.detectStuckTransactions();

    expect(daraja.queryStkPushStatus).not.toHaveBeenCalled();
  });

  it("skips a stuck transaction that has no checkoutRequestId to query by", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: null },
    ] as any);

    await service.detectStuckTransactions();

    expect(daraja.queryStkPushStatus).not.toHaveBeenCalled();
  });

  it("settles a stuck transaction on resultCode 0 alone — the STK Push Query API never returns a receipt number", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValueOnce({} as any);
    // This is DarajaClient.queryStkPushStatus's REAL return shape — no cast needed.
    // Regression coverage for a bug where settlement additionally required
    // mpesaReceiptNumber, a field this API can never supply, making this branch dead.
    jest.spyOn(daraja, "queryStkPushStatus").mockResolvedValueOnce({
      resultCode: 0,
      resultDesc: "Success",
    });

    await service.detectStuckTransactions();

    expect(stateMachine.transitionToSettled).toHaveBeenCalledWith("tx-1", { mpesaReceiptNumber: undefined });
    expect(stateMachine.transitionToFailed).not.toHaveBeenCalled();
    expect(prisma.reconciliationRecord.updateMany).toHaveBeenCalledWith({
      where: { transactionId: "tx-1" },
      data: { driftDetected: true },
    });
  });

  it("still passes through a receipt number if a future/alternate Daraja query ever includes one", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValueOnce({} as any);
    jest.spyOn(daraja, "queryStkPushStatus").mockResolvedValueOnce({
      resultCode: 0,
      mpesaReceiptNumber: "REC1",
      resultDesc: "Success",
    } as any);

    await service.detectStuckTransactions();

    expect(stateMachine.transitionToSettled).toHaveBeenCalledWith("tx-1", { mpesaReceiptNumber: "REC1" });
  });

  it("fails a stuck transaction that Daraja confirms did not succeed", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValueOnce({} as any);
    jest.spyOn(daraja, "queryStkPushStatus").mockResolvedValueOnce({
      resultCode: 1032,
      resultDesc: "Request cancelled by user",
    });

    await service.detectStuckTransactions();

    expect(stateMachine.transitionToFailed).toHaveBeenCalledWith("tx-1", {
      failureReason: "Request cancelled by user",
    });
    expect(stateMachine.transitionToSettled).not.toHaveBeenCalled();
  });

  it("continues processing remaining transactions when one Daraja query fails", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1" },
      { id: "tx-2", tenantId: "tenant-1", checkoutRequestId: "cr-2" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValue({} as any);
    jest
      .spyOn(daraja, "queryStkPushStatus")
      .mockRejectedValueOnce(new Error("Daraja unreachable"))
      .mockResolvedValueOnce({ resultCode: 0, mpesaReceiptNumber: "REC2", resultDesc: "Success" } as any);

    await service.detectStuckTransactions();

    expect(stateMachine.transitionToSettled).toHaveBeenCalledTimes(1);
    expect(stateMachine.transitionToSettled).toHaveBeenCalledWith("tx-2", { mpesaReceiptNumber: "REC2" });
  });

  // Before payouts existed this query matched every PROCESSING row. A B2C row reaching
  // the STK query path was avoided only by the null-checkoutRequestId skip, which is an
  // accident of schema shape — and it meant stuck payouts were ignored forever.
  it("scans only INBOUND transactions, never handing a payout to the STK query API", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([]);

    await service.detectStuckTransactions();

    expect((prisma.transaction.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
      status: "PROCESSING",
      direction: "INBOUND",
    });
  });

  describe("detectStuckPayouts", () => {
    const stuckPayout = {
      id: "payout-1",
      tenantId: "tenant-1",
      amountMinorUnits: 50000,
      originatorConversationId: "oc-1",
      conversationId: "AG_1",
    };

    it("scans only OUTBOUND transactions", async () => {
      jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([]);

      await service.detectStuckPayouts();

      expect((prisma.transaction.findMany as jest.Mock).mock.calls[0][0].where).toMatchObject({
        status: "PROCESSING",
        direction: "OUTBOUND",
      });
    });

    it("escalates a stuck payout with a critical alert and an audit entry", async () => {
      jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
      jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);

      await service.detectStuckPayouts();

      expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "payout.drift_detected", targetId: "payout-1" }),
      );
      expect(prisma.reconciliationRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({ where: { transactionId: "payout-1" } }),
      );
    });

    // Re-alerting every five minutes for the same payout is how an alert channel gets
    // muted, which costs more than the alert was worth.
    it("does not re-alert for a payout already flagged on an earlier run", async () => {
      jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
      jest
        .spyOn(prisma.reconciliationRecord, "findUnique")
        .mockResolvedValueOnce({ transactionId: "payout-1", driftDetected: true } as any);

      await service.detectStuckPayouts();

      expect(alerts.send).not.toHaveBeenCalled();
      expect(prisma.reconciliationRecord.upsert).not.toHaveBeenCalled();
    });

    // It cannot resolve a payout itself: Daraja's Transaction Status API answers
    // asynchronously, so auto-recovery needs its own callback route and correlation.
    it("never transitions the payout — escalation only", async () => {
      jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
      jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);

      await service.detectStuckPayouts();

      expect(stateMachine.transitionToSettled).not.toHaveBeenCalled();
      expect(stateMachine.transitionToFailed).not.toHaveBeenCalled();
    });

    it("keeps escalating the rest of the batch when one payout fails to escalate", async () => {
      jest
        .spyOn(prisma.transaction, "findMany")
        .mockResolvedValueOnce([stuckPayout, { ...stuckPayout, id: "payout-2" }] as any);
      jest
        .spyOn(prisma.reconciliationRecord, "findUnique")
        .mockRejectedValueOnce(new Error("db blip"))
        .mockResolvedValueOnce(null);

      await service.detectStuckPayouts();

      expect(alerts.send).toHaveBeenCalledTimes(1);
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "payout.drift_detected", targetId: "payout-2" }),
      );
    });
  });
});

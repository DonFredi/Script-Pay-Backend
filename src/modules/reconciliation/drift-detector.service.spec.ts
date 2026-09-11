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
            payoutStatusQuery: { findFirst: jest.fn(), create: jest.fn() },
            tenantShortcode: { findFirst: jest.fn() },
          },
        },
        { provide: DarajaClient, useValue: { queryStkPushStatus: jest.fn(), queryPayoutStatus: jest.fn() } },
        {
          provide: TransactionStateMachine,
          useValue: { transitionToSettled: jest.fn(), transitionToFailed: jest.fn() },
        },
        {
          provide: TenantsService,
          useValue: { getMpesaCredentialsForPayment: jest.fn(), getMpesaCredentialsForPayout: jest.fn() },
        },
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

  // The highest-cost bug on the collection path: an in-flight push (Safaricom
  // answers with errorCode 500.001.1001 and no ResultCode) was coerced to -1, read
  // as "not zero, therefore failed", and made terminal. The genuine success callback
  // that arrived afterwards could then never settle it — customer charged, tenant
  // never credited, transaction reading FAILED.
  it("leaves a transaction PROCESSING when Daraja gives no verdict", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1", channel: "PAYBILL" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValueOnce({} as any);
    jest.spyOn(daraja, "queryStkPushStatus").mockResolvedValueOnce({
      resultCode: null,
      errorCode: "500.001.1001",
      resultDesc: "The transaction is being processed",
    });

    await service.detectStuckTransactions();

    expect(stateMachine.transitionToFailed).not.toHaveBeenCalled();
    expect(stateMachine.transitionToSettled).not.toHaveBeenCalled();
    // No drift is recorded either — nothing has been shown to have drifted yet.
    expect(prisma.reconciliationRecord.updateMany).not.toHaveBeenCalled();
  });

  // Defaulting the channel meant a stuck TILL collection was queried with the
  // tenant's PAYBILL shortcode and passkey, so the query always failed and the row
  // stayed stuck forever.
  it("queries a TILL collection with that tenant's TILL credentials, not the PAYBILL default", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1", channel: "TILL" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValueOnce({} as any);
    jest.spyOn(daraja, "queryStkPushStatus").mockResolvedValueOnce({ resultCode: 0, resultDesc: "Success" });

    await service.detectStuckTransactions();

    expect(tenantsService.getMpesaCredentialsForPayment).toHaveBeenCalledWith("tenant-1", "TILL");
  });

  it("queries a PAYBILL collection with PAYBILL credentials", async () => {
    jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([
      { id: "tx-1", tenantId: "tenant-1", checkoutRequestId: "cr-1", channel: "PAYBILL" },
    ] as any);
    jest.spyOn(tenantsService, "getMpesaCredentialsForPayment").mockResolvedValueOnce({} as any);
    jest.spyOn(daraja, "queryStkPushStatus").mockResolvedValueOnce({ resultCode: 0, resultDesc: "Success" });

    await service.detectStuckTransactions();

    expect(tenantsService.getMpesaCredentialsForPayment).toHaveBeenCalledWith("tenant-1", "PAYBILL");
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

    describe("auto-recovery status query", () => {
      const shortcode = { id: "shortcode-1", tenantId: "tenant-1", type: "B2C", isDefault: true };
      const credentials = { shortcode: "600992", initiatorName: "testapi", securityCredential: "blob" };

      it("fires a status query using the payout's own originatorConversationId, then still alerts", async () => {
        jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
        jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);
        jest.spyOn(prisma.payoutStatusQuery, "findFirst").mockResolvedValueOnce(null);
        jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce(shortcode as any);
        jest.spyOn(tenantsService, "getMpesaCredentialsForPayout").mockResolvedValueOnce(credentials as any);
        jest
          .spyOn(daraja, "queryPayoutStatus")
          .mockResolvedValueOnce({ conversationId: "AG_query1", originatorConversationId: "query-oc-1" });

        await service.detectStuckPayouts();

        expect(daraja.queryPayoutStatus).toHaveBeenCalledWith(credentials, "oc-1");
        expect(prisma.payoutStatusQuery.create).toHaveBeenCalledWith({
          data: {
            tenantId: "tenant-1",
            transactionId: "payout-1",
            queryOriginatorConversationId: "query-oc-1",
            queryConversationId: "AG_query1",
          },
        });
        // The query firing must never replace the human alert — its own result can
        // just as easily go missing.
        expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
      });

      it("skips the query and still alerts when the tenant has no default B2C shortcode", async () => {
        jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
        jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);
        jest.spyOn(prisma.payoutStatusQuery, "findFirst").mockResolvedValueOnce(null);
        jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce(null);

        await service.detectStuckPayouts();

        expect(daraja.queryPayoutStatus).not.toHaveBeenCalled();
        expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
      });

      it("does not fire a second query while one is already unresolved for this payout", async () => {
        jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
        jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);
        jest
          .spyOn(prisma.payoutStatusQuery, "findFirst")
          .mockResolvedValueOnce({ id: "existing-query", resolvedAt: null } as any);

        await service.detectStuckPayouts();

        expect(daraja.queryPayoutStatus).not.toHaveBeenCalled();
        expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
      });

      // The query is best-effort. Its failure must never be able to suppress the
      // one thing that has always resolved a stuck payout: the human alert.
      it("still escalates normally when the status query itself throws", async () => {
        jest.spyOn(prisma.transaction, "findMany").mockResolvedValueOnce([stuckPayout] as any);
        jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);
        jest.spyOn(prisma.payoutStatusQuery, "findFirst").mockResolvedValueOnce(null);
        jest.spyOn(prisma.tenantShortcode, "findFirst").mockResolvedValueOnce(shortcode as any);
        jest.spyOn(tenantsService, "getMpesaCredentialsForPayout").mockResolvedValueOnce(credentials as any);
        jest.spyOn(daraja, "queryPayoutStatus").mockRejectedValueOnce(new Error("Daraja rejected the query"));

        await service.detectStuckPayouts();

        expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
        expect(prisma.reconciliationRecord.upsert).toHaveBeenCalled();
      });

      it("skips the query entirely when the payout has no originatorConversationId to query by", async () => {
        jest
          .spyOn(prisma.transaction, "findMany")
          .mockResolvedValueOnce([{ ...stuckPayout, originatorConversationId: null }] as any);
        jest.spyOn(prisma.reconciliationRecord, "findUnique").mockResolvedValueOnce(null);

        await service.detectStuckPayouts();

        expect(prisma.tenantShortcode.findFirst).not.toHaveBeenCalled();
        expect(daraja.queryPayoutStatus).not.toHaveBeenCalled();
      });
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

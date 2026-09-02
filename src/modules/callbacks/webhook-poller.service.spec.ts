import { Test, TestingModule } from "@nestjs/testing";
import { WebhookPollerService } from "./webhook-poller.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AlertsService } from "../alerts/alerts.service";

function c2bEvent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "evt-1",
    source: "daraja_c2b_confirmation",
    attempts: 0,
    payload: {
      BusinessShortCode: "174379",
      TransID: "TX123",
      TransAmount: "50",
      MSISDN: "254712345678",
      TransactionType: "Pay Bill",
      ...overrides,
    },
  };
}

describe("WebhookPollerService — C2B shortcode resolution", () => {
  let service: WebhookPollerService;
  let prisma: PrismaPrivilegedService;
  let stateMachine: TransactionStateMachine;
  let auditLog: AuditLogService;
  let alerts: AlertsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookPollerService,
        {
          provide: PrismaPrivilegedService,
          useValue: {
            webhookEvent: { findMany: jest.fn(), update: jest.fn() },
            tenantShortcode: { findMany: jest.fn() },
            transaction: { findUnique: jest.fn() },
          },
        },
        { provide: TransactionStateMachine, useValue: { recordInboundSettlement: jest.fn() } },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: AlertsService, useValue: { send: jest.fn() } },
      ],
    }).compile();

    service = module.get(WebhookPollerService);
    prisma = module.get(PrismaPrivilegedService);
    stateMachine = module.get(TransactionStateMachine);
    auditLog = module.get(AuditLogService);
    alerts = module.get(AlertsService);
  });

  it("settles against the single active tenant matching the shortcode", async () => {
    jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([c2bEvent()] as any);
    jest
      .spyOn(prisma.tenantShortcode, "findMany")
      .mockResolvedValueOnce([{ tenant: { id: "tenant-active" } }] as any);
    jest.spyOn(stateMachine, "recordInboundSettlement").mockResolvedValueOnce({ id: "tx-1" } as any);

    await service.pollUnprocessedEvents();

    expect(prisma.tenantShortcode.findMany).toHaveBeenCalledWith({
      where: { shortcode: "174379", tenant: { status: "active" } },
      include: { tenant: true },
    });
    expect(stateMachine.recordInboundSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-active" }),
    );
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("ignores a shortcode with no active tenant (e.g. two pending_kyc tenants sharing the sandbox shortcode)", async () => {
    jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([c2bEvent()] as any);
    jest.spyOn(prisma.tenantShortcode, "findMany").mockResolvedValueOnce([]);

    await service.pollUnprocessedEvents();

    expect(stateMachine.recordInboundSettlement).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "daraja.c2b_unmatched" }));
  });

  it("refuses to guess and alerts critically when a shortcode somehow matches more than one active tenant", async () => {
    jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([c2bEvent()] as any);
    jest
      .spyOn(prisma.tenantShortcode, "findMany")
      .mockResolvedValueOnce([{ tenant: { id: "tenant-a" } }, { tenant: { id: "tenant-b" } }] as any);

    await service.pollUnprocessedEvents();

    expect(stateMachine.recordInboundSettlement).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "daraja.c2b_ambiguous_shortcode",
        metadata: expect.objectContaining({ matchedTenantIds: ["tenant-a", "tenant-b"] }),
      }),
    );
    expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
  });
});

function b2cEvent(source: string, resultOverrides: Record<string, unknown> = {}) {
  return {
    id: "evt-b2c",
    source,
    attempts: 0,
    payload: {
      Result: {
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        OriginatorConversationID: "oc-1",
        ConversationID: "AG_1",
        TransactionID: "LGR019G3J2",
        ResultParameters: {
          ResultParameter: [
            { Key: "TransactionAmount", Value: 500 },
            { Key: "TransactionReceipt", Value: "LGR019G3J2" },
          ],
        },
        ...resultOverrides,
      },
    },
  };
}

describe("WebhookPollerService — B2C payout callbacks", () => {
  let service: WebhookPollerService;
  let prisma: PrismaPrivilegedService;
  let stateMachine: TransactionStateMachine;
  let auditLog: AuditLogService;
  let alerts: AlertsService;

  const payoutRow = { id: "payout-1", tenantId: "tenant-1", direction: "OUTBOUND" };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookPollerService,
        {
          provide: PrismaPrivilegedService,
          useValue: {
            webhookEvent: { findMany: jest.fn(), update: jest.fn() },
            tenantShortcode: { findMany: jest.fn() },
            transaction: { findUnique: jest.fn() },
          },
        },
        {
          provide: TransactionStateMachine,
          useValue: {
            transitionPayoutToSettled: jest.fn(),
            transitionPayoutToFailed: jest.fn(),
          },
        },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
        { provide: AlertsService, useValue: { send: jest.fn() } },
      ],
    }).compile();

    service = module.get(WebhookPollerService);
    prisma = module.get(PrismaPrivilegedService);
    stateMachine = module.get(TransactionStateMachine);
    auditLog = module.get(AuditLogService);
    alerts = module.get(AlertsService);
  });

  describe("b2c result", () => {
    it("settles the payout, correlating on originatorConversationId", async () => {
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([b2cEvent("daraja_b2c_result")] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(prisma.transaction.findUnique).toHaveBeenCalledWith({
        where: { originatorConversationId: "oc-1" },
      });
      expect(stateMachine.transitionPayoutToSettled).toHaveBeenCalledWith("payout-1", {
        mpesaReceiptNumber: "LGR019G3J2",
      });
    });

    // ResultParameters uses Key/Value; the STK callback uses Name/Value. Reading the
    // wrong one yields undefined rather than an error, so this is worth pinning down.
    it("reads the receipt from the Key/Value shape of ResultParameters", async () => {
      const event = b2cEvent("daraja_b2c_result", {
        TransactionID: "fallback-id",
        ResultParameters: { ResultParameter: [{ Key: "TransactionReceipt", Value: "FROM-PARAMS" }] },
      });
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([event] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(stateMachine.transitionPayoutToSettled).toHaveBeenCalledWith("payout-1", {
        mpesaReceiptNumber: "FROM-PARAMS",
      });
    });

    it("falls back to Result.TransactionID when no TransactionReceipt parameter is present", async () => {
      const event = b2cEvent("daraja_b2c_result", { ResultParameters: undefined });
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([event] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(stateMachine.transitionPayoutToSettled).toHaveBeenCalledWith("payout-1", {
        mpesaReceiptNumber: "LGR019G3J2",
      });
    });

    it("fails the payout and alerts on a non-zero ResultCode", async () => {
      const event = b2cEvent("daraja_b2c_result", {
        ResultCode: 2001,
        ResultDesc: "The initiator information is invalid",
      });
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([event] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(stateMachine.transitionPayoutToFailed).toHaveBeenCalledWith("payout-1", {
        failureReason: "The initiator information is invalid",
      });
      expect(stateMachine.transitionPayoutToSettled).not.toHaveBeenCalled();
      expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning" }));
    });

    it("records an unmatched callback without transitioning anything", async () => {
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([b2cEvent("daraja_b2c_result")] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(null);

      await service.pollUnprocessedEvents();

      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "daraja.b2c_callback_unmatched" }),
      );
      expect(stateMachine.transitionPayoutToSettled).not.toHaveBeenCalled();
      expect(stateMachine.transitionPayoutToFailed).not.toHaveBeenCalled();
    });

    // findUnique throws on an undefined filter, which would burn all five retry
    // attempts on a payload that is never going to become valid.
    it("never queries with an undefined OriginatorConversationID", async () => {
      const event = b2cEvent("daraja_b2c_result", { OriginatorConversationID: undefined });
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([event] as any);

      await service.pollUnprocessedEvents();

      expect(prisma.transaction.findUnique).not.toHaveBeenCalled();
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "daraja.b2c_callback_unmatched" }),
      );
    });
  });

  describe("b2c timeout", () => {
    // The money-safety property of this whole module: a timeout is not a failure.
    // Releasing the reservation on one lets the same shillings go out twice if the
    // payout later succeeds.
    it("does NOT fail the payout or release the reservation", async () => {
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([b2cEvent("daraja_b2c_timeout")] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(stateMachine.transitionPayoutToFailed).not.toHaveBeenCalled();
      expect(stateMachine.transitionPayoutToSettled).not.toHaveBeenCalled();
    });

    it("raises a critical alert and audits the timeout", async () => {
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([b2cEvent("daraja_b2c_timeout")] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "critical" }));
      expect(auditLog.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: "daraja.b2c_timeout", targetId: "payout-1" }),
      );
    });

    it("marks the event processed so Safaricom is not retried against forever", async () => {
      jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([b2cEvent("daraja_b2c_timeout")] as any);
      jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(payoutRow as any);

      await service.pollUnprocessedEvents();

      expect(prisma.webhookEvent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ processedAt: expect.any(Date) }) }),
      );
    });
  });
});

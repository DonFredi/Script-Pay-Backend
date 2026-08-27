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
            tenant: { findMany: jest.fn() },
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
    jest.spyOn(prisma.tenant, "findMany").mockResolvedValueOnce([{ id: "tenant-active" }] as any);
    jest.spyOn(stateMachine, "recordInboundSettlement").mockResolvedValueOnce({ id: "tx-1" } as any);

    await service.pollUnprocessedEvents();

    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: { businessShortcode: "174379", status: "active" },
    });
    expect(stateMachine.recordInboundSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: "tenant-active" }),
    );
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("ignores a shortcode with no active tenant (e.g. two pending_kyc tenants sharing the sandbox shortcode)", async () => {
    jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([c2bEvent()] as any);
    jest.spyOn(prisma.tenant, "findMany").mockResolvedValueOnce([]);

    await service.pollUnprocessedEvents();

    expect(stateMachine.recordInboundSettlement).not.toHaveBeenCalled();
    expect(auditLog.record).toHaveBeenCalledWith(expect.objectContaining({ action: "daraja.c2b_unmatched" }));
  });

  it("refuses to guess and alerts critically when a shortcode somehow matches more than one active tenant", async () => {
    jest.spyOn(prisma.webhookEvent, "findMany").mockResolvedValueOnce([c2bEvent()] as any);
    jest
      .spyOn(prisma.tenant, "findMany")
      .mockResolvedValueOnce([{ id: "tenant-a" }, { id: "tenant-b" }] as any);

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

import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { PayoutResolutionService } from "./payout-resolution.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { AuditLogService } from "../audit-log/audit-log.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

describe("PayoutResolutionService", () => {
  let service: PayoutResolutionService;
  let prisma: PrismaPrivilegedService;
  let stateMachine: TransactionStateMachine;
  let auditLog: AuditLogService;

  const caller: AuthenticatedUser = { id: "admin-1", email: "admin@example.com", role: "SUPER_ADMIN", tenantId: null };

  const stuckPayout = {
    id: "tx-1",
    tenantId: "tenant-1",
    direction: "OUTBOUND",
    status: "PROCESSING",
    amountMinorUnits: 1000,
    originatorConversationId: "ocid-1",
    conversationId: "AG_1",
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PayoutResolutionService,
        {
          provide: PrismaPrivilegedService,
          useValue: {
            transaction: { findUnique: jest.fn(), findUniqueOrThrow: jest.fn() },
            reconciliationRecord: { updateMany: jest.fn() },
          },
        },
        {
          provide: TransactionStateMachine,
          useValue: { transitionPayoutToFailed: jest.fn(), transitionPayoutToSettled: jest.fn() },
        },
        { provide: AuditLogService, useValue: { record: jest.fn() } },
      ],
    }).compile();

    service = module.get(PayoutResolutionService);
    prisma = module.get(PrismaPrivilegedService);
    stateMachine = module.get(TransactionStateMachine);
    auditLog = module.get(AuditLogService);
  });

  it("throws NotFoundException for a transaction that doesn't exist", async () => {
    jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(null as any);

    await expect(
      service.resolve("missing", { resolution: "FAILED", reason: "checked Safaricom portal" }, caller),
    ).rejects.toThrow(NotFoundException);
  });

  it("refuses to touch an INBOUND transaction", async () => {
    jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce({ ...stuckPayout, direction: "INBOUND" } as any);

    await expect(
      service.resolve("tx-1", { resolution: "FAILED", reason: "checked Safaricom portal" }, caller),
    ).rejects.toThrow(BadRequestException);
    expect(stateMachine.transitionPayoutToFailed).not.toHaveBeenCalled();
  });

  it("refuses to re-resolve a payout that isn't PROCESSING", async () => {
    jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce({ ...stuckPayout, status: "FAILED" } as any);

    await expect(
      service.resolve("tx-1", { resolution: "FAILED", reason: "checked Safaricom portal" }, caller),
    ).rejects.toThrow(ConflictException);
    expect(stateMachine.transitionPayoutToFailed).not.toHaveBeenCalled();
  });

  it("resolves a stuck payout as FAILED through the state machine, closes the drift flag, and audit-logs it", async () => {
    jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(stuckPayout as any);
    jest.spyOn(prisma.transaction, "findUniqueOrThrow").mockResolvedValueOnce({ ...stuckPayout, status: "FAILED" } as any);

    await service.resolve("tx-1", { resolution: "FAILED", reason: "checked Safaricom portal, no debit occurred" }, caller);

    expect(stateMachine.transitionPayoutToFailed).toHaveBeenCalledWith("tx-1", {
      failureReason: expect.stringContaining("checked Safaricom portal"),
    });
    expect(prisma.reconciliationRecord.updateMany).toHaveBeenCalledWith({
      where: { transactionId: "tx-1" },
      data: expect.objectContaining({ reconciledAt: expect.any(Date) }),
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "daraja.b2c_failed_manual_resolution",
        actorType: "user",
        actorId: "admin-1",
        targetId: "tx-1",
        metadata: expect.objectContaining({ resolution: "FAILED" }),
      }),
    );
  });

  it("resolves a stuck payout as SETTLED with a receipt number", async () => {
    jest.spyOn(prisma.transaction, "findUnique").mockResolvedValueOnce(stuckPayout as any);
    jest.spyOn(prisma.transaction, "findUniqueOrThrow").mockResolvedValueOnce({ ...stuckPayout, status: "SETTLED" } as any);

    await service.resolve(
      "tx-1",
      { resolution: "SETTLED", mpesaReceiptNumber: "RCU12345", reason: "confirmed via Safaricom support ticket #4821" },
      caller,
    );

    expect(stateMachine.transitionPayoutToSettled).toHaveBeenCalledWith("tx-1", { mpesaReceiptNumber: "RCU12345" });
    expect(prisma.reconciliationRecord.updateMany).toHaveBeenCalledWith({
      where: { transactionId: "tx-1" },
      data: expect.objectContaining({ reconciledAt: expect.any(Date), confirmedAmount: 1000 }),
    });
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "daraja.b2c_settled_manual_resolution" }),
    );
  });
});

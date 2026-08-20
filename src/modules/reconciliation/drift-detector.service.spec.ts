import { Test, TestingModule } from "@nestjs/testing";
import { DriftDetectorService } from "./drift-detector.service";
import { PrismaService } from "../prisma/prisma.service";
import { DarajaClient } from "../../infrastructure/daraja/daraja.client";
import { TransactionStateMachine } from "../payments/transaction-state-machine";
import { TenantsService } from "../tenants/tenants.service";

describe("DriftDetectorService", () => {
  let service: DriftDetectorService;
  let prisma: PrismaService;
  let daraja: DarajaClient;
  let stateMachine: TransactionStateMachine;
  let tenantsService: TenantsService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DriftDetectorService,
        {
          provide: PrismaService,
          useValue: {
            transaction: { findMany: jest.fn() },
            reconciliationRecord: { updateMany: jest.fn() },
          },
        },
        { provide: DarajaClient, useValue: { queryStkPushStatus: jest.fn() } },
        {
          provide: TransactionStateMachine,
          useValue: { transitionToSettled: jest.fn(), transitionToFailed: jest.fn() },
        },
        { provide: TenantsService, useValue: { getMpesaCredentialsForPayment: jest.fn() } },
      ],
    }).compile();

    service = module.get(DriftDetectorService);
    prisma = module.get(PrismaService);
    daraja = module.get(DarajaClient);
    stateMachine = module.get(TransactionStateMachine);
    tenantsService = module.get(TenantsService);
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
});

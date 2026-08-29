import { Test, TestingModule } from "@nestjs/testing";
import { ReportingService } from "./reporting.service";
import { PrismaService } from "../prisma/prisma.service";

describe("ReportingService", () => {
  let service: ReportingService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReportingService,
        {
          provide: PrismaService,
          useFactory: (): PrismaService => {
            const mock: any = {
              transaction: { groupBy: jest.fn() },
              reconciliationRecord: { count: jest.fn() },
            };
            // Mirrors PrismaService.withTenantContext's real signature, running the
            // callback against this same mock rather than a real transaction.
            mock.withTenantContext = jest.fn((_tenantId: string, fn: (tx: unknown) => unknown) => fn(mock));
            return mock as PrismaService;
          },
        },
      ],
    }).compile();

    service = module.get(ReportingService);
    prisma = module.get(PrismaService);
  });

  it("computes successRate and byStatus breakdown from mixed transaction statuses", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([
      { status: "SETTLED", direction: "INBOUND", _count: { _all: 7 }, _sum: { amountMinorUnits: 70000 } },
      { status: "FAILED", direction: "INBOUND", _count: { _all: 3 }, _sum: { amountMinorUnits: null } },
    ] as any);
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValueOnce(2).mockResolvedValueOnce(0);

    const result = await service.paymentSummary("tenant-1", 7);

    expect(result.totalCount).toBe(10);
    expect(result.successRate).toBe(0.7);
    expect(result.byStatus).toEqual({
      pending: 0,
      processing: 0,
      settled: 7,
      failed: 3,
      reversed: 0,
    });
    expect(result.settledAmountMinorUnits).toBe(70000);
    expect(result.reconciliationDriftCount).toBe(2);
  });

  /**
   * The reason the groupBy gained a direction dimension: payouts share the
   * transactions table with collections, so without the split a run of failed payouts
   * would drag down the COLLECTION success rate shown on the dashboard — one number
   * describing two unrelated things, and therefore neither.
   */
  it("keeps the top-level figures to collections and reports payouts separately", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([
      { status: "SETTLED", direction: "INBOUND", _count: { _all: 8 }, _sum: { amountMinorUnits: 80000 } },
      { status: "FAILED", direction: "INBOUND", _count: { _all: 2 }, _sum: { amountMinorUnits: null } },
      // Every payout in the window failed.
      { status: "FAILED", direction: "OUTBOUND", _count: { _all: 5 }, _sum: { amountMinorUnits: null } },
    ] as any);
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValueOnce(1).mockResolvedValueOnce(4);

    const result = await service.paymentSummary("tenant-1", 7);

    // Unchanged by the five failed payouts sitting in the same table.
    expect(result.totalCount).toBe(10);
    expect(result.successRate).toBe(0.8);
    expect(result.reconciliationDriftCount).toBe(1);

    expect(result.payouts.totalCount).toBe(5);
    expect(result.payouts.successRate).toBe(0);
    expect(result.payouts.byStatus.failed).toBe(5);
    expect(result.payouts.reconciliationDriftCount).toBe(4);
  });

  it("reports a null payout successRate when the tenant has made no payouts", async () => {
    jest
      .spyOn(prisma.transaction, "groupBy")
      .mockResolvedValueOnce([
        { status: "SETTLED", direction: "INBOUND", _count: { _all: 3 }, _sum: { amountMinorUnits: 30000 } },
      ] as any);
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValue(0);

    const result = await service.paymentSummary("tenant-1", 7);

    // null, not 0 — "no payouts yet" must not render as "every payout failed".
    expect(result.payouts.successRate).toBeNull();
    expect(result.payouts.totalCount).toBe(0);
  });

  it("returns a null successRate instead of dividing by zero when there is no activity", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([]);
    // Called twice now — once per direction. mockResolvedValue, not ...Once.
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValue(0);

    const result = await service.paymentSummary("tenant-1", 7);

    expect(result.totalCount).toBe(0);
    expect(result.successRate).toBeNull();
    expect(result.settledAmountMinorUnits).toBe(0);
  });

  it("scopes the query by tenantId and the requested time window", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([]);
    // Called twice now — once per direction. mockResolvedValue, not ...Once.
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValue(0);

    await service.paymentSummary("tenant-42", 30);

    const args = (prisma.transaction.groupBy as jest.Mock).mock.calls[0][0];
    expect(args.where.tenantId).toBe("tenant-42");
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
  });

  it("runs both reads under the requested tenant's RLS context", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([]);
    // Called twice now — once per direction. mockResolvedValue, not ...Once.
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValue(0);

    await service.paymentSummary("tenant-42", 7);

    expect((prisma as any).withTenantContext).toHaveBeenCalledWith("tenant-42", expect.any(Function));
  });
});

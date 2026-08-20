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
          useValue: {
            transaction: { groupBy: jest.fn() },
            reconciliationRecord: { count: jest.fn() },
          },
        },
      ],
    }).compile();

    service = module.get(ReportingService);
    prisma = module.get(PrismaService);
  });

  it("computes successRate and byStatus breakdown from mixed transaction statuses", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([
      { status: "SETTLED", _count: { _all: 7 }, _sum: { amountMinorUnits: 70000 } },
      { status: "FAILED", _count: { _all: 3 }, _sum: { amountMinorUnits: null } },
    ] as any);
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValueOnce(2);

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

  it("returns a null successRate instead of dividing by zero when there is no activity", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([]);
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValueOnce(0);

    const result = await service.paymentSummary("tenant-1", 7);

    expect(result.totalCount).toBe(0);
    expect(result.successRate).toBeNull();
    expect(result.settledAmountMinorUnits).toBe(0);
  });

  it("scopes the query by tenantId and the requested time window", async () => {
    jest.spyOn(prisma.transaction, "groupBy").mockResolvedValueOnce([]);
    jest.spyOn(prisma.reconciliationRecord, "count").mockResolvedValueOnce(0);

    await service.paymentSummary("tenant-42", 30);

    const args = (prisma.transaction.groupBy as jest.Mock).mock.calls[0][0];
    expect(args.where.tenantId).toBe("tenant-42");
    expect(args.where.createdAt.gte).toBeInstanceOf(Date);
  });
});

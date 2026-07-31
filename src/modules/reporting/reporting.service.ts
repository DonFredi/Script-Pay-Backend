import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Native SQL GROUP BY via Prisma's groupBy — this is the exact capability the
   * original assessment flagged Firestore as weak at. One query, not a client-side
   * loop over documents.
   */
  async paymentSummary(tenantId: string, sinceDays = 7) {
    const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);

    const grouped = await this.prisma.transaction.groupBy({
      by: ["status"],
      where: { tenantId, createdAt: { gte: since } },
      _count: { _all: true },
      _sum: { amountMinorUnits: true },
    });

    const counts = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const totalCount = grouped.reduce((sum, g) => sum + g._count._all, 0);
    const settledCount = counts["SETTLED"] ?? 0;

    const driftCount = await this.prisma.reconciliationRecord.count({
      where: { tenantId, driftDetected: true, createdAt: { gte: since } },
    });

    return {
      periodDays: sinceDays,
      totalCount,
      successRate: totalCount > 0 ? settledCount / totalCount : null,
      byStatus: {
        pending: counts["PENDING"] ?? 0,
        processing: counts["PROCESSING"] ?? 0,
        settled: settledCount,
        failed: counts["FAILED"] ?? 0,
        reversed: counts["REVERSED"] ?? 0,
      },
      settledAmountMinorUnits: grouped.find((g) => g.status === "SETTLED")?._sum.amountMinorUnits ?? 0,
      reconciliationDriftCount: driftCount, // rising trend here signals a webhook delivery problem
    };
  }
}

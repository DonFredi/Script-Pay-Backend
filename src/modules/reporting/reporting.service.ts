import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/** One direction's rows, reduced to the counts/sums the dashboard renders. */
function summarize(rows: Array<{ status: string; _count: { _all: number }; _sum: { amountMinorUnits: number | null } }>) {
  const counts = Object.fromEntries(rows.map((r) => [r.status, r._count._all]));
  const totalCount = rows.reduce((sum, r) => sum + r._count._all, 0);
  const settledCount = counts["SETTLED"] ?? 0;

  return {
    totalCount,
    // null rather than 0 for an empty period — "no transactions yet" and "every
    // transaction failed" are very different things to show someone.
    successRate: totalCount > 0 ? settledCount / totalCount : null,
    byStatus: {
      pending: counts["PENDING"] ?? 0,
      processing: counts["PROCESSING"] ?? 0,
      settled: settledCount,
      failed: counts["FAILED"] ?? 0,
      reversed: counts["REVERSED"] ?? 0,
    },
    settledAmountMinorUnits: rows.find((r) => r.status === "SETTLED")?._sum.amountMinorUnits ?? 0,
  };
}

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

    // Caller (ReportingController.summary) always resolves to exactly one
    // concrete tenantId before calling this — safe to run both reads under that
    // one tenant's RLS context in a single wrapped transaction.
    const { grouped, driftCount, payoutDriftCount } = await this.prisma.withTenantContext(tenantId, async (tx) => {
      // Grouped by direction as well as status since payouts landed. Without that
      // split, a tenant with a run of failed payouts would watch their COLLECTION
      // success rate fall on the dashboard — two unrelated things averaged into one
      // number that then describes neither.
      const grouped = await tx.transaction.groupBy({
        by: ["status", "direction"],
        where: { tenantId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { amountMinorUnits: true },
      });

      // Scoped through the transaction relation for the same reason: a stuck payout
      // and a lost STK callback are different operational problems with different
      // fixes, and merging their counts hides both.
      const driftCount = await tx.reconciliationRecord.count({
        where: {
          tenantId,
          driftDetected: true,
          createdAt: { gte: since },
          transaction: { direction: "INBOUND" },
        },
      });

      const payoutDriftCount = await tx.reconciliationRecord.count({
        where: {
          tenantId,
          driftDetected: true,
          createdAt: { gte: since },
          transaction: { direction: "OUTBOUND" },
        },
      });

      return { grouped, driftCount, payoutDriftCount };
    });

    const collections = summarize(grouped.filter((g) => g.direction === "INBOUND"));
    const payouts = summarize(grouped.filter((g) => g.direction === "OUTBOUND"));

    return {
      periodDays: sinceDays,
      // These top-level fields keep their original shape AND their original meaning:
      // collections only. They described collections before payouts existed, and a
      // dashboard reading them should not silently start seeing a blended figure.
      ...collections,
      reconciliationDriftCount: driftCount, // rising trend here signals a webhook delivery problem
      payouts: {
        ...payouts,
        // Rising here means payouts are going unresolved with funds held reserved —
        // see DriftDetectorService.detectStuckPayouts.
        reconciliationDriftCount: payoutDriftCount,
      },
    };
  }
}

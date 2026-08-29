import { Controller, ForbiddenException, Get, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { PrismaService } from "../prisma/prisma.service";
import { LedgerService } from "./ledger.service";

/**
 * Dashboard-facing balance read. Nothing exposed this before — the B2C payout form
 * could only tell a merchant they were short by letting the request fail with a 422
 * from LedgerService.assertSufficientBalance. This is the same computed figure
 * (LedgerService.availableBalance), read outside the spend path for display only.
 *
 * Guard chain and tenantId resolution mirror ReportingController exactly: a
 * SUPER_ADMIN caller has no tenant of their own and must say which tenant via
 * ?tenantId=, everyone else is scoped to their own.
 */
@Controller("v1/ledger")
@UseGuards(AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard)
@ReadThrottle()
export class LedgerController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  @Get("balance")
  async balance(@CurrentUser() user: AuthenticatedUser, @Query("tenantId") queryTenantId?: string) {
    let tenantId: string;
    if (user.role === "SUPER_ADMIN") {
      if (!queryTenantId) throw new ForbiddenException("Platform staff must specify ?tenantId= explicitly");
      tenantId = queryTenantId;
    } else {
      if (!user.tenantId) throw new ForbiddenException("Account has no associated tenant");
      tenantId = user.tenantId;
    }

    const availableMinorUnits = await this.prisma.withTenantContext(tenantId, (tx) =>
      this.ledger.availableBalance(tx, tenantId),
    );

    return { tenantId, availableMinorUnits };
  }
}

import { Controller, ForbiddenException, Get, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { ReportingService } from "./reporting.service";

@Controller("v1/reporting")
@UseGuards(AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard)
@ReadThrottle()
export class ReportingController {
  constructor(private readonly reporting: ReportingService) {}

  @Get("summary")
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") queryTenantId?: string,
    @Query("days") days?: string,
  ) {
    let tenantId: string;
    if (user.role === "SUPER_ADMIN") {
      if (!queryTenantId) throw new ForbiddenException("Platform staff must specify ?tenantId= explicitly");
      tenantId = queryTenantId;
    } else {
      if (!user.tenantId) throw new ForbiddenException("Account has no associated tenant");
      tenantId = user.tenantId;
    }

    return this.reporting.paymentSummary(tenantId, days ? Number(days) : 7);
  }
}

import { BadRequestException, Controller, ForbiddenException, Get, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { ReportingService } from "./reporting.service";

const DEFAULT_PERIOD_DAYS = 7;
// A year of daily rows is already a large aggregate for this endpoint; beyond that
// a caller wants an export, not a dashboard summary.
const MAX_PERIOD_DAYS = 366;

/**
 * `days ? Number(days) : 7` accepted anything: `?days=abc` became NaN, which
 * ReportingService turned into `new Date(Date.now() - NaN)` — an Invalid Date that
 * Prisma rejects, surfacing as a 500 for what is plainly a bad request. A negative
 * value was worse: it silently queried a window in the FUTURE and reported zero
 * transactions, which reads as "you have no payments" rather than as an error.
 */
function parseDays(days?: string): number {
  if (days === undefined || days === "") return DEFAULT_PERIOD_DAYS;

  const parsed = Number(days);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_PERIOD_DAYS) {
    throw new BadRequestException(`days must be a whole number between 1 and ${MAX_PERIOD_DAYS}`);
  }
  return parsed;
}

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

    return this.reporting.paymentSummary(tenantId, parseDays(days));
  }
}

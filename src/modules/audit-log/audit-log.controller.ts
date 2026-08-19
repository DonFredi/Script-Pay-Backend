import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { AuditLogService } from "./audit-log.service";

/**
 * SUPER_ADMIN can query any tenant's log (or all tenants', if tenantId is omitted).
 * TENANT_ADMIN can query too, but AuditLogService.list scopes them to their own
 * tenant regardless of what tenantId they pass. TENANT_STAFF is excluded — audit
 * history is an admin-level concern, not a day-to-day operational one.
 */
@Controller("v1/audit-logs")
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles("SUPER_ADMIN", "TENANT_ADMIN")
@ReadThrottle()
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
    @Query("action") action?: string,
  ) {
    return this.auditLog.list({ tenantId, action }, user);
  }
}
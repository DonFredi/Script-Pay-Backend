import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { AuditLogService } from "./audit-log.service";

@Controller("v1/audit-logs")
@UseGuards(AccessTokenGuard, RolesGuard)
@Roles("SUPER_ADMIN")
@ReadThrottle()
export class AuditLogController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  list(@Query("tenantId") tenantId?: string) {
    return this.auditLog.list({ tenantId });
  }
}

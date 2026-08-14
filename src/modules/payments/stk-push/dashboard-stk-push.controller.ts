import { Body, Controller, ForbiddenException, Post, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../../auth/access-token.guard";
import { CsrfGuard } from "../../../common/guards/csrf.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../../common/guards/tenant-aware-throttler.guard";
import { Roles } from "../../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { StrictPaymentThrottle } from "../../../common/throttle-tiers";
import { initiateStkPushSchema, type InitiateStkPushDto } from "./initiate-stk-push.dto";
import { StkPushService } from "./stk-push.service";

/**
 * Deliberately a SEPARATE route + guard from StkPushController (which is API-key
 * authenticated, for tenants' own external integrations). This one is for the
 * dashboard's own "send a payment" form — the caller is a logged-in human, not an
 * automated system, so tenantId comes from their Firebase-verified User record,
 * never from a request body field (which a client could tamper with to initiate
 * a payment against a tenant they don't belong to).
 *
 * Guard order: AccessTokenGuard sets request.user.tenantId before
 * TenantAwareThrottlerGuard reads it.
 */
@Controller("v1/dashboard/payments/stk-push")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("TENANT_ADMIN", "TENANT_STAFF")
export class DashboardStkPushController {
  constructor(private readonly stkPushService: StkPushService) {}

  @Post()
  @StrictPaymentThrottle()
  async initiate(
    @Body(new ZodValidationPipe(initiateStkPushSchema)) body: InitiateStkPushDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.tenantId) throw new ForbiddenException("Account has no associated tenant");
    return this.stkPushService.initiate(user.tenantId, body);
  }
}

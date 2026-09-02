import { Body, Controller, ForbiddenException, Headers, Post, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../../auth/access-token.guard";
import { CsrfGuard } from "../../../common/guards/csrf.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../../common/guards/tenant-aware-throttler.guard";
import { Roles } from "../../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { StrictPaymentThrottle } from "../../../common/throttle-tiers";
import { initiateB2cSchema, type InitiateB2cDto } from "./initiate-b2c.dto";
import { B2cService } from "./b2c.service";

/**
 * The dashboard's own "send money" form. Separate route and guard chain from
 * B2cController (API-key authenticated, for a tenant's external integration) for the
 * same reason the STK push pair is split: the caller here is a logged-in human, so
 * tenantId comes from the verified token, never from a body field a client could
 * tamper with to draw a payout from someone else's balance.
 *
 * `@Roles("TENANT_ADMIN")` — deliberately NARROWER than the STK dashboard route,
 * which allows TENANT_STAFF too. Taking a payment in is routine work; sending money
 * out drains the tenant's own balance and is not the same category of action. A staff
 * member who needs to disburse should be an admin, not silently granted the ability
 * because the two routes looked symmetrical.
 *
 * Guard order: AccessTokenGuard populates request.user (and so user.tenantId) before
 * RolesGuard and TenantAwareThrottlerGuard read it. See app.module.ts on why
 * RolesGuard is never a global APP_GUARD.
 */
@Controller("v1/dashboard/payments/b2c")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("TENANT_ADMIN")
export class DashboardB2cController {
  constructor(private readonly b2cService: B2cService) {}

  @Post()
  @StrictPaymentThrottle()
  async initiate(
    @Body(new ZodValidationPipe(initiateB2cSchema)) body: InitiateB2cDto,
    @CurrentUser() user: AuthenticatedUser,
    // Standard REST idempotency-key convention, in addition to the body field — a
    // double-click on the dashboard's "send money" button retries with the same
    // header automatically if the frontend sets one; either source works.
    @Headers("idempotency-key") idempotencyKeyHeader?: string,
  ) {
    if (!user.tenantId) throw new ForbiddenException("Account has no associated tenant");

    return this.b2cService.initiate(
      user.tenantId,
      { ...body, idempotencyKey: body.idempotencyKey ?? idempotencyKeyHeader },
      { type: "user", id: user.id },
    );
  }
}

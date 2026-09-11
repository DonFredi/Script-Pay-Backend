import { Body, Controller, Param, Patch, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { StrictPaymentThrottle } from "../../common/throttle-tiers";
import { resolvePayoutSchema, type ResolvePayoutDto } from "./resolve-payout.dto";
import { PayoutResolutionService } from "./payout-resolution.service";

/**
 * Manual override for a payout Safaricom never answered — see
 * PayoutResolutionService's own doc comment for why this exists and what it does
 * instead of a raw DB edit.
 *
 * SUPER_ADMIN only, deliberately narrower than any existing payout route: this
 * moves money-adjacent state (releases or confirms a reservation) on a caller's
 * say-so rather than Safaricom's, for a tenant that isn't the caller's own. A
 * TENANT_ADMIN allowed to call this on their own stuck payout could simply
 * assert "FAILED" to get reserved funds back regardless of whether the payout
 * actually went through at Safaricom — the exact double-spend risk the queue-
 * timeout handling elsewhere in this module (WebhookPollerService.processB2cTimeout)
 * exists to avoid. This route carries the same risk with a human replacing the
 * uncertainty a timeout leaves — worth it only when the caller is platform staff
 * with no stake in the outcome.
 *
 * Guard order matches every other dashboard-mutating route in this repo: see
 * .claude/skills/add-guarded-route.md.
 */
@Controller("v1/reconciliation/payouts")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("SUPER_ADMIN")
export class PayoutResolutionController {
  constructor(private readonly payoutResolution: PayoutResolutionService) {}

  @Patch(":id/resolve")
  @StrictPaymentThrottle()
  async resolve(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(resolvePayoutSchema)) dto: ResolvePayoutDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payoutResolution.resolve(id, dto, user);
  }
}

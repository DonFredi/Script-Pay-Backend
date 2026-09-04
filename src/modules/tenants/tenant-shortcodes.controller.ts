import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { ReadThrottle, StrictPaymentThrottle } from "../../common/throttle-tiers";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { createShortcodeSchema, updateShortcodeSchema, type CreateShortcodeDto, type UpdateShortcodeDto } from "./tenant-shortcodes.schema";
import { TenantShortcodesService } from "./tenant-shortcodes.service";

/**
 * Same shape as ApiKeysController: cookie/session-authenticated, self-service for a
 * TENANT_ADMIN acting on their own tenant, or SUPER_ADMIN acting on any tenant via
 * ?tenantId=. CsrfGuard on every mutating route — a forged request here could add or
 * remove the shortcode Daraja routes real payments to.
 */
@Controller("v1/tenant-shortcodes")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("TENANT_ADMIN", "SUPER_ADMIN")
@ReadThrottle()
export class TenantShortcodesController {
  constructor(private readonly shortcodes: TenantShortcodesService) {}

  @Post()
  // create() calls Daraja twice per request (verifyCredentials, then registerC2bUrl),
  // and this controller had no throttler guard at all — an authenticated user could
  // drive unbounded traffic at Safaricom using their own tenant's app credentials,
  // which is a good way to get that tenant's Daraja app throttled or locked.
  @StrictPaymentThrottle()
  create(
    @Body(new ZodValidationPipe(createShortcodeSchema)) dto: CreateShortcodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
  ) {
    return this.shortcodes.create(this.resolveTenantId(user, tenantId), dto, user);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("tenantId") tenantId?: string) {
    return this.shortcodes.listForTenant(this.resolveTenantId(user, tenantId), user);
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateShortcodeSchema)) dto: UpdateShortcodeDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
  ) {
    return this.shortcodes.update(this.resolveTenantId(user, tenantId), id, dto, user);
  }

  /**
   * Re-registers this shortcode's C2B callback URLs with Safaricom, using the
   * CURRENT MPESA_CALLBACK_BASE_URL. Needed whenever the backend moves domain:
   * STK Push and B2C callback URLs are rebuilt on every request and so follow the
   * env var automatically, but C2B's are stored on Safaricom's side from a
   * one-time registration and keep pointing at the old host until re-sent.
   *
   * A POST rather than a PATCH: it changes state at Safaricom, not on this
   * shortcode row, so there is no representation here to modify. Idempotent —
   * re-registering the same URLs is exactly what this is for.
   *
   * StrictPaymentThrottle because it calls Daraja on every invocation, matching
   * create() on this same controller.
   */
  @Post(":id/register-c2b-url")
  @HttpCode(200)
  @StrictPaymentThrottle()
  registerC2bUrl(
    @Param("id") id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
  ) {
    return this.shortcodes.registerC2bUrl(this.resolveTenantId(user, tenantId), id, user);
  }

  @Delete(":id")
  remove(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser, @Query("tenantId") tenantId?: string) {
    return this.shortcodes.remove(this.resolveTenantId(user, tenantId), id, user);
  }

  /** Identical to ApiKeysController.resolveTenantId — same reasoning applies verbatim. */
  private resolveTenantId(user: AuthenticatedUser, queryTenantId?: string): string {
    if (user.role === "SUPER_ADMIN") {
      if (!queryTenantId) throw new BadRequestException("SUPER_ADMIN must specify ?tenantId=");
      return queryTenantId;
    }
    if (!user.tenantId) throw new ForbiddenException("Platform staff must specify a tenant explicitly");
    return user.tenantId;
  }
}

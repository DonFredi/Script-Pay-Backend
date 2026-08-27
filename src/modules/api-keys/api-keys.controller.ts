import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { StrictPaymentThrottle } from "../../common/throttle-tiers";
import { createApiKeySchema, type CreateApiKeyDto } from "./api-key.dto";
import { ApiKeysService } from "./api-keys.service";

/**
 * Note the guard: this is cookie/session-authenticated (a logged-in dashboard user
 * managing their OWN tenant's keys), distinct from ApiKeyGuard which authenticates a
 * tenant's automated systems calling the payments API. Don't confuse "managing keys"
 * with "authenticating via a key" — they're separate concerns with separate guards.
 *
 * CsrfGuard is required on create/revoke — both are cookie-authenticated, state-changing
 * actions with real consequences (a forged create/revoke could hijack or cut off a
 * tenant's payment integration).
 */
@Controller("v1/api-keys")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("TENANT_ADMIN", "SUPER_ADMIN")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @StrictPaymentThrottle() // key issuance is rare and sensitive — same tight ceiling as payment initiation
  create(
    @Body(new ZodValidationPipe(createApiKeySchema)) dto: CreateApiKeyDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query("tenantId") tenantId?: string,
  ) {
    return this.apiKeys.create(this.resolveTenantId(user, tenantId), dto.scopes, user.id, dto.expiresAt);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser, @Query("tenantId") tenantId?: string) {
    return this.apiKeys.listForTenant(this.resolveTenantId(user, tenantId));
  }

  @Delete(":id")
  revoke(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser, @Query("tenantId") tenantId?: string) {
    return this.apiKeys.revoke(this.resolveTenantId(user, tenantId), id, user.id);
  }

  /**
   * TENANT_ADMIN is always scoped to their own tenant regardless of any tenantId
   * query param they pass — prevents guessing another tenant's id to create/read/revoke
   * their keys. SUPER_ADMIN has no tenant of their own, so for create/list/revoke
   * (oversight and onboarding provisioning, not self-service) they must name one
   * explicitly via ?tenantId= — there's no "act on every tenant at once" mode, this
   * is per-tenant, on-demand only.
   */
  private resolveTenantId(user: AuthenticatedUser, queryTenantId?: string): string {
    if (user.role === "SUPER_ADMIN") {
      if (!queryTenantId) throw new BadRequestException("SUPER_ADMIN must specify ?tenantId=");
      return queryTenantId;
    }
    if (!user.tenantId) throw new ForbiddenException("Platform staff must specify a tenant explicitly");
    return user.tenantId;
  }
}

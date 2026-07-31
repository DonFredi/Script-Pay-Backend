import { Body, Controller, Delete, ForbiddenException, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { StrictPaymentThrottle } from "../../common/throttle-tiers";
import { createApiKeySchema, type CreateApiKeyDto } from "./api-key.dto";
import { ApiKeysService } from "./api-keys.service";

/**
 * Note the guard: this is Firebase-authenticated (a logged-in dashboard user managing
 * their OWN tenant's keys), distinct from ApiKeyGuard which authenticates a tenant's
 * automated systems calling the payments API. Don't confuse "managing keys" with
 * "authenticating via a key" — they're separate concerns with separate guards.
 */
@Controller("v1/api-keys")
@UseGuards(AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("TENANT_ADMIN", "SUPER_ADMIN")
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Post()
  @StrictPaymentThrottle() // key issuance is rare and sensitive — same tight ceiling as payment initiation
  create(
    @Body(new ZodValidationPipe(createApiKeySchema)) dto: CreateApiKeyDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (!user.tenantId) throw new ForbiddenException("Platform staff must specify a tenant explicitly");
    return this.apiKeys.create(user.tenantId, dto.scopes, user.id, dto.expiresAt);
  }

  @Get()
  list(@CurrentUser() user: AuthenticatedUser) {
    if (!user.tenantId) throw new ForbiddenException("Platform staff must specify a tenant explicitly");
    return this.apiKeys.listForTenant(user.tenantId);
  }

  @Delete(":id")
  revoke(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    if (!user.tenantId) throw new ForbiddenException("Platform staff must specify a tenant explicitly");
    return this.apiKeys.revoke(user.tenantId, id, user.id);
  }
}

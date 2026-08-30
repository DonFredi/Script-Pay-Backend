import { Body, Controller, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { createTenantSchema, updateTenantStatusSchema, type CreateTenantDto, type UpdateTenantStatusDto } from "./tenant.dto";
import { TenantsService } from "./tenants.service";
import { setAppCredentialsSchema, type SetAppCredentialsDto } from "./tenants.schema";

/**
 * CsrfGuard applies to every mutating route here, including setMpesaCredentials —
 * a forged request to that endpoint could overwrite a tenant's Daraja credentials,
 * which is at least as sensitive as the payment-initiation and API-key routes.
 */
@Controller("v1/tenants")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard)
export class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  @Post()
  @Roles("SUPER_ADMIN")
  create(
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.create(dto, user);
  }

  /**
   * Self-service — no @Roles() restriction beyond what TenantsService.onboardSelf
   * itself enforces (must be TENANT_ADMIN, must not already have a tenant). This is
   * what a freshly-registered user hits from the onboarding flow.
   *
   * IMPORTANT for the frontend: the caller's current access token still has
   * tenantId: null baked into its claims after this call succeeds — the token was
   * signed before onboarding happened. The frontend must call POST /auth/refresh
   * (or otherwise obtain a fresh access token) immediately after this succeeds, or
   * every subsequent request will still look like it's coming from a tenant-less user.
   */
  @Post("onboard")
  onboardSelf(
    @Body(new ZodValidationPipe(createTenantSchema)) dto: CreateTenantDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.onboardSelf(dto, user);
  }

  @Get()
  @Roles("SUPER_ADMIN")
  listAll() {
    return this.tenants.listAll();
  }

  @Get(":id")
  // No @Roles() here deliberately — any authenticated role may call this, but
  // TenantsService.findOne enforces "only your own tenant" for non-SUPER_ADMIN callers.
  findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.tenants.findOne(id, user);
  }
  /**
   * Shared, org-level Consumer Key/Secret only — shortcode-specific credentials
   * (passkey, B2C initiator/security credential) go through
   * TenantShortcodesController instead, one call per shortcode.
   */
  @Post(":id/app-credentials")
  setAppCredentials(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(setAppCredentialsSchema)) dto: SetAppCredentialsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.setAppCredentials(id, dto, user);
  }

  /**
   * SUPER_ADMIN can change any tenant to any status. TENANT_ADMIN can only
   * activate/suspend their OWN tenant — TenantsService.updateStatus enforces both
   * restrictions; TENANT_STAFF is blocked entirely at the @Roles() level below.
   */
  @Patch(":id/status")
  @Roles("SUPER_ADMIN", "TENANT_ADMIN")
  updateStatus(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(updateTenantStatusSchema)) dto: UpdateTenantStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.updateStatus(id, dto, user);
  }
}
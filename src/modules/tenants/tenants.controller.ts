import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { createTenantSchema, type CreateTenantDto } from "./tenant.dto";
import { TenantsService } from "./tenants.service";
import { mpesaCredentialsSchema, type MpesaCredentialsDto } from "./tenants.schema";

@Controller("v1/tenants")
@UseGuards(AccessTokenGuard, RolesGuard)
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
  @Post(":id/mpesa-credentials")
  setMpesaCredentials(
    @Param("id") id: string,
    @Body(new ZodValidationPipe(mpesaCredentialsSchema)) dto: MpesaCredentialsDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.tenants.setMpesaCredentials(id, dto, user);
  }
}

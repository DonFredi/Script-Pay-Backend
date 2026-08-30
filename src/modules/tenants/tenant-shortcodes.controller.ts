import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
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
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard)
@Roles("TENANT_ADMIN", "SUPER_ADMIN")
export class TenantShortcodesController {
  constructor(private readonly shortcodes: TenantShortcodesService) {}

  @Post()
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

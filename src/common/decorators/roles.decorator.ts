import { SetMetadata } from "@nestjs/common";
import type { Role } from "@prisma/client";

export const ROLES_KEY = "roles";

/**
 * Usage: @Roles("TENANT_ADMIN", "SUPER_ADMIN")
 * Applied on top of AccessTokenGuard — this only checks role, it does not authenticate.
 */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

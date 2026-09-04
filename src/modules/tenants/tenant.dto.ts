
import { z } from "zod";

export const createTenantSchema = z
  .object({
    name: z.string().min(1).max(200),
    businessShortcode: z.string().regex(/^\d{5,7}$/, "must be a valid Paybill/Till shortcode"),
  })
  .strict();
export type CreateTenantDto = z.infer<typeof createTenantSchema>;

export const inviteTenantUserSchema = z
  .object({
    email: z.string().email(),
    role: z.enum(["TENANT_ADMIN", "TENANT_STAFF"]),
  })
  .strict();
export type InviteTenantUserDto = z.infer<typeof inviteTenantUserSchema>;


/**
 * "pending_kyc" and "removed" are deliberately not settable via this DTO's own
 * validation — both are accepted here because SUPER_ADMIN legitimately needs them
 * (reverting a tenant back into review, or removing/reinstating one), but
 * TenantsService.updateStatus enforces that a TENANT_ADMIN may only ever move their
 * own tenant between "active" and "suspended". "removed" is a platform-only kill
 * switch — a TENANT_ADMIN can neither set their own tenant to "removed" nor bring
 * it back out of that state; only SUPER_ADMIN can do either. Same "authorization
 * lives in the service, not just the DTO" pattern as findOne().
 */
export const updateTenantStatusSchema = z
  .object({
    status: z.enum(["active", "suspended", "pending_kyc", "removed"]),
  })
  .strict();
export type UpdateTenantStatusDto = z.infer<typeof updateTenantStatusSchema>;

import { z } from "zod";

export const createTenantSchema = z.object({
  name: z.string().min(1).max(200),
  businessShortcode: z.string().regex(/^\d{5,7}$/, "must be a valid Paybill/Till shortcode"),
});
export type CreateTenantDto = z.infer<typeof createTenantSchema>;

export const inviteTenantUserSchema = z.object({
  email: z.string().email(),
  role: z.enum(["TENANT_ADMIN", "TENANT_STAFF"]),
});
export type InviteTenantUserDto = z.infer<typeof inviteTenantUserSchema>;


/**
 * "pending_kyc" is deliberately not settable via this DTO's own validation — it's
 * accepted here because SUPER_ADMIN legitimately needs it (e.g. reverting a tenant
 * back into review), but TenantsService.updateStatus enforces that a TENANT_ADMIN
 * may only ever move their own tenant between "active" and "suspended". Same
 * "authorization lives in the service, not just the DTO" pattern as findOne().
 */
export const updateTenantStatusSchema = z.object({
  status: z.enum(["active", "suspended", "pending_kyc"]),
});
export type UpdateTenantStatusDto = z.infer<typeof updateTenantStatusSchema>;
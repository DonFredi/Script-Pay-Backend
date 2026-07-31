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

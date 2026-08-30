import z from "zod";

/**
 * The org-level Daraja app credentials only — Consumer Key/Secret. Split out of
 * what used to be mpesaCredentialsSchema: these are shared across every shortcode
 * a tenant holds (Safaricom issues one production app per organization at go-live),
 * while the shortcode-specific fields (passkey, initiator/security credential) now
 * live on TenantShortcode — see tenant-shortcodes.schema.ts.
 */
export const setAppCredentialsSchema = z.object({
  consumerKey: z.string().trim().min(1, "Consumer key is required"),
  consumerSecret: z.string().trim().min(1, "Consumer secret is required"),
});
export type SetAppCredentialsDto = z.infer<typeof setAppCredentialsSchema>;

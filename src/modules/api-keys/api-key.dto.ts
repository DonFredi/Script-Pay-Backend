import { z } from "zod";

export const createApiKeySchema = z.object({
  scopes: z
    .array(z.enum(["PAYMENTS_INITIATE", "PAYMENTS_READ", "RECONCILIATION_READ", "WEBHOOKS_MANAGE"]))
    .min(1, "at least one scope is required"),
  expiresAt: z.coerce.date().optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

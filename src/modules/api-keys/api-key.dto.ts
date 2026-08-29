import { z } from "zod";

export const createApiKeySchema = z.object({
  // Mirrors the ApiKeyScope enum in schema.prisma by hand — zod can't read a Prisma
  // enum, so a scope added there is unrequestable until it is added here too.
  scopes: z
    .array(
      z.enum([
        "PAYMENTS_INITIATE",
        "PAYMENTS_READ",
        "RECONCILIATION_READ",
        "WEBHOOKS_MANAGE",
        "PAYMENTS_DISBURSE",
      ]),
    )
    .min(1, "at least one scope is required"),
  expiresAt: z.coerce.date().optional(),
});
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

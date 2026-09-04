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
})
  // An unrecognized field is rejected rather than silently dropped. This one matters
  // more than most: the request body decides what an API key is allowed to do, and a
  // misspelled or invented field here should fail loudly, not vanish.
  .strict();
export type CreateApiKeyDto = z.infer<typeof createApiKeySchema>;

import { z } from "zod";

export const setWebhookConfigSchema = z
  .object({
    webhookUrl: z
      .string()
      .url()
      .refine((url) => url.startsWith("https://"), "webhookUrl must be an https:// URL"),
  })
  .strict();
export type SetWebhookConfigDto = z.infer<typeof setWebhookConfigSchema>;

import z from "zod";

export const mpesaCredentialsSchema = z.object({
  businessShortcode: z
    .string()
    .trim()
    .regex(/^\d{5,7}$/, "Shortcode must be 5 to 7 digits"),
  consumerKey: z.string().trim().min(1, "Consumer key is required"),
  consumerSecret: z.string().trim().min(1, "Consumer secret is required"),
  passkey: z.string().trim().min(1, "Passkey is required"),
});
export type MpesaCredentialsDto = z.infer<typeof mpesaCredentialsSchema>;

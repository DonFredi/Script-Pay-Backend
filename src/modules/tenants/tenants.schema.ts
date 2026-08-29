import z from "zod";

const mpesaCredentialsBaseSchema = z.object({
  businessShortcode: z
    .string()
    .trim()
    .regex(/^\d{5,7}$/, "Shortcode must be 5 to 7 digits"),
  consumerKey: z.string().trim().min(1, "Consumer key is required"),
  consumerSecret: z.string().trim().min(1, "Consumer secret is required"),
  passkey: z.string().trim().min(1, "Passkey is required"),

  // B2C payout credentials. Optional because collecting payments is the common case
  // and a tenant configuring only that must not be forced to obtain initiator access
  // it will never use. Supplying one without the other is rejected below — half a
  // credential set would pass validation and then fail at Safaricom, which is a much
  // worse place to discover it.
  initiatorName: z.string().trim().min(1).optional(),
  // The value Safaricom's portal emits: the initiator password already RSA-encrypted
  // against their certificate. ScriptPay never receives the password itself — see
  // schema.prisma on Tenant.mpesaSecurityCredentialEncrypted.
  securityCredential: z.string().trim().min(1).optional(),
});

export const mpesaCredentialsSchema = mpesaCredentialsBaseSchema.refine(
  (v) => (v.initiatorName === undefined) === (v.securityCredential === undefined),
  {
    message: "initiatorName and securityCredential must be provided together — neither works without the other",
    path: ["initiatorName"],
  },
);
export type MpesaCredentialsDto = z.infer<typeof mpesaCredentialsSchema>;

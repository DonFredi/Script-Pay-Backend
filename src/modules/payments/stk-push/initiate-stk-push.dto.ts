import { z } from "zod";

export const initiateStkPushSchema = z.object({
  // Kenyan MSISDN, normalized to 2547XXXXXXXX / 2541XXXXXXXX format by the caller or a transform below.
  msisdn: z.string().regex(/^254(7|1)\d{8}$/, "msisdn must be in 2547XXXXXXXX or 2541XXXXXXXX format"),
  amountMinorUnits: z
    .number()
    .int()
    .positive()
    .max(15_000_00, "single STK push cannot exceed KES 150,000 per Safaricom limits"),
  accountReference: z.string().min(1).max(12), // Daraja hard limit
  transactionDesc: z.string().min(1).max(13), // Daraja hard limit
  // Arbitrary tenant metadata echoed back on the transaction record — never trust this for amounts/identity.
  metadata: z.record(z.string(), z.unknown()).optional(),
  channel: z.enum(["PAYBILL", "TILL"]).default("PAYBILL"),
});

export type InitiateStkPushDto = z.infer<typeof initiateStkPushSchema>;

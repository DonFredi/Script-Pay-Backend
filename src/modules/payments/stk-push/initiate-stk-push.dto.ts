import { z } from "zod";

export const initiateStkPushSchema = z.object({
  // Kenyan MSISDN, normalized to 2547XXXXXXXX / 2541XXXXXXXX format by the caller or a transform below.
  msisdn: z.string().regex(/^254(7|1)\d{8}$/, "msisdn must be in 2547XXXXXXXX or 2541XXXXXXXX format"),
  amountMinorUnits: z
    .number()
    .int()
    .positive()
    // M-Pesa has no sub-shilling denomination, so a minor-unit amount that isn't a
    // whole number of shillings cannot actually be charged. Without this, an amount
    // like 150 (KES 1.50) passed validation, was divided by 100 on the way to Daraja,
    // and Safaricom charged the rounded figure (KES 2) while the ledger recorded the
    // original 150 — money moved that the books disagreed with. Reject it here
    // instead; DarajaClient now also refuses to round rather than silently absorbing
    // one that gets this far.
    .multipleOf(100, "amountMinorUnits must be a whole number of shillings (a multiple of 100)")
    // 150_000_00 is 15,000,000 minor units = KES 150,000. This read 15_000_00
    // (KES 15,000) — a tenth of the documented limit — so every legitimate
    // collection between KES 15,000 and 150,000 was rejected by a message asserting
    // a limit the code did not enforce.
    .max(150_000_00, "single STK push cannot exceed KES 150,000 per Safaricom limits"),
  accountReference: z.string().min(1).max(12), // Daraja hard limit
  transactionDesc: z.string().min(1).max(13), // Daraja hard limit
  // Arbitrary tenant metadata echoed back on the transaction record — never trust this for amounts/identity.
  metadata: z.record(z.string(), z.unknown()).optional(),
  channel: z.enum(["PAYBILL", "TILL"]).default("PAYBILL"),
}).strict();

export type InitiateStkPushDto = z.infer<typeof initiateStkPushSchema>;

import { z } from "zod";

/**
 * NOTE the amount ceiling is NOT the same number as the STK push one. 150,000 in
 * initiate-stk-push.dto.ts is Safaricom's per-transaction limit for a customer
 * paying IN; B2C has its own, separately-tariffed limit that also depends on the
 * shortcode's registration. 250,000 is Safaricom's published B2C ceiling as of
 * writing — CONFIRM IT against current Daraja documentation for the specific
 * shortcode before going live, and do not assume the STK figure transfers.
 *
 * This ceiling is not what protects the platform from over-spending: that is the
 * balance check in LedgerService.assertSufficientBalance, which no request can
 * exceed regardless of what passes validation here. This bound exists so a request
 * Safaricom would reject outright never leaves the building.
 */
const B2C_MAX_MINOR_UNITS = 250_000_00;

export const initiateB2cSchema = z.object({
  // The payee, not the payer — the same format as a collection, the opposite role.
  msisdn: z.string().regex(/^254(7|1)\d{8}$/, "msisdn must be in 2547XXXXXXXX or 2541XXXXXXXX format"),
  amountMinorUnits: z
    .number()
    .int()
    .positive()
    .max(B2C_MAX_MINOR_UNITS, "single B2C payout cannot exceed KES 250,000 per Safaricom limits"),
  // Daraja's Remarks field. Required by the API; kept short because Safaricom
  // truncates long values silently rather than rejecting them.
  remarks: z.string().trim().min(1).max(100),
  occasion: z.string().trim().max(100).optional(),
  /**
   * BusinessPayment is an ordinary disbursement (a refund, a withdrawal).
   * Salary/Promotion are separately registered Safaricom products that differ in
   * recipient registration requirements and charge tariff — a tenant must be
   * enabled for them on Safaricom's side before either will succeed.
   */
  commandId: z.enum(["BusinessPayment", "SalaryPayment", "PromotionPayment"]).default("BusinessPayment"),
  // Arbitrary tenant metadata echoed back on the transaction record — never trusted
  // for amounts or identity, same as the collection path.
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type InitiateB2cDto = z.infer<typeof initiateB2cSchema>;

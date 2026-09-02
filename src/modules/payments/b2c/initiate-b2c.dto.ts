import { z } from "zod";

/**
 * NOTE the amount ceiling is NOT the same number as the STK push one. 150,000 in
 * initiate-stk-push.dto.ts is Safaricom's per-transaction limit for a customer
 * paying IN; B2C has its own, separately-tariffed limit. 250,000 is a reasonable
 * platform-wide default, but Safaricom's actual B2C ceiling is NOT one fixed global
 * number — it varies per shortcode based on that tenant's specific B2C agreement/
 * tier with Safaricom, and can change over time. Before any tenant goes live,
 * confirm this figure against that tenant's own Daraja account limits rather than
 * assuming this default applies to them; do not assume the STK figure transfers
 * either.
 *
 * This ceiling is not what protects the platform from over-spending: that is the
 * balance check in LedgerService.assertSufficientBalance, which no request can
 * exceed regardless of what passes validation here. This bound exists so a request
 * Safaricom would reject outright never leaves the building.
 */
const B2C_MAX_MINOR_UNITS = 250_000_00;

export const initiateB2cSchema = z.object({
  // Which of the tenant's B2C-enabled shortcodes pays out. Required, never defaulted
  // — unlike collections (which fall back to a tenant's default PAYBILL/TILL
  // shortcode), the shortcode a payout draws from is never an implicit choice, since
  // it's the one draining the tenant's balance. See TenantsService.getMpesaCredentialsForPayout.
  shortcodeId: z.string().uuid("shortcodeId must be a valid TenantShortcode id"),
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
  // Caller-supplied dedupe token (also accepted via the `Idempotency-Key` header —
  // see both B2C controllers). A retried/double-clicked initiate with the same key
  // returns the already-created payout instead of sending a second real one. Optional:
  // omitting it preserves today's behavior exactly.
  idempotencyKey: z.string().trim().min(1).max(255).optional(),
});

export type InitiateB2cDto = z.infer<typeof initiateB2cSchema>;

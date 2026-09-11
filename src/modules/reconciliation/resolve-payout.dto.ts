import { z } from "zod";

/**
 * A B2C payout has no automatic recovery path — DriftDetectorService.detectStuckPayouts
 * only ever escalates ("it will NOT resolve itself", see its own doc comment and
 * docs/decisions.md entry 18). This is the manual counterpart: a platform operator who
 * has independently confirmed the real outcome with Safaricom (portal lookup, support
 * ticket) records it here, going through the SAME TransactionStateMachine methods the
 * real callback would have called, rather than a raw DB edit.
 *
 * mpesaReceiptNumber is required when resolution is SETTLED, never when FAILED — a
 * failed payout has no receipt to show, and requiring one here forces the operator to
 * have actual proof of settlement rather than guessing which way to resolve it.
 */
export const resolvePayoutSchema = z
  .object({
    resolution: z.enum(["FAILED", "SETTLED"]),
    mpesaReceiptNumber: z.string().trim().min(1).max(100).optional(),
    // The operator's own justification — always required, since this bypasses the
    // normal callback-driven path and needs to be traceable later (see the audit log
    // entry this produces).
    reason: z.string().trim().min(10, "Explain how this was confirmed (e.g. a Safaricom portal/support reference)"),
  })
  .strict()
  .refine((data) => data.resolution !== "SETTLED" || !!data.mpesaReceiptNumber, {
    message: "mpesaReceiptNumber is required when resolving a payout as SETTLED",
    path: ["mpesaReceiptNumber"],
  });

export type ResolvePayoutDto = z.infer<typeof resolvePayoutSchema>;

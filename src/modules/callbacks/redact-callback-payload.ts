/**
 * Daraja callbacks carry the customer's identity next to the amount they paid:
 * `PhoneNumber`/`Amount` inside an STK `CallbackMetadata`, `MSISDN`/`FirstName` on a
 * C2B confirmation, and `ReceiverPartyPublicName` ("254717123456 - Jane Doe") in a
 * B2C `ResultParameter`. Every error path in this module logged the entire raw
 * payload, which put real customer names, phone numbers and payment amounts into
 * application logs — and from there into wherever those logs ship — for a Kenyan
 * M-Pesa platform.
 *
 * The frontend already refuses to do this: `api-client.ts`'s
 * `scrubErrorDataForSentry` sends field NAMES only, never the submitted values,
 * for exactly this reason. This is the same rule applied on the ingest side.
 *
 * Allowlist rather than denylist, deliberately. Safaricom has changed callback
 * shapes before (see `extract-natural-key`'s doc comment), and a field nobody has
 * seen yet must default to being withheld rather than leaked — that is the safe
 * direction for this to fail in.
 */

/**
 * Values that identify a TRANSACTION rather than a PERSON, plus the outcome codes.
 * Everything else — every name, phone number and amount — is withheld.
 *
 * `BusinessShortCode` is ours, not the payer's, so it identifies which tenant was
 * being paid, not who paid. `BillRefNumber` is deliberately absent: it's
 * caller-supplied free text and merchants routinely put an account or member number
 * in it.
 */
const SAFE_KEYS = new Set([
  "MerchantRequestID",
  "CheckoutRequestID",
  "OriginatorConversationID",
  "ConversationID",
  "TransactionID",
  "TransID",
  "ResultCode",
  "ResultDesc",
  "ResultType",
  "TransactionType",
  "BusinessShortCode",
]);

// Safaricom nests the useful ids about four levels down (Body.stkCallback.…,
// Result.ResultParameters.ResultParameter[]). Bounded so a hostile or malformed
// payload can't turn a log line into a deep traversal.
const MAX_DEPTH = 6;

function collectSafeFields(value: unknown, depth: number, into: Record<string, unknown>): void {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) collectSafeFields(item, depth + 1, into);
    return;
  }

  for (const [key, nested] of Object.entries(value)) {
    if (SAFE_KEYS.has(key) && (typeof nested !== "object" || nested === null)) {
      into[key] = nested;
      continue;
    }
    collectSafeFields(nested, depth + 1, into);
  }
}

/**
 * A log-safe stand-in for a raw Daraja payload: the top-level key NAMES (enough to
 * see the shape of something malformed) and the allowlisted identifiers above.
 */
export function redactCallbackPayload(payload: unknown): Record<string, unknown> {
  if (typeof payload !== "object" || payload === null) {
    return { payloadType: payload === null ? "null" : typeof payload };
  }

  const safeFields: Record<string, unknown> = {};
  collectSafeFields(payload, 0, safeFields);

  return {
    // Names only, never values — the same line the frontend's Sentry scrubbing draws.
    payloadKeys: Object.keys(payload),
    safeFields,
  };
}

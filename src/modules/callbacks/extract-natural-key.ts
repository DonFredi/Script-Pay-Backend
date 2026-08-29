import type { DarajaStkCallback, DarajaB2cResultCallback } from "./daraja-callback.interface";

/**
 * Safaricom's callback payload shapes differ by product (STK Push vs C2B) and have
 * changed across API versions historically — isolate that parsing here so a Daraja
 * payload-shape change is a one-file fix, not a scattered find-and-replace.
 */
export function extractNaturalKey(source: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;

  if (source === "daraja_stk_callback") {
    const stkCallback = (payload as Partial<DarajaStkCallback>).Body?.stkCallback;
    return stkCallback?.CheckoutRequestID ?? null;
  }

  if (source === "daraja_c2b_confirmation") {
    const body = payload as Record<string, unknown>;
    return typeof body.TransID === "string" ? body.TransID : null;
  }

  // Both B2C callbacks key on OriginatorConversationID — the id ScriptPay generated
  // itself before the payment request went out, not one Safaricom assigned. The two
  // sources are separate idempotency namespaces (the unique constraint is on
  // (source, naturalKey)), so a result and a timeout for the SAME payout are two
  // distinct events and both get processed. That is intended: they mean different
  // things and the timeout handler must still run even if a result also arrived.
  if (source === "daraja_b2c_result" || source === "daraja_b2c_timeout") {
    const result = (payload as Partial<DarajaB2cResultCallback>).Result;
    return typeof result?.OriginatorConversationID === "string" ? result.OriginatorConversationID : null;
  }

  return null;
}

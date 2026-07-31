/**
 * Safaricom's callback payload shapes differ by product (STK Push vs C2B) and have
 * changed across API versions historically — isolate that parsing here so a Daraja
 * payload-shape change is a one-file fix, not a scattered find-and-replace.
 */
export function extractNaturalKey(source: string, payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;

  if (source === "daraja_stk_callback") {
    const stkCallback = (body?.Body as any)?.stkCallback;
    return stkCallback?.CheckoutRequestID ?? null;
  }

  if (source === "daraja_c2b_confirmation") {
    return (body?.TransID as string) ?? null;
  }

  return null;
}

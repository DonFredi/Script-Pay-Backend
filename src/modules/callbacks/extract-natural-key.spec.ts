import { extractNaturalKey } from "./extract-natural-key";

describe("extractNaturalKey", () => {
  describe("daraja_stk_callback", () => {
    it("extracts CheckoutRequestID from a real-shaped STK callback payload", () => {
      const payload = { Body: { stkCallback: { CheckoutRequestID: "ws_CO_123", ResultCode: 0 } } };

      expect(extractNaturalKey("daraja_stk_callback", payload)).toBe("ws_CO_123");
    });

    it("returns null when the expected shape is missing", () => {
      expect(extractNaturalKey("daraja_stk_callback", { Body: {} })).toBeNull();
      expect(extractNaturalKey("daraja_stk_callback", {})).toBeNull();
    });
  });

  describe("daraja_c2b_confirmation", () => {
    it("extracts TransID from a real-shaped C2B payload", () => {
      const payload = { TransID: "TX123ABC", BusinessShortCode: "174379" };

      expect(extractNaturalKey("daraja_c2b_confirmation", payload)).toBe("TX123ABC");
    });

    it("returns null when TransID is missing or not a string", () => {
      expect(extractNaturalKey("daraja_c2b_confirmation", {})).toBeNull();
      expect(extractNaturalKey("daraja_c2b_confirmation", { TransID: 12345 })).toBeNull();
    });
  });

  it("returns null for an unrecognized source", () => {
    expect(extractNaturalKey("some_other_source", { TransID: "TX123" })).toBeNull();
  });

  it("returns null for non-object payloads instead of throwing", () => {
    expect(extractNaturalKey("daraja_c2b_confirmation", null)).toBeNull();
    expect(extractNaturalKey("daraja_c2b_confirmation", "a string")).toBeNull();
    expect(extractNaturalKey("daraja_c2b_confirmation", undefined)).toBeNull();
  });

  describe("B2C callbacks", () => {
    const b2cPayload = { Result: { ResultCode: 0, OriginatorConversationID: "oc-42" } };

    it("keys a B2C result on OriginatorConversationID", () => {
      expect(extractNaturalKey("daraja_b2c_result", b2cPayload)).toBe("oc-42");
    });

    it("keys a B2C timeout on OriginatorConversationID", () => {
      expect(extractNaturalKey("daraja_b2c_timeout", b2cPayload)).toBe("oc-42");
    });

    // Separate sources are separate idempotency namespaces — the unique constraint is
    // on (source, naturalKey) — so a result and a timeout for the SAME payout are two
    // distinct events and both get processed. That's intended: they mean different
    // things, and the timeout handler must still run even when a result also arrived.
    it("gives the same key for both sources, which stay distinct events", () => {
      expect(extractNaturalKey("daraja_b2c_result", b2cPayload)).toBe(
        extractNaturalKey("daraja_b2c_timeout", b2cPayload),
      );
    });

    it("returns null when the Result envelope is missing or malformed", () => {
      expect(extractNaturalKey("daraja_b2c_result", {})).toBeNull();
      expect(extractNaturalKey("daraja_b2c_result", { Result: {} })).toBeNull();
      expect(extractNaturalKey("daraja_b2c_result", { Result: { OriginatorConversationID: 42 } })).toBeNull();
      expect(extractNaturalKey("daraja_b2c_result", null)).toBeNull();
    });

    // The STK shape must not accidentally satisfy the B2C branch, or a misrouted
    // payload would be stored under the wrong source.
    it("does not extract a key from an STK payload sent to the B2C source", () => {
      expect(extractNaturalKey("daraja_b2c_result", { Body: { stkCallback: { CheckoutRequestID: "cr-1" } } })).toBeNull();
    });
  });
});

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
});

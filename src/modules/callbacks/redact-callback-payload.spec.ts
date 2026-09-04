import { redactCallbackPayload } from "./redact-callback-payload";

/**
 * The point of these tests is the NEGATIVE assertions. A regression here doesn't
 * throw or fail a request — it quietly starts writing Kenyan customers' phone
 * numbers and names into the application logs, which nothing downstream would flag.
 */
describe("redactCallbackPayload", () => {
  const serialized = (payload: unknown) => JSON.stringify(redactCallbackPayload(payload));

  describe("an STK push callback", () => {
    const stk = {
      Body: {
        stkCallback: {
          MerchantRequestID: "29115-34620561-1",
          CheckoutRequestID: "ws_CO_191220191020363925",
          ResultCode: 0,
          ResultDesc: "The service request is processed successfully.",
          CallbackMetadata: {
            Item: [
              { Name: "Amount", Value: 1.0 },
              { Name: "MpesaReceiptNumber", Value: "NLJ7RT61SV" },
              { Name: "PhoneNumber", Value: 254717123456 },
            ],
          },
        },
      },
    };

    it("keeps the correlation ids and the outcome", () => {
      expect(redactCallbackPayload(stk).safeFields).toEqual({
        MerchantRequestID: "29115-34620561-1",
        CheckoutRequestID: "ws_CO_191220191020363925",
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
      });
    });

    it("withholds the payer's phone number and the amount, however deeply nested", () => {
      const output = serialized(stk);

      expect(output).not.toContain("254717123456");
      expect(output).not.toContain("PhoneNumber");
    });
  });

  describe("a C2B confirmation", () => {
    const c2b = {
      TransactionType: "Pay Bill",
      TransID: "RKTQDM7W6S",
      TransAmount: "500.00",
      BusinessShortCode: "600638",
      BillRefNumber: "ACC-00417",
      MSISDN: "254717123456",
      FirstName: "Jane",
      LastName: "Wanjiru",
    };

    it("keeps only what identifies the transaction and the shortcode paid", () => {
      expect(redactCallbackPayload(c2b).safeFields).toEqual({
        TransactionType: "Pay Bill",
        TransID: "RKTQDM7W6S",
        BusinessShortCode: "600638",
      });
    });

    it("withholds the payer's name, phone and amount", () => {
      const output = serialized(c2b);

      for (const leak of ["254717123456", "Jane", "Wanjiru", "500.00"]) {
        expect(output).not.toContain(leak);
      }
    });

    // Merchants routinely put a customer account or member number in this field,
    // which is why it is absent from the allowlist despite looking innocuous.
    it("withholds BillRefNumber", () => {
      expect(serialized(c2b)).not.toContain("ACC-00417");
    });
  });

  describe("a B2C result", () => {
    const b2c = {
      Result: {
        ResultType: 0,
        ResultCode: 0,
        ResultDesc: "The service request is processed successfully.",
        OriginatorConversationID: "10571-7910404-1",
        ConversationID: "AG_20191219_00004e48cf7e3533f581",
        TransactionID: "NLJ41HAY6Q",
        ResultParameters: {
          ResultParameter: [
            { Key: "TransactionAmount", Value: 10 },
            { Key: "ReceiverPartyPublicName", Value: "254717123456 - John Doe" },
          ],
        },
      },
    };

    it("keeps the ids ScriptPay correlates payouts on", () => {
      expect(redactCallbackPayload(b2c).safeFields).toMatchObject({
        OriginatorConversationID: "10571-7910404-1",
        ConversationID: "AG_20191219_00004e48cf7e3533f581",
        TransactionID: "NLJ41HAY6Q",
        ResultCode: 0,
      });
    });

    // This one field carries the recipient's phone number AND their real name in a
    // single string — the worst thing in any Daraja payload to log.
    it("withholds ReceiverPartyPublicName", () => {
      const output = serialized(b2c);

      expect(output).not.toContain("John Doe");
      expect(output).not.toContain("254717123456");
    });
  });

  describe("payloads that aren't the happy path", () => {
    it("reports the top-level shape of an unrecognised payload without its values", () => {
      const result = redactCallbackPayload({ Surprise: "254717123456", Nested: { MSISDN: "254700000000" } });

      expect(result.payloadKeys).toEqual(["Surprise", "Nested"]);
      expect(result.safeFields).toEqual({});
      expect(JSON.stringify(result)).not.toContain("254717123456");
    });

    it.each([
      [null, "null"],
      [undefined, "undefined"],
      ["not-an-object", "string"],
      [42, "number"],
    ])("describes the type of a non-object payload (%p)", (payload, expected) => {
      expect(redactCallbackPayload(payload)).toEqual({ payloadType: expected });
    });

    // An allowlist means a field Safaricom adds tomorrow is withheld by default
    // rather than leaked — the safe direction to fail in when a payload shape changes.
    it("withholds an unrecognised field even when it sits beside allowlisted ones", () => {
      const result = redactCallbackPayload({ TransID: "TX1", NewPiiFieldSafaricomAdded: "254717123456" });

      expect(result.safeFields).toEqual({ TransID: "TX1" });
      expect(JSON.stringify(result.safeFields)).not.toContain("254717123456");
    });

    it("does not recurse without bound on a deeply nested payload", () => {
      let deep: Record<string, unknown> = { MSISDN: "254717123456" };
      for (let i = 0; i < 200; i += 1) deep = { nested: deep };

      expect(() => redactCallbackPayload(deep)).not.toThrow();
      expect(JSON.stringify(redactCallbackPayload(deep))).not.toContain("254717123456");
    });
  });
});

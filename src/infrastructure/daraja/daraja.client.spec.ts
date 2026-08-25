import { BadGatewayException } from "@nestjs/common";
import { DarajaClient } from "./daraja.client";

const creds = {
  mpesaConsumerKey: "ck-1",
  mpesaConsumerSecretEncrypted: "cs-1",
  mpesaPasskeyEncrypted: "pk-1",
  shortcode: "174379",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

describe("DarajaClient", () => {
  let client: DarajaClient;
  let fetchMock: jest.Mock;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, MPESA_ENV: "sandbox", MPESA_CALLBACK_BASE_URL: "https://api.scriptpay.test" };
    fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    client = new DarajaClient();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe("initiateStkPush", () => {
    it("fetches an OAuth token, then POSTs the STK push request to the sandbox host", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(
          jsonResponse({ MerchantRequestID: "mr-1", CheckoutRequestID: "cr-1", ResponseCode: "0" }),
        );

      const result = await client.initiateStkPush(creds, {
        amount: 100,
        msisdn: "254712345678",
        accountReference: "REF-1",
        transactionDesc: "Test",
        transactionType: "CustomerPayBillOnline",
      });

      expect(result).toEqual({ MerchantRequestID: "mr-1", CheckoutRequestID: "cr-1", ResponseCode: "0" });
      expect(fetchMock.mock.calls[0][0]).toContain("sandbox.safaricom.co.ke");
      expect(fetchMock.mock.calls[1][0]).toContain("sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest");
    });

    it("uses the production host when MPESA_ENV=production", async () => {
      process.env.MPESA_ENV = "production";
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ MerchantRequestID: "mr-1", CheckoutRequestID: "cr-1", ResponseCode: "0" }));

      await client.initiateStkPush(creds, {
        amount: 100,
        msisdn: "254712345678",
        accountReference: "REF-1",
        transactionDesc: "Test",
        transactionType: "CustomerPayBillOnline",
      });

      expect(fetchMock.mock.calls[0][0]).toContain("api.safaricom.co.ke");
    });

    it("caches the OAuth token across calls for the same credentials — only one token fetch for two pushes", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ MerchantRequestID: "mr-1", CheckoutRequestID: "cr-1", ResponseCode: "0" }))
        .mockResolvedValueOnce(jsonResponse({ MerchantRequestID: "mr-2", CheckoutRequestID: "cr-2", ResponseCode: "0" }));

      const params = {
        amount: 100,
        msisdn: "254712345678",
        accountReference: "REF-1",
        transactionDesc: "Test",
        transactionType: "CustomerPayBillOnline" as const,
      };
      await client.initiateStkPush(creds, params);
      await client.initiateStkPush(creds, params);

      const oauthCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/oauth/v1/generate"));
      expect(oauthCalls).toHaveLength(1);
    });

    it("throws BadGatewayException when the OAuth token request fails", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve("invalid creds") });

      await expect(
        client.initiateStkPush(creds, {
          amount: 100,
          msisdn: "254712345678",
          accountReference: "REF-1",
          transactionDesc: "Test",
          transactionType: "CustomerPayBillOnline",
        }),
      ).rejects.toThrow(BadGatewayException);
    });

    it("throws BadGatewayException surfacing Safaricom's own rejection reason when ResponseCode isn't 0", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ ResponseCode: "1", errorMessage: "Invalid CallBackURL" }));

      await expect(
        client.initiateStkPush(creds, {
          amount: 100,
          msisdn: "254712345678",
          accountReference: "REF-1",
          transactionDesc: "Test",
          transactionType: "CustomerPayBillOnline",
        }),
      ).rejects.toThrow("Invalid CallBackURL");
    });

    it("builds the callback URL from MPESA_CALLBACK_BASE_URL", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ MerchantRequestID: "mr-1", CheckoutRequestID: "cr-1", ResponseCode: "0" }));

      await client.initiateStkPush(creds, {
        amount: 100,
        msisdn: "254712345678",
        accountReference: "REF-1",
        transactionDesc: "Test",
        transactionType: "CustomerPayBillOnline",
      });

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.CallBackURL).toBe("https://api.scriptpay.test/v1/webhooks/daraja/stk-callback");
    });
  });

  describe("queryStkPushStatus", () => {
    it("returns the parsed result code and description", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ ResultCode: "0", ResultDesc: "The service request is processed successfully." }));

      const result = await client.queryStkPushStatus(creds, "cr-1");

      expect(result).toEqual({ resultCode: 0, resultDesc: "The service request is processed successfully." });
    });
  });
});

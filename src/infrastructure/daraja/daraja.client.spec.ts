import { BadGatewayException } from "@nestjs/common";
import { DarajaClient } from "./daraja.client";

const creds = {
  mpesaConsumerKey: "ck-1",
  mpesaConsumerSecretEncrypted: "cs-1",
  mpesaPasskeyEncrypted: "pk-1",
  shortcode: "174379",
};

// No passkey: B2C authenticates with the initiator name and security credential,
// so the payout path never carries one.
const payoutCreds = {
  mpesaConsumerKey: "ck-1",
  mpesaConsumerSecretEncrypted: "cs-1",
  shortcode: "600000",
  initiatorName: "testapi",
  securityCredential: "rsa-encrypted-blob",
};

const b2cParams = {
  originatorConversationId: "oc-1",
  amount: 500,
  msisdn: "254712345678",
  commandId: "BusinessPayment" as const,
  remarks: "Refund for order 42",
};

function jsonResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) };
}

describe("DarajaClient", () => {
  let client: DarajaClient;
  let fetchMock: jest.Mock;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      MPESA_ENV: "sandbox",
      MPESA_CALLBACK_BASE_URL: "https://api.scriptpay.test",
      DARAJA_WEBHOOK_SECRET: "test-webhook-secret",
    };
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
      expect(body.CallBackURL).toBe(
        "https://api.scriptpay.test/v1/webhooks/daraja/stk-callback?token=test-webhook-secret",
      );
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

  describe("initiateB2C", () => {
    const acceptedResponse = {
      ConversationID: "AG_20260829_conv1",
      OriginatorConversationID: "oc-1",
      ResponseCode: "0",
      ResponseDescription: "Accept the service request successfully.",
    };

    it("POSTs to the B2C payment-request endpoint and returns the conversation ids", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      const result = await client.initiateB2C(payoutCreds, b2cParams);

      expect(result).toEqual({
        ConversationID: "AG_20260829_conv1",
        OriginatorConversationID: "oc-1",
        ResponseCode: "0",
      });
      expect(fetchMock.mock.calls[1][0]).toContain("sandbox.safaricom.co.ke/mpesa/b2c/v3/paymentrequest");
    });

    // The reverse of STK push, where the customer is PartyA. Getting these backwards
    // is the easiest mistake to make when adapting one call to the other.
    it("sends the shortcode as PartyA and the customer handset as PartyB", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      await client.initiateB2C(payoutCreds, b2cParams);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.PartyA).toBe("600000");
      expect(body.PartyB).toBe("254712345678");
    });

    it("sends the caller's OriginatorConversationID rather than generating one", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      await client.initiateB2C(payoutCreds, b2cParams);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.OriginatorConversationID).toBe("oc-1");
    });

    it("authenticates with the initiator name and security credential", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      await client.initiateB2C(payoutCreds, b2cParams);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.InitiatorName).toBe("testapi");
      // Passed through verbatim — already RSA-encrypted by Safaricom's portal.
      expect(body.SecurityCredential).toBe("rsa-encrypted-blob");
      expect(body.CommandID).toBe("BusinessPayment");
    });

    it("sends BOTH callback URLs, built from MPESA_CALLBACK_BASE_URL", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      await client.initiateB2C(payoutCreds, b2cParams);

      const body = JSON.parse(fetchMock.mock.calls[1][1].body);
      expect(body.ResultURL).toBe("https://api.scriptpay.test/v1/webhooks/daraja/b2c-result?token=test-webhook-secret");
      expect(body.QueueTimeOutURL).toBe(
        "https://api.scriptpay.test/v1/webhooks/daraja/b2c-timeout?token=test-webhook-secret",
      );
    });

    it("uses the production host when MPESA_ENV=production", async () => {
      process.env.MPESA_ENV = "production";
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      await client.initiateB2C(payoutCreds, b2cParams);

      expect(fetchMock.mock.calls[1][0]).toContain("api.safaricom.co.ke/mpesa/b2c/v3/paymentrequest");
    });

    it("shares the OAuth token cache with the collection path — same consumer key, one token fetch", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ MerchantRequestID: "mr-1", CheckoutRequestID: "cr-1", ResponseCode: "0" }))
        .mockResolvedValueOnce(jsonResponse(acceptedResponse));

      await client.initiateStkPush(creds, {
        amount: 100,
        msisdn: "254712345678",
        accountReference: "REF-1",
        transactionDesc: "Test",
        transactionType: "CustomerPayBillOnline",
      });
      await client.initiateB2C(payoutCreds, b2cParams);

      const oauthCalls = fetchMock.mock.calls.filter(([url]) => String(url).includes("/oauth/v1/generate"));
      expect(oauthCalls).toHaveLength(1);
    });

    it("throws BadGatewayException surfacing Safaricom's own rejection reason", async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ access_token: "tok-1", expires_in: "3599" }))
        .mockResolvedValueOnce(jsonResponse({ ResponseCode: "2001", errorMessage: "Invalid Initiator Information" }));

      await expect(client.initiateB2C(payoutCreds, b2cParams)).rejects.toThrow("Invalid Initiator Information");
    });

    it("throws BadGatewayException when the OAuth token request fails", async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 401, text: () => Promise.resolve("invalid creds") });

      await expect(client.initiateB2C(payoutCreds, b2cParams)).rejects.toThrow(BadGatewayException);
    });
  });
});

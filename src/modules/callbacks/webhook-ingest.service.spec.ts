import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { WebhookIngestService, parseDarajaTimestamp } from "./webhook-ingest.service";
import { PrismaService } from "../prisma/prisma.service";

function stkPayload(overrides: { resultCode?: number; checkoutRequestId?: string } = {}) {
  return {
    Body: {
      stkCallback: {
        MerchantCheckoutSessionID: "ws_CO_1",
        CheckoutRequestID: overrides.checkoutRequestId ?? "ws_CO_123",
        ResultCode: overrides.resultCode ?? 0,
        ResultDesc: "The service request has been processed successfully.",
        CallbackMetadata: {
          Item: [
            { Name: "Amount", Value: 100 },
            { Name: "MpesaReceiptNumber", Value: "LHG31H5V60K0" },
            { Name: "TransactionDate", Value: 20231129133424 },
            { Name: "PhoneNumber", Value: 254717123456 },
          ],
        },
      },
    },
  };
}

function c2bPayload() {
  return {
    TransactionType: "Pay Bill",
    TransID: "LHG31H5V60K0",
    TransTime: "20231129133424",
    TransAmount: "100.00",
    BusinessShortCode: "600000",
    BillRefNumber: "INV-1",
    MSISDN: "254717123456",
    FirstName: "Jane",
  };
}

describe("WebhookIngestService", () => {
  let service: WebhookIngestService;
  let prisma: PrismaService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        WebhookIngestService,
        {
          provide: PrismaService,
          useValue: { webhookEvent: { create: jest.fn() } },
        },
      ],
    }).compile();

    service = module.get<WebhookIngestService>(WebhookIngestService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  describe("ingest", () => {
    it("rejects a non-object payload", async () => {
      await expect(service.ingest("daraja_stk_callback", "not-an-object")).rejects.toThrow(BadRequestException);
      expect(prisma.webhookEvent.create).not.toHaveBeenCalled();
    });

    it("rejects a payload with no extractable natural key", async () => {
      await expect(service.ingest("daraja_stk_callback", {})).rejects.toThrow(
        "Cannot extract unique identifier from callback",
      );
    });

    it("stores the event keyed by the extracted CheckoutRequestID", async () => {
      jest.spyOn(prisma.webhookEvent, "create").mockResolvedValueOnce({ id: "evt-1" } as any);

      await service.ingest("daraja_stk_callback", stkPayload({ checkoutRequestId: "ws_CO_999" }));

      expect(prisma.webhookEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ source: "daraja_stk_callback", naturalKey: "ws_CO_999" }),
        }),
      );
    });

    it("swallows a duplicate delivery (unique constraint violation) instead of throwing", async () => {
      jest.spyOn(prisma.webhookEvent, "create").mockRejectedValueOnce({ code: "P2002" });

      await expect(service.ingest("daraja_stk_callback", stkPayload())).resolves.toBeUndefined();
    });

    it("rethrows an unexpected database error", async () => {
      jest.spyOn(prisma.webhookEvent, "create").mockRejectedValueOnce(new Error("connection reset"));

      await expect(service.ingest("daraja_stk_callback", stkPayload())).rejects.toThrow("connection reset");
    });
  });

  describe("normalizePayload", () => {
    it("normalizes a successful STK callback", () => {
      const result = service.normalizePayload("daraja_stk_callback", stkPayload());

      expect(result).toMatchObject({
        checkoutRequestId: "ws_CO_123",
        mpesaReceiptNumber: "LHG31H5V60K0",
        resultCode: 0,
        success: true,
        amount: 100,
        msisdn: "254717123456",
        callbackType: "stk_push",
      });
    });

    it("normalizes a failed STK callback (no CallbackMetadata) as unsuccessful", () => {
      const payload = {
        Body: {
          stkCallback: {
            MerchantCheckoutSessionID: "ws_CO_1",
            CheckoutRequestID: "ws_CO_456",
            ResultCode: 1032,
            ResultDesc: "Request cancelled by user",
          },
        },
      };

      const result = service.normalizePayload("daraja_stk_callback", payload);

      expect(result.success).toBe(false);
      expect(result.mpesaReceiptNumber).toBeUndefined();
      expect(result.resultCode).toBe(1032);
    });

    it("throws BadRequestException when Body.stkCallback is missing", () => {
      expect(() => service.normalizePayload("daraja_stk_callback", { Body: {} })).toThrow(BadRequestException);
    });

    it("throws BadRequestException for a non-object payload", () => {
      expect(() => service.normalizePayload("daraja_c2b_confirmation", null)).toThrow(BadRequestException);
    });

    it("normalizes a real, FLAT C2B confirmation", () => {
      // Safaricom does not wrap C2B in Body.stkCallback. This normalizer used to
      // expect the STK shape, so every genuine C2B payload threw instead of parsing.
      const result = service.normalizePayload("daraja_c2b_confirmation", c2bPayload());

      expect(result).toMatchObject({
        mpesaReceiptNumber: "LHG31H5V60K0",
        success: true,
        resultCode: 0,
        amount: 100,
        msisdn: "254717123456",
        callbackType: "c2b",
      });
      // No checkout request exists for a customer-initiated paybill/till payment.
      expect(result.checkoutRequestId).toBeUndefined();
    });

    it("keys a C2B confirmation on TransID, and rejects one without it", () => {
      const { TransID: _omitted, ...withoutTransId } = c2bPayload();

      expect(() => service.normalizePayload("daraja_c2b_confirmation", withoutTransId)).toThrow(BadRequestException);
    });
  });

  describe("parseDarajaTimestamp", () => {
    it("parses Daraja's YYYYMMDDHHmmss stamp as Nairobi time (UTC+3)", () => {
      // 13:34:24 EAT is 10:34:24 UTC. `new Date("20231129133424")` — what this code
      // used to do — is an Invalid Date, so transactionDate was silently NaN.
      expect(parseDarajaTimestamp(20231129133424)?.toISOString()).toBe("2023-11-29T10:34:24.000Z");
      expect(parseDarajaTimestamp("20231129133424")?.toISOString()).toBe("2023-11-29T10:34:24.000Z");
    });

    it("returns undefined rather than an Invalid Date for absent or malformed input", () => {
      expect(parseDarajaTimestamp(undefined)).toBeUndefined();
      expect(parseDarajaTimestamp("not-a-timestamp")).toBeUndefined();
      expect(parseDarajaTimestamp("2023112913342")).toBeUndefined(); // 13 digits, not 14
    });

    it("flows through to a real callback's transactionDate", () => {
      const result = service.normalizePayload("daraja_stk_callback", stkPayload());

      expect(result.transactionDate?.toISOString()).toBe("2023-11-29T10:34:24.000Z");
    });
  });
});

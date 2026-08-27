import { DarajaWebhookController } from "./daraja-webhook.controller";
import { WebhookIngestService } from "./webhook-ingest.service";

describe("DarajaWebhookController", () => {
  let controller: DarajaWebhookController;
  let ingest: WebhookIngestService;

  beforeEach(() => {
    ingest = { ingest: jest.fn() } as any;
    controller = new DarajaWebhookController(ingest);
  });

  describe("handleStkCallback", () => {
    it("ingests the raw payload under the daraja_stk_callback source and returns Safaricom's expected ack shape", async () => {
      const payload = { Body: { stkCallback: { CheckoutRequestID: "ws_CO_1", ResultCode: 0 } } };

      const result = await controller.handleStkCallback(payload);

      expect(ingest.ingest).toHaveBeenCalledWith("daraja_stk_callback", payload);
      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });

    it("still returns 200-shaped ack even when ingest() throws — Safaricom must never see an error, or it retries forever", async () => {
      jest.spyOn(ingest, "ingest").mockRejectedValueOnce(new Error("db unreachable"));

      const result = await controller.handleStkCallback({ Body: {} });

      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });

    it("swallows a non-object payload internally — never calls ingest(), but still ack's 200 (the outer catch traps its own validation throw, same as any other failure)", async () => {
      const result = await controller.handleStkCallback(null);

      expect(ingest.ingest).not.toHaveBeenCalled();
      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });

    it("does the same for a string payload", async () => {
      const result = await controller.handleStkCallback("not-an-object");

      expect(ingest.ingest).not.toHaveBeenCalled();
      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });
  });

  describe("handleC2bConfirmation", () => {
    it("ingests the raw payload under the daraja_c2b_confirmation source and returns Safaricom's expected ack shape", async () => {
      const payload = { TransID: "TX123", BusinessShortCode: "174379" };

      const result = await controller.handleC2bConfirmation(payload);

      expect(ingest.ingest).toHaveBeenCalledWith("daraja_c2b_confirmation", payload);
      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });

    it("still returns 200-shaped ack even when ingest() throws", async () => {
      jest.spyOn(ingest, "ingest").mockRejectedValueOnce(new Error("unique constraint violated"));

      const result = await controller.handleC2bConfirmation({ TransID: "TX123" });

      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });

    it("swallows a non-object payload internally — never calls ingest(), but still ack's 200", async () => {
      const result = await controller.handleC2bConfirmation(undefined);

      expect(ingest.ingest).not.toHaveBeenCalled();
      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
    });
  });
});

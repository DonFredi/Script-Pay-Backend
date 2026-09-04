import { DarajaWebhookController } from "./daraja-webhook.controller";
import { WebhookIngestService } from "./webhook-ingest.service";
import { WebhookPollerService } from "./webhook-poller.service";

describe("DarajaWebhookController", () => {
  let controller: DarajaWebhookController;
  let ingest: WebhookIngestService;
  let poller: WebhookPollerService;

  beforeEach(() => {
    ingest = { ingest: jest.fn() } as any;
    poller = { pollUnprocessedEvents: jest.fn().mockResolvedValue(undefined) } as any;
    controller = new DarajaWebhookController(ingest, poller);
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

  // Under JOB_SCHEDULER=external the scheduler is Supabase Cron, whose finest
  // granularity is one minute — so without this nudge a settled payment can sit
  // unprocessed for up to a further 60s after the customer has already paid.
  describe("draining the queue as soon as a callback lands", () => {
    it.each([
      ["handleStkCallback", { Body: { stkCallback: { CheckoutRequestID: "ws_CO_1" } } }],
      ["handleC2bConfirmation", { TransID: "TX123" }],
      ["handleB2cResult", { Result: { OriginatorConversationID: "oc-1" } }],
      ["handleB2cTimeout", { Result: { OriginatorConversationID: "oc-1" } }],
    ] as const)("%s polls for unprocessed events after a successful ingest", async (method, payload) => {
      await controller[method](payload);

      expect(poller.pollUnprocessedEvents).toHaveBeenCalledTimes(1);
    });

    it("does not poll when ingest failed — there is nothing new to drain", async () => {
      jest.spyOn(ingest, "ingest").mockRejectedValueOnce(new Error("db unreachable"));

      await controller.handleStkCallback({ Body: {} });

      expect(poller.pollUnprocessedEvents).not.toHaveBeenCalled();
    });

    // A floating promise that rejects takes the whole Node process down by default.
    // Safaricom's ack must survive a processing failure, and so must the backend.
    it("still ack's 200 when the kicked poll rejects, without an unhandled rejection", async () => {
      jest.spyOn(poller, "pollUnprocessedEvents").mockRejectedValueOnce(new Error("poller exploded"));

      const result = await controller.handleStkCallback({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_1" } } });

      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
      await Promise.resolve(); // let the rejection settle inside the .catch()
    });

    // The ack must not wait on our own processing — Safaricom times these out.
    it("returns without waiting for the poll to finish", async () => {
      let releasePoll: () => void = () => {};
      jest
        .spyOn(poller, "pollUnprocessedEvents")
        .mockReturnValueOnce(new Promise<void>((resolve) => (releasePoll = resolve)));

      const result = await controller.handleStkCallback({ Body: { stkCallback: { CheckoutRequestID: "ws_CO_1" } } });

      expect(result).toEqual({ ResultCode: 0, ResultDesc: "Accepted" });
      releasePoll();
    });
  });
});

import { StkPushController } from "./stk-push.controller";
import { StkPushService } from "./stk-push.service";

describe("StkPushController", () => {
  let controller: StkPushController;
  let stkPushService: StkPushService;

  beforeEach(() => {
    stkPushService = { initiate: jest.fn() } as any;
    controller = new StkPushController(stkPushService);
  });

  it("initiates a payment under the tenant resolved by ApiKeyGuard (request.tenantId), never from the request body", async () => {
    const body = { msisdn: "254700000000", amountMinorUnits: 10000, accountReference: "INV-1" } as any;
    const request = { tenantId: "tenant-1" } as any;
    jest.spyOn(stkPushService, "initiate").mockResolvedValueOnce({ id: "tx-1" } as any);

    const result = await controller.initiate(body, request);

    expect(stkPushService.initiate).toHaveBeenCalledWith("tenant-1", body);
    expect(result).toEqual({ id: "tx-1" });
  });
});

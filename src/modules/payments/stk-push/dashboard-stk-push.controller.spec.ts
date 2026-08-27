import { ForbiddenException } from "@nestjs/common";
import { DashboardStkPushController } from "./dashboard-stk-push.controller";
import { StkPushService } from "./stk-push.service";
import type { AuthenticatedUser } from "../../../common/decorators/current-user.decorator";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

describe("DashboardStkPushController", () => {
  let controller: DashboardStkPushController;
  let stkPushService: StkPushService;

  beforeEach(() => {
    stkPushService = { initiate: jest.fn() } as any;
    controller = new DashboardStkPushController(stkPushService);
  });

  it("initiates a payment under the logged-in user's own tenantId, never from the request body", async () => {
    const body = { msisdn: "254700000000", amountMinorUnits: 10000, accountReference: "INV-1" } as any;
    jest.spyOn(stkPushService, "initiate").mockResolvedValueOnce({ id: "tx-1" } as any);

    const result = await controller.initiate(body, user({ tenantId: "tenant-1" }));

    expect(stkPushService.initiate).toHaveBeenCalledWith("tenant-1", body);
    expect(result).toEqual({ id: "tx-1" });
  });

  it("rejects a caller with no associated tenant before ever calling StkPushService", async () => {
    const body = { msisdn: "254700000000", amountMinorUnits: 10000, accountReference: "INV-1" } as any;

    await expect(controller.initiate(body, user({ tenantId: null }))).rejects.toThrow(ForbiddenException);
    expect(stkPushService.initiate).not.toHaveBeenCalled();
  });
});

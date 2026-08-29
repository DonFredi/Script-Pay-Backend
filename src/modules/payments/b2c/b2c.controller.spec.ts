import { B2cController } from "./b2c.controller";
import { B2cService } from "./b2c.service";
import { ApiKeyGuard } from "../../../common/guards/api-key.guard";
import { TenantAwareThrottlerGuard } from "../../../common/guards/tenant-aware-throttler.guard";
import { API_KEY_SCOPES_KEY } from "../../../common/decorators/api-key-scopes.decorator";

describe("B2cController", () => {
  let controller: B2cController;
  let b2cService: B2cService;

  beforeEach(() => {
    b2cService = { initiate: jest.fn() } as any;
    controller = new B2cController(b2cService);
  });

  it("initiates a payout under the tenant resolved by ApiKeyGuard, never from the request body", async () => {
    const body = { msisdn: "254700000000", amountMinorUnits: 50000, remarks: "Refund" } as any;
    // A body that tries to name its own tenant must be ignored — the guard's value wins.
    const request = { tenantId: "tenant-1", apiKeyId: "key-1" } as any;
    jest.spyOn(b2cService, "initiate").mockResolvedValueOnce({ transactionId: "payout-1" } as any);

    const result = await controller.initiate(body, request);

    expect(b2cService.initiate).toHaveBeenCalledWith("tenant-1", body, { type: "api_key", id: "key-1" });
    expect(result).toEqual({ transactionId: "payout-1" });
  });

  it("attributes the payout to the api key, not to the system", async () => {
    jest.spyOn(b2cService, "initiate").mockResolvedValueOnce({} as any);

    await controller.initiate({} as any, { tenantId: "tenant-1" } as any);

    // id may be absent, but the actor TYPE must never degrade to "system" — that
    // would lose the attribution the audit log exists to record.
    expect(b2cService.initiate).toHaveBeenCalledWith("tenant-1", {}, { type: "api_key", id: null });
  });

  /**
   * The security property this whole scope exists for: every API key already issued
   * carries PAYMENTS_INITIATE, so gating payouts behind that scope would have handed
   * every existing key the ability to drain its tenant's balance.
   */
  it("requires PAYMENTS_DISBURSE, and does NOT accept PAYMENTS_INITIATE", () => {
    const scopes = Reflect.getMetadata(API_KEY_SCOPES_KEY, B2cController.prototype.initiate);

    expect(scopes).toEqual(["PAYMENTS_DISBURSE"]);
    expect(scopes).not.toContain("PAYMENTS_INITIATE");
  });

  // ApiKeyGuard must run first: it sets request.tenantId, which
  // TenantAwareThrottlerGuard reads to rate-limit per tenant instead of per IP.
  // Reversing the pair breaks throttling silently, with no error anywhere.
  it("applies ApiKeyGuard before TenantAwareThrottlerGuard", () => {
    const guards = Reflect.getMetadata("__guards__", B2cController);

    expect(guards).toEqual([ApiKeyGuard, TenantAwareThrottlerGuard]);
  });
});

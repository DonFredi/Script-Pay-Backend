import { ForbiddenException } from "@nestjs/common";
import { DashboardB2cController } from "./dashboard-b2c.controller";
import { B2cService } from "./b2c.service";
import { AccessTokenGuard } from "../../auth/access-token.guard";
import { CsrfGuard } from "../../../common/guards/csrf.guard";
import { RolesGuard } from "../../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../../common/guards/tenant-aware-throttler.guard";
import { ROLES_KEY } from "../../../common/decorators/roles.decorator";

describe("DashboardB2cController", () => {
  let controller: DashboardB2cController;
  let b2cService: B2cService;

  const admin = { id: "user-1", tenantId: "tenant-1", role: "TENANT_ADMIN" } as any;

  beforeEach(() => {
    b2cService = { initiate: jest.fn() } as any;
    controller = new DashboardB2cController(b2cService);
  });

  it("draws the payout from the caller's own tenant, taken from the verified token", async () => {
    const body = { msisdn: "254700000000", amountMinorUnits: 50000, remarks: "Refund" } as any;
    jest.spyOn(b2cService, "initiate").mockResolvedValueOnce({ transactionId: "payout-1" } as any);

    const result = await controller.initiate(body, admin);

    expect(b2cService.initiate).toHaveBeenCalledWith("tenant-1", body, { type: "user", id: "user-1" });
    expect(result).toEqual({ transactionId: "payout-1" });
  });

  it("attributes the payout to the user, so the audit log names who sent the money", async () => {
    jest.spyOn(b2cService, "initiate").mockResolvedValueOnce({} as any);

    await controller.initiate({} as any, admin);

    expect(b2cService.initiate).toHaveBeenCalledWith("tenant-1", {}, { type: "user", id: "user-1" });
  });

  it("refuses a caller whose account has no tenant yet", async () => {
    await expect(controller.initiate({} as any, { id: "user-1", tenantId: null } as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(b2cService.initiate).not.toHaveBeenCalled();
  });

  /**
   * Deliberately narrower than the STK dashboard route, which also allows
   * TENANT_STAFF. Collecting a payment is routine; sending money out drains the
   * tenant's own balance, and staff should not gain that purely because the two
   * routes look symmetrical.
   */
  it("is TENANT_ADMIN only — TENANT_STAFF must not be able to send money out", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, DashboardB2cController);

    expect(roles).toEqual(["TENANT_ADMIN"]);
    expect(roles).not.toContain("TENANT_STAFF");
  });

  // AccessTokenGuard must run first: RolesGuard and TenantAwareThrottlerGuard both
  // read state it sets (request.user / tenantId). Reordering silently breaks both.
  it("orders the guards so the auth guard populates request.user first", () => {
    const guards = Reflect.getMetadata("__guards__", DashboardB2cController);

    expect(guards).toEqual([AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard]);
  });
});

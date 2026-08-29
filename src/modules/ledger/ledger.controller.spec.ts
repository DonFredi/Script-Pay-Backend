import { ForbiddenException } from "@nestjs/common";
import { LedgerController } from "./ledger.controller";
import { LedgerService } from "./ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";

describe("LedgerController", () => {
  let controller: LedgerController;
  let prisma: PrismaService;
  let ledger: LedgerService;

  const admin = { id: "user-1", tenantId: "tenant-1", role: "TENANT_ADMIN" } as any;
  const superAdmin = { id: "user-2", tenantId: null, role: "SUPER_ADMIN" } as any;

  beforeEach(() => {
    prisma = { withTenantContext: jest.fn((_tenantId: string, fn: any) => fn({} as any)) } as any;
    ledger = { availableBalance: jest.fn() } as any;
    controller = new LedgerController(prisma, ledger);
  });

  it("reads the caller's own tenant balance, scoped by the verified token", async () => {
    jest.spyOn(ledger, "availableBalance").mockResolvedValueOnce(50000);

    const result = await controller.balance(admin);

    expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-1", expect.any(Function));
    expect(ledger.availableBalance).toHaveBeenCalledWith({}, "tenant-1");
    expect(result).toEqual({ tenantId: "tenant-1", availableMinorUnits: 50000 });
  });

  it("refuses a caller whose account has no tenant yet", async () => {
    await expect(controller.balance({ id: "user-1", tenantId: null, role: "TENANT_ADMIN" } as any)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(ledger.availableBalance).not.toHaveBeenCalled();
  });

  it("lets SUPER_ADMIN read a specific tenant's balance via ?tenantId=", async () => {
    jest.spyOn(ledger, "availableBalance").mockResolvedValueOnce(1000);

    const result = await controller.balance(superAdmin, "tenant-9");

    expect(prisma.withTenantContext).toHaveBeenCalledWith("tenant-9", expect.any(Function));
    expect(result).toEqual({ tenantId: "tenant-9", availableMinorUnits: 1000 });
  });

  it("refuses SUPER_ADMIN without an explicit ?tenantId= — no unscoped cross-tenant read", async () => {
    await expect(controller.balance(superAdmin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(ledger.availableBalance).not.toHaveBeenCalled();
  });

  // AccessTokenGuard must run first: RolesGuard and TenantAwareThrottlerGuard both
  // read state it sets (request.user / tenantId). Reordering silently breaks both.
  it("orders the guards so the auth guard populates request.user first", () => {
    const guards = Reflect.getMetadata("__guards__", LedgerController);

    expect(guards).toEqual([AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard]);
  });
});

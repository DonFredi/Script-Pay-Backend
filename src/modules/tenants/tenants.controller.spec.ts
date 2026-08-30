import { TenantsController } from "./tenants.controller";
import { TenantsService } from "./tenants.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

// Instantiated directly rather than via Test.createTestingModule — this controller
// carries @UseGuards() class metadata, and Nest's testing DI tries to resolve those
// guards' own dependencies even when the controller is only under test as a plain
// class. @Roles()/@UseGuards() enforcement itself is covered by roles.guard.spec.ts
// and access-token.guard.spec.ts; this file covers what TenantsController itself is
// responsible for — delegating to TenantsService with the right arguments.
describe("TenantsController", () => {
  let controller: TenantsController;
  let tenants: TenantsService;

  beforeEach(() => {
    tenants = {
      create: jest.fn(),
      onboardSelf: jest.fn(),
      listAll: jest.fn(),
      findOne: jest.fn(),
      setAppCredentials: jest.fn(),
      updateStatus: jest.fn(),
    } as any;
    controller = new TenantsController(tenants);
  });

  it("create() passes the DTO and acting user through to TenantsService.create", async () => {
    const dto = { name: "Acme", businessShortcode: "123456" } as any;
    const actor = user({ role: "SUPER_ADMIN", tenantId: null });
    jest.spyOn(tenants, "create").mockResolvedValueOnce({ id: "tenant-9" } as any);

    const result = await controller.create(dto, actor);

    expect(tenants.create).toHaveBeenCalledWith(dto, actor);
    expect(result).toEqual({ id: "tenant-9" });
  });

  it("onboardSelf() passes the DTO and acting user through to TenantsService.onboardSelf", async () => {
    const dto = { name: "Acme", businessShortcode: "123456" } as any;
    const actor = user({ tenantId: null });
    jest.spyOn(tenants, "onboardSelf").mockResolvedValueOnce({ id: "tenant-9" } as any);

    await controller.onboardSelf(dto, actor);

    expect(tenants.onboardSelf).toHaveBeenCalledWith(dto, actor);
  });

  it("listAll() delegates to TenantsService.listAll with no arguments", async () => {
    jest.spyOn(tenants, "listAll").mockResolvedValueOnce([{ id: "tenant-1" }] as any);

    const result = await controller.listAll();

    expect(tenants.listAll).toHaveBeenCalledWith();
    expect(result).toEqual([{ id: "tenant-1" }]);
  });

  it("findOne() passes the id and caller through to TenantsService.findOne unchanged", async () => {
    const actor = user();
    jest.spyOn(tenants, "findOne").mockResolvedValueOnce({ id: "tenant-1" } as any);

    await controller.findOne("tenant-1", actor);

    expect(tenants.findOne).toHaveBeenCalledWith("tenant-1", actor);
  });

  it("setAppCredentials() passes id, DTO, and actor through to TenantsService.setAppCredentials", async () => {
    const dto = { consumerKey: "k", consumerSecret: "s" } as any;
    const actor = user();

    await controller.setAppCredentials("tenant-1", dto, actor);

    expect(tenants.setAppCredentials).toHaveBeenCalledWith("tenant-1", dto, actor);
  });

  it("updateStatus() passes id, DTO, and actor through to TenantsService.updateStatus", async () => {
    const dto = { status: "suspended" } as any;
    const actor = user();

    await controller.updateStatus("tenant-1", dto, actor);

    expect(tenants.updateStatus).toHaveBeenCalledWith("tenant-1", dto, actor);
  });
});

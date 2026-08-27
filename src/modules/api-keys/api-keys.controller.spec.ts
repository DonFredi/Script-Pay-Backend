import { BadRequestException } from "@nestjs/common";
import { ApiKeysController } from "./api-keys.controller";
import { ApiKeysService } from "./api-keys.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

function user(overrides: Partial<AuthenticatedUser> = {}): AuthenticatedUser {
  return { id: "u-1", email: "a@b.com", role: "TENANT_ADMIN", tenantId: "tenant-1", ...overrides };
}

// Instantiated directly, same reasoning as transactions.controller.spec.ts — avoids
// Nest's testing DI trying to resolve this controller's @UseGuards() dependencies.
describe("ApiKeysController", () => {
  let controller: ApiKeysController;
  let apiKeys: ApiKeysService;

  beforeEach(() => {
    apiKeys = { create: jest.fn(), listForTenant: jest.fn(), revoke: jest.fn() } as any;
    controller = new ApiKeysController(apiKeys);
  });

  describe("create", () => {
    it("creates a key under the caller's own tenant", async () => {
      const dto = { scopes: ["PAYMENTS_INITIATE"], expiresAt: undefined } as any;
      jest.spyOn(apiKeys, "create").mockResolvedValueOnce({ id: "key-1" } as any);

      await controller.create(dto, user({ tenantId: "tenant-1" }));

      expect(apiKeys.create).toHaveBeenCalledWith("tenant-1", dto.scopes, "u-1", dto.expiresAt);
    });

    it("SUPER_ADMIN must specify ?tenantId= to issue a key on a tenant's behalf — no self-issuance", () => {
      const dto = { scopes: ["PAYMENTS_INITIATE"] } as any;

      // create()/list()/revoke() aren't `async` — the validation throw below is
      // synchronous, not a rejected promise, so this needs a sync matcher.
      expect(() => controller.create(dto, user({ role: "SUPER_ADMIN", tenantId: null }))).toThrow(
        BadRequestException,
      );
      expect(apiKeys.create).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN issues a key for the explicitly-requested tenant", async () => {
      const dto = { scopes: ["PAYMENTS_INITIATE"], expiresAt: undefined } as any;
      jest.spyOn(apiKeys, "create").mockResolvedValueOnce({ id: "key-1" } as any);

      await controller.create(dto, user({ role: "SUPER_ADMIN", tenantId: null }), "tenant-9");

      expect(apiKeys.create).toHaveBeenCalledWith("tenant-9", dto.scopes, "u-1", dto.expiresAt);
    });
  });

  describe("list", () => {
    it("a tenant admin always lists their own tenant's keys, ignoring any ?tenantId= they pass", async () => {
      jest.spyOn(apiKeys, "listForTenant").mockResolvedValueOnce([]);

      await controller.list(user({ tenantId: "tenant-1" }), "tenant-2-attempted-override");

      expect(apiKeys.listForTenant).toHaveBeenCalledWith("tenant-1");
    });

    it("SUPER_ADMIN must specify ?tenantId= — no default cross-tenant listing", () => {
      expect(() => controller.list(user({ role: "SUPER_ADMIN", tenantId: null }))).toThrow(BadRequestException);
      expect(apiKeys.listForTenant).not.toHaveBeenCalled();
    });

    it("SUPER_ADMIN lists the explicitly-requested tenant's keys", async () => {
      jest.spyOn(apiKeys, "listForTenant").mockResolvedValueOnce([]);

      await controller.list(user({ role: "SUPER_ADMIN", tenantId: null }), "tenant-9");

      expect(apiKeys.listForTenant).toHaveBeenCalledWith("tenant-9");
    });
  });

  describe("revoke", () => {
    it("a tenant admin always revokes within their own tenant, ignoring any ?tenantId= they pass", async () => {
      await controller.revoke("key-1", user({ tenantId: "tenant-1" }), "tenant-2-attempted-override");

      expect(apiKeys.revoke).toHaveBeenCalledWith("tenant-1", "key-1", "u-1");
    });

    it("SUPER_ADMIN must specify ?tenantId= to revoke — no ambient cross-tenant access", () => {
      expect(() => controller.revoke("key-1", user({ role: "SUPER_ADMIN", tenantId: null }))).toThrow(
        BadRequestException,
      );
      expect(apiKeys.revoke).not.toHaveBeenCalled();
    });
  });
});

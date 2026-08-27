import * as argon2 from "argon2";
import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { ApiKeyGuard } from "./api-key.guard";
import { PrismaPrivilegedService } from "../../modules/prisma/prisma-privileged.service";

function contextWithRequest(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe("ApiKeyGuard", () => {
  let guard: ApiKeyGuard;
  let prisma: PrismaPrivilegedService;
  let reflector: { getAllAndOverride: jest.Mock };
  let rawKey: string;
  let keyHash: string;

  beforeEach(async () => {
    process.env.API_KEY_HASH_PEPPER = "test-pepper";
    rawKey = "sp_realkeyvalue12345678";
    keyHash = await argon2.hash(rawKey + "test-pepper");

    prisma = {
      apiKey: { findMany: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    } as any;
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(undefined) };
    guard = new ApiKeyGuard(prisma, reflector as any);
  });

  it("rejects a request with no x-api-key header", async () => {
    const ctx = contextWithRequest({ headers: {} });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects an unknown key (no candidate matches the prefix)", async () => {
    jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([]);
    const ctx = contextWithRequest({ headers: { "x-api-key": rawKey } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a key whose hash doesn't verify, even if the prefix matches a candidate", async () => {
    jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([
      { id: "k-1", keyHash: await argon2.hash("a-different-key" + "test-pepper"), scopes: [], tenantId: "tenant-1" },
    ] as any);
    const ctx = contextWithRequest({ headers: { "x-api-key": rawKey } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects an expired key even if the hash verifies", async () => {
    jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([
      { id: "k-1", keyHash, scopes: [], tenantId: "tenant-1", expiresAt: new Date(Date.now() - 1000) },
    ] as any);
    const ctx = contextWithRequest({ headers: { "x-api-key": rawKey } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a valid key missing a required scope", async () => {
    jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([
      { id: "k-1", keyHash, scopes: ["REPORTING_READ"], tenantId: "tenant-1", expiresAt: null },
    ] as any);
    reflector.getAllAndOverride.mockReturnValueOnce(["PAYMENTS_INITIATE"]);
    const ctx = contextWithRequest({ headers: { "x-api-key": rawKey } });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("allows a valid, unexpired, correctly-scoped key and attaches tenantId to the request", async () => {
    jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([
      { id: "k-1", keyHash, scopes: ["PAYMENTS_INITIATE"], tenantId: "tenant-1", expiresAt: null },
    ] as any);
    reflector.getAllAndOverride.mockReturnValueOnce(["PAYMENTS_INITIATE"]);
    const req: any = { headers: { "x-api-key": rawKey } };
    const ctx = contextWithRequest(req);

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.tenantId).toBe("tenant-1");
    expect(req.apiKeyScopes).toEqual(["PAYMENTS_INITIATE"]);
    expect(req.apiKeyId).toBe("k-1");
  });

  it("never matches a revoked key — revoked keys aren't even fetched as candidates", async () => {
    const ctx = contextWithRequest({ headers: { "x-api-key": rawKey } });
    jest.spyOn(prisma.apiKey, "findMany").mockResolvedValueOnce([]);

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ revokedAt: null }) }),
    );
  });
});

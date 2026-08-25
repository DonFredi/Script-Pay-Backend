import { TokenService } from "./token.service";

describe("TokenService", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, JWT_ACCESS_SECRET: "a".repeat(32), JWT_ACCESS_TTL_SECONDS: "900" };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it("signs a token that verifies back to the same claims", async () => {
    const service = new TokenService();
    const claims = { sub: "user-1", email: "a@b.com", role: "TENANT_ADMIN" as const, tenantId: "tenant-1" };

    const token = await service.signAccessToken(claims);
    const verified = await service.verifyAccessToken(token);

    expect(verified).toEqual(claims);
  });

  it("preserves a null tenantId (pre-onboarding user) through sign and verify", async () => {
    const service = new TokenService();
    const claims = { sub: "user-1", email: "a@b.com", role: "TENANT_ADMIN" as const, tenantId: null };

    const token = await service.signAccessToken(claims);
    const verified = await service.verifyAccessToken(token);

    expect(verified.tenantId).toBeNull();
  });

  it("rejects a token signed with a different secret", async () => {
    const signer = new TokenService();
    const token = await signer.signAccessToken({
      sub: "user-1",
      email: "a@b.com",
      role: "TENANT_ADMIN",
      tenantId: "tenant-1",
    });

    process.env.JWT_ACCESS_SECRET = "b".repeat(32);
    const verifier = new TokenService();

    await expect(verifier.verifyAccessToken(token)).rejects.toThrow();
  });

  it("rejects a malformed token", async () => {
    const service = new TokenService();

    await expect(service.verifyAccessToken("not-a-real-jwt")).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    process.env.JWT_ACCESS_TTL_SECONDS = "-1";
    const service = new TokenService();
    const token = await service.signAccessToken({
      sub: "user-1",
      email: "a@b.com",
      role: "TENANT_ADMIN",
      tenantId: "tenant-1",
    });

    await expect(service.verifyAccessToken(token)).rejects.toThrow();
  });

  it("exposes the configured TTL", () => {
    process.env.JWT_ACCESS_TTL_SECONDS = "1200";
    const service = new TokenService();

    expect(service.accessTokenTtlSeconds).toBe(1200);
  });
});

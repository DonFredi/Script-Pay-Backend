import { ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { AccessTokenGuard } from "./access-token.guard";
import { TokenService } from "./token.service";

function contextWithHeaders(headers: Record<string, string>, request: Record<string, unknown> = {}) {
  const req: Record<string, unknown> = { headers, ...request };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

describe("AccessTokenGuard", () => {
  let guard: AccessTokenGuard;
  let tokens: TokenService;

  beforeEach(() => {
    tokens = { verifyAccessToken: jest.fn() } as any;
    guard = new AccessTokenGuard(tokens);
  });

  it("rejects a request with no Authorization header", async () => {
    const ctx = contextWithHeaders({});
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled();
  });

  it("rejects an Authorization header that isn't a Bearer token", async () => {
    const ctx = contextWithHeaders({ authorization: "Basic abc123" });
    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("rejects a token that fails verification, without leaking why", async () => {
    jest.spyOn(tokens, "verifyAccessToken").mockRejectedValueOnce(new Error("jwt expired"));
    const ctx = contextWithHeaders({ authorization: "Bearer bad.token.here" });

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedException);
  });

  it("attaches the verified claims to request.user and allows the request through", async () => {
    jest.spyOn(tokens, "verifyAccessToken").mockResolvedValueOnce({
      sub: "user-1",
      email: "a@b.com",
      role: "TENANT_ADMIN",
      tenantId: "tenant-1",
    });
    const req: Record<string, unknown> = { headers: { authorization: "Bearer good.token.here" } };
    const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;

    const result = await guard.canActivate(ctx);

    expect(result).toBe(true);
    expect(req.user).toEqual({
      id: "user-1",
      email: "a@b.com",
      role: "TENANT_ADMIN",
      tenantId: "tenant-1",
    });
  });
});

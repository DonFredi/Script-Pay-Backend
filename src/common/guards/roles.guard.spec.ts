import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { RolesGuard } from "./roles.guard";

function contextWithUser(user: unknown) {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe("RolesGuard", () => {
  let reflector: { getAllAndOverride: jest.Mock };
  let guard: RolesGuard;

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    guard = new RolesGuard(reflector as any);
  });

  it("allows the request through when the route has no @Roles() decorator", () => {
    reflector.getAllAndOverride.mockReturnValueOnce(undefined);

    expect(guard.canActivate(contextWithUser({ role: "TENANT_STAFF" }))).toBe(true);
  });

  it("allows the request through when @Roles() is an empty array", () => {
    reflector.getAllAndOverride.mockReturnValueOnce([]);

    expect(guard.canActivate(contextWithUser({ role: "TENANT_STAFF" }))).toBe(true);
  });

  it("forbids a user whose role isn't in the required list", () => {
    reflector.getAllAndOverride.mockReturnValueOnce(["SUPER_ADMIN"]);

    expect(() => guard.canActivate(contextWithUser({ role: "TENANT_ADMIN" }))).toThrow(ForbiddenException);
  });

  it("allows a user whose role is in the required list", () => {
    reflector.getAllAndOverride.mockReturnValueOnce(["SUPER_ADMIN", "TENANT_ADMIN"]);

    expect(guard.canActivate(contextWithUser({ role: "TENANT_ADMIN" }))).toBe(true);
  });

  it("forbids when request.user is missing entirely — this guard assumes AccessTokenGuard already ran", () => {
    reflector.getAllAndOverride.mockReturnValueOnce(["SUPER_ADMIN"]);

    expect(() => guard.canActivate(contextWithUser(undefined))).toThrow(ForbiddenException);
  });
});

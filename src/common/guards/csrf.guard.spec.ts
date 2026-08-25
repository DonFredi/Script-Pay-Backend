import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { CsrfGuard, generateCsrfToken } from "./csrf.guard";

function contextWithRequest(request: Record<string, unknown>) {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe("CsrfGuard", () => {
  let guard: CsrfGuard;

  beforeEach(() => {
    guard = new CsrfGuard();
  });

  it.each(["GET", "HEAD", "OPTIONS"])("allows safe method %s through with no token at all", (method) => {
    const ctx = contextWithRequest({ method, path: "/v1/transactions", cookies: {}, headers: {} });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "rejects state-changing method %s with no CSRF token present",
    (method) => {
      const ctx = contextWithRequest({ method, path: "/v1/tenants", cookies: {}, headers: {} });

      expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
    },
  );

  it("rejects when the cookie is present but the header is missing", () => {
    const ctx = contextWithRequest({
      method: "POST",
      path: "/v1/tenants",
      cookies: { "csrf-token": "abc123" },
      headers: {},
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("rejects when the cookie and header values don't match", () => {
    const ctx = contextWithRequest({
      method: "POST",
      path: "/v1/tenants",
      cookies: { "csrf-token": "abc123" },
      headers: { "x-csrf-token": "def456" },
    });

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("allows a state-changing request when the cookie and header match", () => {
    const ctx = contextWithRequest({
      method: "POST",
      path: "/v1/tenants",
      cookies: { "csrf-token": "abc123" },
      headers: { "x-csrf-token": "abc123" },
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("skips CSRF entirely for inbound Daraja webhook paths, regardless of token presence", () => {
    const ctx = contextWithRequest({
      method: "POST",
      path: "/v1/webhooks/daraja/stk-callback",
      cookies: {},
      headers: {},
    });

    expect(guard.canActivate(ctx)).toBe(true);
  });
});

describe("generateCsrfToken", () => {
  it("returns a 64-character hex string", () => {
    const token = generateCsrfToken();

    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different value on every call", () => {
    expect(generateCsrfToken()).not.toBe(generateCsrfToken());
  });
});

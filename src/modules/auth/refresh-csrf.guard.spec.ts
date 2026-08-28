import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { RefreshCsrfGuard } from "./refresh-csrf.guard";

function contextWithRequest(request: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function refreshRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/auth/refresh",
    cookies: {},
    headers: {},
    ...overrides,
  };
}

describe("RefreshCsrfGuard", () => {
  let guard: RefreshCsrfGuard;

  beforeEach(() => {
    guard = new RefreshCsrfGuard();
  });

  it("lets a logged-out visitor through, so rehydration still gets { accessToken: null } not a 403", () => {
    // The frontend's AuthProvider calls /auth/refresh blind on first load to find
    // out whether a session exists. With no session there is no csrf-token cookie
    // either, so plain CsrfGuard would 403 every first-time visitor.
    const ctx = contextWithRequest(refreshRequest());

    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("enforces CSRF as soon as a refresh_token cookie is present", () => {
    // This is the only case a forged refresh could actually do damage in — it
    // rotates the victim's token — so the exemption above must not reach it.
    const ctx = contextWithRequest(refreshRequest({ cookies: { refresh_token: "live-session" } }));

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("rejects a session request whose csrf cookie and header disagree", () => {
    const ctx = contextWithRequest(
      refreshRequest({
        cookies: { refresh_token: "live-session", "csrf-token": "aaa" },
        headers: { "x-csrf-token": "bbb" },
      }),
    );

    expect(() => guard.canActivate(ctx)).toThrow(ForbiddenException);
  });

  it("allows a session request presenting a matching csrf cookie and header", () => {
    const ctx = contextWithRequest(
      refreshRequest({
        cookies: { refresh_token: "live-session", "csrf-token": "match" },
        headers: { "x-csrf-token": "match" },
      }),
    );

    expect(guard.canActivate(ctx)).toBe(true);
  });
});

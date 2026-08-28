import "reflect-metadata";
import type { Response } from "express";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";
import { RefreshCsrfGuard } from "./refresh-csrf.guard";

type FakeResponse = Response & {
  cookies: Record<string, { value: string; options: Record<string, unknown> }>;
};

function fakeResponse(): FakeResponse {
  const cookies: Record<string, { value: string; options: Record<string, unknown> }> = {};
  return {
    cookie: jest.fn((name: string, value: string, options: Record<string, unknown>) => {
      cookies[name] = { value, options };
    }),
    cookies,
  } as unknown as FakeResponse;
}

const session = {
  user: { id: "u-1", email: "a@b.com" },
  accessToken: "access-token-value",
  refreshToken: "refresh-token-value",
};

describe("AuthController", () => {
  let controller: AuthController;
  let authService: AuthService;
  let refreshTokens: RefreshTokenService;

  beforeEach(() => {
    authService = {
      signup: jest.fn(),
      login: jest.fn(),
      refresh: jest.fn(),
      requestPasswordReset: jest.fn(),
      resetPassword: jest.fn(),
      verifyEmail: jest.fn(),
      resendVerification: jest.fn(),
    } as any;
    refreshTokens = { refreshTtlDays: 30 } as any;
    controller = new AuthController(authService, refreshTokens);
  });

  describe("login", () => {
    it("sets refresh_token, access_token, and csrf-token cookies with the right security attributes", async () => {
      jest.spyOn(authService, "login").mockResolvedValueOnce(session as any);
      const res = fakeResponse();

      await controller.login({ email: "a@b.com", password: "x" }, res);

      expect(res.cookies.refresh_token).toMatchObject({
        value: "refresh-token-value",
        options: expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
      });
      expect(res.cookies.access_token).toMatchObject({
        value: "access-token-value",
        options: expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
      });
      // The CSRF cookie MUST be readable by frontend JS (double-submit pattern) —
      // httpOnly: true here would silently break every mutating request.
      expect(res.cookies["csrf-token"].options).toMatchObject({ httpOnly: false, sameSite: "lax", path: "/" });
      expect(res.cookies["csrf-token"].value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("returns the user and access token, never the refresh token or csrf token, in the response body", async () => {
      jest.spyOn(authService, "login").mockResolvedValueOnce(session as any);
      const res = fakeResponse();

      const result = await controller.login({ email: "a@b.com", password: "x" }, res);

      expect(result).toEqual({ user: session.user, accessToken: session.accessToken });
      expect(JSON.stringify(result)).not.toContain("refresh-token-value");
    });
  });

  describe("signup", () => {
    it("sets the same three cookies as login", async () => {
      jest.spyOn(authService, "signup").mockResolvedValueOnce(session as any);
      const res = fakeResponse();

      await controller.signup(
        { username: "tester", email: "a@b.com", password: "x", confirmPassword: "x" },
        res,
      );

      expect(Object.keys(res.cookies).sort()).toEqual(["access_token", "csrf-token", "refresh_token"]);
    });
  });

  describe("refresh", () => {
    it("returns a null access token without calling authService when no refresh cookie is present", async () => {
      const res = fakeResponse();
      const req = { cookies: {} } as any;

      const result = await controller.refresh(req, res);

      expect(result).toEqual({ accessToken: null });
      expect(authService.refresh).not.toHaveBeenCalled();
      expect(res.cookie).not.toHaveBeenCalled();
    });

    it("rotates both cookies when a refresh token is presented", async () => {
      jest
        .spyOn(authService, "refresh")
        .mockResolvedValueOnce({ accessToken: "new-access", refreshToken: "new-refresh" });
      const res = fakeResponse();
      const req = { cookies: { refresh_token: "old-refresh" } } as any;

      const result = await controller.refresh(req, res);

      expect(result).toEqual({ accessToken: "new-access" });
      expect(res.cookies.refresh_token.value).toBe("new-refresh");
      expect(res.cookies.access_token.value).toBe("new-access");
      // A session persists indefinitely via silent refresh, so reissuing the
      // csrf-token here keeps it exactly as fresh as the session, closing a real
      // bug where any session older than the cookie's maxAge lost CSRF protection.
      expect(res.cookies["csrf-token"].value).toMatch(/^[0-9a-f]{64}$/);
    });

    it("is CSRF-protected, like every other state-changing route on this controller", () => {
      const guards: unknown[] = Reflect.getMetadata("__guards__", AuthController.prototype.refresh) ?? [];

      expect(guards).toContain(RefreshCsrfGuard);
    });

    it("gives csrf-token the same lifetime as refresh_token, so it can never expire first", async () => {
      jest
        .spyOn(authService, "refresh")
        .mockResolvedValueOnce({ accessToken: "new-access", refreshToken: "new-refresh" });
      const res = fakeResponse();
      const req = { cookies: { refresh_token: "old-refresh" } } as any;

      await controller.refresh(req, res);

      // Now that refresh itself requires a CSRF token, a csrf-token cookie that
      // expired before the refresh_token would be an unrecoverable lockout: the
      // only routes that issue a new one are login and refresh, and refresh would
      // reject the request. Tying the two lifetimes together removes that state.
      expect(res.cookies["csrf-token"].options.maxAge).toBe(res.cookies.refresh_token.options.maxAge);
    });
  });

  describe("password reset / verification flows", () => {
    it("forgot-password never reveals whether the account exists", async () => {
      jest.spyOn(authService, "requestPasswordReset").mockResolvedValueOnce(undefined);

      const result = await controller.forgotPassword({ email: "unknown@b.com" });

      expect(result.message).toMatch(/if an account exists/i);
    });
  });
});

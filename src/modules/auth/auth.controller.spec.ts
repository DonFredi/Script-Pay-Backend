import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { RefreshTokenService } from "./refresh-token.service";

function fakeResponse() {
  const cookies: Record<string, { value: string; options: Record<string, unknown> }> = {};
  return {
    cookie: jest.fn((name: string, value: string, options: Record<string, unknown>) => {
      cookies[name] = { value, options };
    }),
    cookies,
  } as any;
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

      await controller.login({ email: "a@b.com", password: "x" } as any, res);

      expect(res.cookies.refresh_token).toMatchObject({
        value: "refresh-token-value",
        options: expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/api/backend/auth/refresh" }),
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

      const result = await controller.login({ email: "a@b.com", password: "x" } as any, res);

      expect(result).toEqual({ user: session.user, accessToken: session.accessToken });
      expect(JSON.stringify(result)).not.toContain("refresh-token-value");
    });
  });

  describe("signup", () => {
    it("sets the same three cookies as login", async () => {
      jest.spyOn(authService, "signup").mockResolvedValueOnce(session as any);
      const res = fakeResponse();

      await controller.signup({ email: "a@b.com", password: "x" } as any, res);

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
      // refresh() never re-issues a CSRF cookie — the existing one (7-day life) is
      // still valid across a 15-minute access token refresh.
      expect(res.cookies["csrf-token"]).toBeUndefined();
    });
  });

  describe("password reset / verification flows", () => {
    it("forgot-password never reveals whether the account exists", async () => {
      jest.spyOn(authService, "requestPasswordReset").mockResolvedValueOnce(undefined);

      const result = await controller.forgotPassword({ email: "unknown@b.com" } as any);

      expect(result.message).toMatch(/if an account exists/i);
    });
  });
});

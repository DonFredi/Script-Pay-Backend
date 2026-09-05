import { ForbiddenException } from "@nestjs/common";
import { DarajaWebhookSecretGuard } from "./daraja-webhook-secret.guard";

const SECRET = "a".repeat(64);

function contextWith(query: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ query, path: "/v1/webhooks/daraja/stk-callback" }),
    }),
  } as never;
}

describe("DarajaWebhookSecretGuard", () => {
  let guard: DarajaWebhookSecretGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, DARAJA_WEBHOOK_SECRET: SECRET };
    guard = new DarajaWebhookSecretGuard();
    jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows a callback carrying the correct token", () => {
    expect(guard.canActivate(contextWith({ token: SECRET }))).toBe(true);
  });

  it("rejects a wrong token of the same length", () => {
    expect(() => guard.canActivate(contextWith({ token: "b".repeat(64) }))).toThrow(ForbiddenException);
  });

  it("rejects a callback with no token at all", () => {
    expect(() => guard.canActivate(contextWith({}))).toThrow(ForbiddenException);
  });

  // timingSafeEqual throws rather than returning false on a length mismatch, so a
  // guard that compared before checking lengths would 500 instead of 403.
  it("rejects a token of the wrong length without throwing anything but Forbidden", () => {
    expect(() => guard.canActivate(contextWith({ token: "short" }))).toThrow(ForbiddenException);
  });

  // Daraja doesn't sign its payloads, so this token is the only thing separating a
  // genuine Safaricom callback from a forged one. An unset secret must reject every
  // callback, never accept an empty token as a match.
  it("fails closed when DARAJA_WEBHOOK_SECRET is not configured", () => {
    delete process.env.DARAJA_WEBHOOK_SECRET;

    expect(() => guard.canActivate(contextWith({ token: "" }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextWith({}))).toThrow(ForbiddenException);
  });

  // Express parses a repeated ?token=&token= into an array; only a plain string is
  // ever a valid token.
  it("ignores a repeated token sent as an array rather than trusting it", () => {
    expect(() => guard.canActivate(contextWith({ token: [SECRET, SECRET] }))).toThrow(ForbiddenException);
  });
});

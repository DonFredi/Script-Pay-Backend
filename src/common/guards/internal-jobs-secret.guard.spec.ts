import { ForbiddenException } from "@nestjs/common";
import { InternalJobsSecretGuard } from "./internal-jobs-secret.guard";

const SECRET = "a".repeat(64);

function contextWith(headers: Record<string, unknown>) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers, path: "/internal/jobs/process-webhooks" }),
    }),
  } as never;
}

describe("InternalJobsSecretGuard", () => {
  let guard: InternalJobsSecretGuard;
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv, INTERNAL_JOBS_SECRET: SECRET };
    guard = new InternalJobsSecretGuard();
    jest.spyOn(guard["logger"], "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("allows a request carrying the correct secret", () => {
    expect(guard.canActivate(contextWith({ "x-internal-jobs-secret": SECRET }))).toBe(true);
  });

  it("rejects a wrong secret of the same length", () => {
    expect(() => guard.canActivate(contextWith({ "x-internal-jobs-secret": "b".repeat(64) }))).toThrow(
      ForbiddenException,
    );
  });

  it("rejects a missing header", () => {
    expect(() => guard.canActivate(contextWith({}))).toThrow(ForbiddenException);
  });

  // timingSafeEqual throws rather than returning false on a length mismatch, so a
  // guard that compared before checking lengths would 500 instead of 403.
  it("rejects a secret of the wrong length without throwing anything but Forbidden", () => {
    expect(() => guard.canActivate(contextWith({ "x-internal-jobs-secret": "short" }))).toThrow(ForbiddenException);
  });

  // The important one: an unconfigured secret must DISABLE the endpoints, never
  // open them. Comparing "" to "" would otherwise pass and expose money-moving jobs.
  it("fails closed when INTERNAL_JOBS_SECRET is not configured", () => {
    delete process.env.INTERNAL_JOBS_SECRET;

    expect(() => guard.canActivate(contextWith({ "x-internal-jobs-secret": "" }))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(contextWith({}))).toThrow(ForbiddenException);
  });

  it("ignores a repeated header sent as an array rather than trusting it", () => {
    expect(() => guard.canActivate(contextWith({ "x-internal-jobs-secret": [SECRET, SECRET] }))).toThrow(
      ForbiddenException,
    );
  });
});

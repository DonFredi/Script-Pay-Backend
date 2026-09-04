import { inProcessCronEnabled, jobScheduler } from "./job-scheduling";

/**
 * This switch decides whether the in-process crons run. Getting it wrong in the
 * permissive direction means crons AND an external scheduler both driving the same
 * pollers, which can credit a tenant twice for one payment; getting it wrong in the
 * restrictive direction means no job runs at all and nothing is ever settled. Both
 * failure modes are silent, so the defaulting is worth pinning down explicitly.
 */
describe("job scheduling switch", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  const withEnv = (value?: string) => {
    process.env = { ...originalEnv };
    if (value === undefined) delete process.env.JOB_SCHEDULER;
    else process.env.JOB_SCHEDULER = value;
  };

  it("defaults to in-process when JOB_SCHEDULER is unset", () => {
    withEnv(undefined);
    expect(jobScheduler()).toBe("in-process");
    expect(inProcessCronEnabled()).toBe(true);
  });

  it("disables the in-process crons only for the exact value \"external\"", () => {
    withEnv("external");
    expect(jobScheduler()).toBe("external");
    expect(inProcessCronEnabled()).toBe(false);
  });

  // Anything unrecognized keeps the crons running. That is the safe direction to
  // fail: a typo'd value leaves the app behaving as it always has, rather than
  // silently switching off every background job on a host that has no external
  // scheduler configured.
  it.each(["", "External", "EXTERNAL", "true", "http", "nonsense"])(
    "treats the unrecognized value %p as in-process",
    (value) => {
      withEnv(value);
      expect(inProcessCronEnabled()).toBe(true);
    },
  );
});

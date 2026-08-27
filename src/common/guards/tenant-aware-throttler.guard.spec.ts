import { TenantAwareThrottlerGuard } from "./tenant-aware-throttler.guard";
import type { AuthenticatedRequest } from "../types/authenticated-request";

describe("TenantAwareThrottlerGuard", () => {
  // getTracker is `protected` on the real class — call it through the instance
  // the same way NestJS's ThrottlerGuard base does internally.
  const track = (req: Partial<AuthenticatedRequest>): Promise<string> => {
    const guard = new TenantAwareThrottlerGuard({} as any, {} as any, {} as any);
    return (guard as unknown as { getTracker: (req: Partial<AuthenticatedRequest>) => Promise<string> }).getTracker(
      req,
    );
  };

  it("tracks by tenantId set directly on the request (ApiKeyGuard's shape)", async () => {
    const result = await track({ tenantId: "tenant-1", ips: [], ip: "1.2.3.4" });
    expect(result).toBe("tenant:tenant-1");
  });

  it("tracks by req.user.tenantId when set (AccessTokenGuard's shape)", async () => {
    const result = await track({ user: { tenantId: "tenant-2" } as any, ips: [], ip: "1.2.3.4" });
    expect(result).toBe("tenant:tenant-2");
  });

  it("prefers the directly-set tenantId over req.user.tenantId when both are present", async () => {
    const result = await track({ tenantId: "tenant-1", user: { tenantId: "tenant-2" } as any, ips: [], ip: "1.2.3.4" });
    expect(result).toBe("tenant:tenant-1");
  });

  it("falls back to the first entry in req.ips for a fully unauthenticated request", async () => {
    const result = await track({ ips: ["9.9.9.9", "10.10.10.10"], ip: "1.2.3.4" });
    expect(result).toBe("9.9.9.9");
  });

  it("falls back to req.ip when req.ips is empty", async () => {
    const result = await track({ ips: [], ip: "1.2.3.4" });
    expect(result).toBe("1.2.3.4");
  });

  it("never mixes two unauthenticated tenants sharing one NAT IP with a tenant-scoped caller", async () => {
    // The whole point of this guard: an IP-only tracker would throttle every
    // tenant behind the same corporate NAT as one caller. Confirm two different
    // tenantIds produce two different tracker keys even from the same IP.
    const a = await track({ tenantId: "tenant-a", ips: [], ip: "5.5.5.5" });
    const b = await track({ tenantId: "tenant-b", ips: [], ip: "5.5.5.5" });
    expect(a).not.toBe(b);
  });
});

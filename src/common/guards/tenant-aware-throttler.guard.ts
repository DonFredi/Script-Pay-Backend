import { Injectable } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";

/**
 * Default @nestjs/throttler tracks by IP alone. That's wrong for a multi-tenant API:
 * several tenants' automated integrations could share an egress IP (corporate NAT,
 * cloud provider NAT gateway), and IP-based limiting would throttle them as one.
 * Track by tenantId when we have it (set by ApiKeyGuard or AccessTokenGuard),
 * falling back to IP only for fully unauthenticated requests.
 */
@Injectable()
export class TenantAwareThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, any>): Promise<string> {
    const tenantId = req.tenantId ?? req.user?.tenantId;
    if (tenantId) return `tenant:${tenantId}`;
    return req.ips?.length ? req.ips[0] : req.ip;
  }
}

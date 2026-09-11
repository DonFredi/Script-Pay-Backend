import { TestAlertController } from "./test-alert.controller";
import { AlertsService } from "./alerts.service";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { ROLES_KEY } from "../../common/decorators/roles.decorator";

describe("TestAlertController", () => {
  let controller: TestAlertController;
  let alerts: AlertsService;
  let auditLog: AuditLogService;

  const admin = { id: "admin-1", email: "admin@example.com", tenantId: null, role: "SUPER_ADMIN" } as any;

  beforeEach(() => {
    alerts = { send: jest.fn() } as any;
    auditLog = { record: jest.fn() } as any;
    controller = new TestAlertController(alerts, auditLog);
  });

  it("sends a critical test alert by default and audit-logs who triggered it", async () => {
    const result = await controller.sendTestAlert({ severity: "critical" }, admin);

    expect(alerts.send).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", title: expect.stringContaining("Test alert") }),
    );
    expect(auditLog.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: "alerts.test_triggered", actorId: "admin-1" }),
    );
    expect(result.attempted).toBe(true);
  });

  it("warns that a warning-severity test never reaches email", async () => {
    const result = await controller.sendTestAlert({ severity: "warning" }, admin);

    expect(alerts.send).toHaveBeenCalledWith(expect.objectContaining({ severity: "warning" }));
    expect(result.note).toContain("check Slack only");
    expect(result.emailConfigured).toBe(false);
  });

  it("is SUPER_ADMIN only", () => {
    const roles = Reflect.getMetadata(ROLES_KEY, TestAlertController);
    expect(roles).toEqual(["SUPER_ADMIN"]);
  });

  it("orders the guards so the auth guard populates request.user first", () => {
    const guards = Reflect.getMetadata("__guards__", TestAlertController);
    expect(guards).toEqual([AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard]);
  });
});

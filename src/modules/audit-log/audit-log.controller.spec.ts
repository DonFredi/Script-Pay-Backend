import { AuditLogController } from "./audit-log.controller";
import { AuditLogService } from "./audit-log.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

describe("AuditLogController", () => {
  let controller: AuditLogController;
  let auditLog: AuditLogService;

  beforeEach(() => {
    auditLog = { list: jest.fn() } as any;
    controller = new AuditLogController(auditLog);
  });

  it("passes the filters and caller through to AuditLogService.list unchanged — tenant scoping is that service's responsibility", async () => {
    const actor = { id: "u-1", role: "SUPER_ADMIN", tenantId: null } as AuthenticatedUser;
    jest.spyOn(auditLog, "list").mockResolvedValueOnce([]);

    await controller.list(actor, "tenant-9", "TENANT_STATUS_CHANGED");

    expect(auditLog.list).toHaveBeenCalledWith({ tenantId: "tenant-9", action: "TENANT_STATUS_CHANGED" }, actor);
  });

  it("passes undefined filters through as-is when no query params are given", async () => {
    const actor = { id: "u-1", role: "TENANT_ADMIN", tenantId: "tenant-1" } as AuthenticatedUser;
    jest.spyOn(auditLog, "list").mockResolvedValueOnce([]);

    await controller.list(actor);

    expect(auditLog.list).toHaveBeenCalledWith({ tenantId: undefined, action: undefined }, actor);
  });
});

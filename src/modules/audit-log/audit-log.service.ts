import { ForbiddenException, Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { AuthenticatedUser } from "../../common/decorators/current-user.decorator";

export interface AuditEntry {
  tenantId?: string | null;
  actorType: "user" | "api_key" | "system";
  actorId?: string | null;
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Fire-and-forget by design: a failed audit write must never fail the business
   * operation it's recording. If this write fails, we log it loudly (it's a gap
   * worth knowing about) rather than throwing and rolling back a real transaction
   * just because the audit trail couldn't be written.
   */
  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.prisma.auditLog.create({
        data: {
          ...entry,
          metadata: entry.metadata as any,
        },
      });
    } catch (error) {
      this.logger.error("Failed to write audit log entry — this gap itself should be investigated", {
        entry,
        error,
      });
    }
  }

  /**
   * SUPER_ADMIN sees any tenant's log (or everything, if tenantId is omitted).
   * TENANT_ADMIN may only ever see their OWN tenant's log — enforced here, not
   * just at the controller's @Roles(), same "data-scoping is a service concern"
   * pattern as TenantsService.findOne/updateStatus. A TENANT_ADMIN passing a
   * different tenantId (or none at all) still only ever gets their own tenant's
   * entries; they can't broaden the query to see anyone else's or "everything".
   */
  async list(params: { tenantId?: string; action?: string; take?: number }, caller: AuthenticatedUser) {
    if (caller.role !== "SUPER_ADMIN") {
      if (params.tenantId && params.tenantId !== caller.tenantId) {
        throw new ForbiddenException("Cannot view another tenant's audit log");
      }
      params.tenantId = caller.tenantId ?? undefined;
    }

    return this.prisma.auditLog.findMany({
      where: {
        ...(params.tenantId ? { tenantId: params.tenantId } : {}),
        ...(params.action ? { action: params.action } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: params.take ?? 100,
    });
  }
}
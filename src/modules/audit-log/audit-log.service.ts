import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

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
          // Deliberate, narrow `any`: Record<string, unknown> isn't structurally
          // assignable to Prisma's JSON input type (name varies by Prisma
          // version/generator config), even though this data is always valid
          // JSON in practice — it's app-constructed audit metadata, never raw
          // unchecked user input.
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

  /** SUPER_ADMIN-only read path — enforced by the controller, not here. */
  async list(params: { tenantId?: string; take?: number }) {
    return this.prisma.auditLog.findMany({
      where: params.tenantId ? { tenantId: params.tenantId } : {},
      orderBy: { createdAt: "desc" },
      take: params.take ?? 100,
    });
  }
}

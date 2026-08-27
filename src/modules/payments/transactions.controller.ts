import { Controller, ForbiddenException, Get, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { PrismaService } from "../prisma/prisma.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import type { TransactionStatus } from "@prisma/client";

/**
 * Dashboard-facing reads only. Tenant staff/admins see only their own tenant's
 * transactions — SUPER_ADMIN may pass ?tenantId= to inspect a specific tenant,
 * but never sees a cross-tenant list by default (avoids an accidental full-table
 * scan becoming the norm for platform staff).
 */
@Controller("v1/transactions")
@UseGuards(AccessTokenGuard, RolesGuard, TenantAwareThrottlerGuard)
@ReadThrottle()
export class TransactionsController {
  constructor(
    private readonly prisma: PrismaService,
    // Used ONLY for the SUPER_ADMIN discovery read below — finding out which
    // tenant a transaction belongs to before any tenant context can be set. Under
    // FORCE ROW LEVEL SECURITY, the RLS-enforced `prisma` connection would return
    // null for that read regardless of whether the row exists, since no context is
    // set yet — this bypass is what makes the discovery phase actually work rather
    // than every SUPER_ADMIN lookup 404'ing on a transaction that's really there.
    private readonly prismaPrivileged: PrismaPrivilegedService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query("status") status?: TransactionStatus,
    @Query("tenantId") queryTenantId?: string,
  ) {
    // resolveTenantId always resolves to exactly one concrete tenant, even for
    // SUPER_ADMIN (it requires ?tenantId= explicitly, see below) — so this can
    // always run under that one tenant's RLS context, no unscoped "all tenants"
    // path exists here to conflict with it.
    const tenantId = this.resolveTenantId(user, queryTenantId);

    return this.prisma.withTenantContext(tenantId, (tx) =>
      tx.transaction.findMany({
        where: { tenantId, ...(status ? { status } : {}) },
        orderBy: { createdAt: "desc" },
        take: 100,
      }),
    );
  }

  /**
   * Backs the payment status page — polled by the frontend at a short interval
   * while a transaction is PENDING/PROCESSING, until it reaches a terminal state.
   * Scoped by tenant the same way list() is — a tenant can't poll another
   * tenant's transaction by guessing its UUID.
   */
  @Get(":id")
  async findOne(@Param("id") id: string, @CurrentUser() user: AuthenticatedUser) {
    if (user.role === "SUPER_ADMIN") {
      // Two-phase because SUPER_ADMIN genuinely has no target tenant to scope by
      // until after discovering which tenant this transaction belongs to. The
      // first read uses the privileged (BYPASSRLS) connection specifically for
      // that discovery — it's the one legitimate use of it here. Once the tenant
      // is known, re-fetch the same row under that tenant's RLS context on the
      // normal connection, so this path gets the same "neither layer alone is
      // enough" coverage as the TENANT_ADMIN path below.
      const initial = await this.prismaPrivileged.transaction.findUnique({ where: { id } });
      if (!initial) throw new NotFoundException("Transaction not found");

      const transaction = await this.prisma.withTenantContext(initial.tenantId, (tx) =>
        tx.transaction.findUnique({ where: { id } }),
      );
      if (!transaction) throw new NotFoundException("Transaction not found");
      return transaction;
    }

    if (!user.tenantId) throw new ForbiddenException("Account has no associated tenant");

    const transaction = await this.prisma.withTenantContext(user.tenantId, (tx) =>
      tx.transaction.findUnique({ where: { id } }),
    );
    if (!transaction) throw new NotFoundException("Transaction not found");

    // Redundant with the RLS context above once that's actually enforced (see
    // PrismaService.withTenantContext) — kept anyway, same "neither layer alone is
    // enough" reasoning the rest of this codebase already follows.
    if (transaction.tenantId !== user.tenantId) {
      throw new ForbiddenException("Cannot access another tenant's transaction");
    }

    return transaction;
  }

  private resolveTenantId(user: AuthenticatedUser, queryTenantId?: string): string {
    if (user.role === "SUPER_ADMIN") {
      if (!queryTenantId) throw new ForbiddenException("Platform staff must specify ?tenantId= explicitly");
      return queryTenantId;
    }
    if (!user.tenantId) throw new ForbiddenException("Account has no associated tenant");
    return user.tenantId;
  }
}

import { Controller, ForbiddenException, Get, NotFoundException, Param, Query, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ReadThrottle } from "../../common/throttle-tiers";
import { PrismaService } from "../prisma/prisma.service";
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
  constructor(private readonly prisma: PrismaService) {}

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
      // Genuinely doesn't have a target tenant to scope by until after this read —
      // that's the whole point of this branch. Not RLS-covered today: doing that
      // properly needs the dedicated BYPASSRLS connection path the RLS SQL file's
      // own header comments call for, which isn't provisioned yet. This read stays
      // app-layer only, same as before.
      const transaction = await this.prisma.transaction.findUnique({ where: { id } });
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

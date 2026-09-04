import { BadRequestException, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Sets the Postgres session variable that Row-Level Security policies check
   * (see the RLS notes at the bottom of schema.prisma). This is the SECOND
   * enforcement layer — application code should ALSO filter by tenantId explicitly
   * in every query. Neither layer alone is sufficient; RLS is the backstop for
   * the day someone forgets a WHERE clause.
   */
  async withTenantContext<T>(tenantId: string, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
    // Postgres SET does not accept bound parameters over the wire protocol, so we
    // interpolate — but only ever after validating this is a well-formed UUID.
    // Never pass unvalidated user input into this function.
    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidPattern.test(tenantId)) {
      // BadRequestException, not a bare Error. Several routes let a SUPER_ADMIN name
      // the tenant via ?tenantId= (transactions, ledger balance, reporting), so a
      // mistyped parameter reaches here as ordinary client input — and a bare Error
      // was collapsed by HttpExceptionFilter into an opaque "Internal server error"
      // plus a Sentry event, for what is a 400 with an obvious cause.
      throw new BadRequestException("tenantId must be a valid UUID");
    }

    return this.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.current_tenant_id = '${tenantId}'`);
      return fn(tx as PrismaClient);
    });
  }
}

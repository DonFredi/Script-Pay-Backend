import { Module } from "@nestjs/common";
import { LedgerController } from "./ledger.controller";
import { LedgerService } from "./ledger.service";
import { AuthModule } from "../auth/auth.module";

/**
 * LedgerService holds no Prisma dependency of its own — it operates on the caller's
 * transaction client (see its doc comment for why) — so this module is mostly the
 * export boundary. PaymentsModule imports it for the payout path; LedgerController
 * is the one place in this module that owns a PrismaService (global, so no explicit
 * import needed) to back a read-only balance display. AuthModule is imported for
 * AccessTokenGuard, which LedgerController's guard chain depends on.
 */
@Module({
  imports: [AuthModule],
  controllers: [LedgerController],
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}

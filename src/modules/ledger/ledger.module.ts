import { Module } from "@nestjs/common";
import { LedgerService } from "./ledger.service";

/**
 * LedgerService holds no Prisma dependency of its own — it operates on the caller's
 * transaction client (see its doc comment for why) — so this module is just the
 * export boundary. PaymentsModule imports it once the payout path lands in Phase 4.
 */
@Module({
  providers: [LedgerService],
  exports: [LedgerService],
})
export class LedgerModule {}

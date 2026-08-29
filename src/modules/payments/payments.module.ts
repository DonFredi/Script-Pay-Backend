import { Module } from "@nestjs/common";
import { StkPushController } from "./stk-push/stk-push.controller";
import { DashboardStkPushController } from "./stk-push/dashboard-stk-push.controller";
import { StkPushService } from "./stk-push/stk-push.service";
import { TransactionsController } from "./transactions.controller";
import { TransactionStateMachine } from "./transaction-state-machine";
import { B2cController } from "./b2c/b2c.controller";
import { DashboardB2cController } from "./b2c/dashboard-b2c.controller";
import { B2cService } from "./b2c/b2c.service";
import { DarajaModule } from "../../infrastructure/daraja/daraja.module";
import { AuthModule } from "../auth/auth.module";
import { TenantsModule } from "../tenants/tenants.module";
import { LedgerModule } from "../ledger/ledger.module";

@Module({
  // LedgerModule: B2cService needs the balance check that authorizes a payout, and
  // TransactionStateMachine needs the ledger-pair builders its payout transitions write.
  imports: [DarajaModule, AuthModule, TenantsModule, LedgerModule],
  controllers: [
    StkPushController,
    DashboardStkPushController,
    TransactionsController,
    B2cController,
    DashboardB2cController,
  ],
  providers: [StkPushService, TransactionStateMachine, B2cService],
  exports: [TransactionStateMachine], // callbacks module needs this to apply webhook results
})
export class PaymentsModule {}

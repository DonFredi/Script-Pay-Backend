import { Module } from "@nestjs/common";
import { StkPushController } from "./stk-push/stk-push.controller";
import { DashboardStkPushController } from "./stk-push/dashboard-stk-push.controller";
import { StkPushService } from "./stk-push/stk-push.service";
import { TransactionsController } from "./transactions.controller";
import { TransactionStateMachine } from "./transaction-state-machine";
import { DarajaModule } from "../../infrastructure/daraja/daraja.module";
import { AuthModule } from "../auth/auth.module";
import { TenantsModule } from "../tenants/tenants.module";

@Module({
  imports: [DarajaModule, AuthModule, TenantsModule],
  controllers: [StkPushController, DashboardStkPushController, TransactionsController],
  providers: [StkPushService, TransactionStateMachine],
  exports: [TransactionStateMachine], // callbacks module needs this to apply webhook results
})
export class PaymentsModule {}

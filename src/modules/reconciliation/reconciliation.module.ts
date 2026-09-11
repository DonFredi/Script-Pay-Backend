import { Module } from "@nestjs/common";
import { DriftDetectorService } from "./drift-detector.service";
import { PayoutResolutionService } from "./payout-resolution.service";
import { PayoutResolutionController } from "./payout-resolution.controller";
import { DarajaModule } from "../../infrastructure/daraja/daraja.module";
import { PaymentsModule } from "../payments/payments.module";
import { TenantsModule } from "../tenants/tenants.module";
import { AuthModule } from "../auth/auth.module";

@Module({
  // AuthModule: PayoutResolutionController needs AccessTokenGuard, which is only
  // exported there (see auth.module.ts) — AuditLogModule/AlertsModule are @Global()
  // so AuditLogService needs no explicit import here.
  imports: [DarajaModule, PaymentsModule, TenantsModule, AuthModule],
  controllers: [PayoutResolutionController],
  providers: [DriftDetectorService, PayoutResolutionService],
  // Exported for JobsModule's InternalJobsController — same reasoning as CallbacksModule.
  exports: [DriftDetectorService],
})
export class ReconciliationModule {}

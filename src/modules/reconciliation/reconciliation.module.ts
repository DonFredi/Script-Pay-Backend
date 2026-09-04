import { Module } from "@nestjs/common";
import { DriftDetectorService } from "./drift-detector.service";
import { DarajaModule } from "../../infrastructure/daraja/daraja.module";
import { PaymentsModule } from "../payments/payments.module";
import { TenantsModule } from "../tenants/tenants.module";

@Module({
  imports: [DarajaModule, PaymentsModule, TenantsModule],
  providers: [DriftDetectorService],
  // Exported for JobsModule's InternalJobsController — same reasoning as CallbacksModule.
  exports: [DriftDetectorService],
})
export class ReconciliationModule {}

import { Module } from "@nestjs/common";
import { InternalJobsController } from "./internal-jobs.controller";
import { CallbacksModule } from "../callbacks/callbacks.module";
import { ReconciliationModule } from "../reconciliation/reconciliation.module";

/**
 * Owns only the HTTP trigger surface. The jobs themselves stay where they belong —
 * webhook processing in CallbacksModule, reconciliation in ReconciliationModule —
 * and are imported here rather than reimplemented, so an externally-triggered run
 * and a cron-triggered run are the same code by construction.
 */
@Module({
  imports: [CallbacksModule, ReconciliationModule],
  controllers: [InternalJobsController],
})
export class JobsModule {}

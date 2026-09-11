import { Global, Module } from "@nestjs/common";
import { AlertsService } from "./alerts.service";
import { TestAlertController } from "./test-alert.controller";
import { AuthModule } from "../auth/auth.module";

// AuthModule: TestAlertController needs AccessTokenGuard, only exported there.
// AuditLogModule is @Global() so AuditLogService needs no explicit import.
@Global()
@Module({
  imports: [AuthModule],
  controllers: [TestAlertController],
  providers: [AlertsService],
  exports: [AlertsService],
})
export class AlertsModule {}

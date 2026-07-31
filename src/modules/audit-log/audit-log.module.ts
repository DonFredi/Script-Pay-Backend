import { Global, Module } from "@nestjs/common";
import { AuditLogController } from "./audit-log.controller";
import { AuditLogService } from "./audit-log.service";
import { AuthModule } from "../auth/auth.module";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [AuditLogController],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}

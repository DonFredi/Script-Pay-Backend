import { Module } from "@nestjs/common";
import { ReportingController } from "./reporting.controller";
import { ReportingService } from "./reporting.service";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [AuthModule],
  controllers: [ReportingController],
  providers: [ReportingService],
})
export class ReportingModule {}

import { Module } from "@nestjs/common";
import { TenantsController } from "./tenants.controller";
import { TenantsService } from "./tenants.service";
import { AuthModule } from "../auth/auth.module";
import { CredentialsEncryptionService } from "./credentials-encryption.service";
@Module({
  imports: [AuthModule],
  controllers: [TenantsController],
  providers: [TenantsService, CredentialsEncryptionService],
  exports: [TenantsService],
})
export class TenantsModule {}

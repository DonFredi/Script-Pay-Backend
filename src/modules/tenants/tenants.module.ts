import { Module } from "@nestjs/common";
import { TenantsController } from "./tenants.controller";
import { TenantWebhookConfigController } from "./tenant-webhook-config.controller";
import { TenantsService } from "./tenants.service";
import { AuthModule } from "../auth/auth.module";
import { ApiKeysModule } from "../api-keys/api-keys.module";
import { CredentialsEncryptionService } from "./credentials-encryption.service";
import { DarajaModule } from "../../infrastructure/daraja/daraja.module";
@Module({
  // ApiKeysModule for auto-provisioning a tenant's first key on activation —
  // ApiKeysModule only depends on AuthModule itself, so no import cycle. DarajaModule
  // for verifying credentials and auto-registering the C2B URL on submission.
  imports: [AuthModule, ApiKeysModule, DarajaModule],
  controllers: [TenantsController, TenantWebhookConfigController],
  providers: [TenantsService, CredentialsEncryptionService],
  // CredentialsEncryptionService is also exported for TenantWebhookPollerService
  // (CallbacksModule), which needs to decrypt Tenant.webhookSecretEncrypted at
  // delivery time — it's a generic AES helper with no tenant-specific state, safe
  // to reuse outside this module the same way TenantsService already is.
  exports: [TenantsService, CredentialsEncryptionService],
})
export class TenantsModule {}

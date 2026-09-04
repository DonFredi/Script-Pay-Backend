import { Module } from "@nestjs/common";
import { DarajaWebhookController } from "./daraja-webhook.controller";
import { WebhookIngestService } from "./webhook-ingest.service";
import { WebhookPollerService } from "./webhook-poller.service";
import { TenantWebhookPollerService } from "./tenant-webhook-poller.service";
import { PaymentsModule } from "../payments/payments.module";
import { TenantsModule } from "../tenants/tenants.module";

@Module({
  // TenantsModule for CredentialsEncryptionService — TenantWebhookPollerService
  // decrypts Tenant.webhookSecretEncrypted at delivery time.
  imports: [PaymentsModule, TenantsModule],
  controllers: [DarajaWebhookController],
  providers: [WebhookIngestService, WebhookPollerService, TenantWebhookPollerService],
  // Exported for JobsModule's InternalJobsController, which triggers these same
  // pollers over HTTP where nothing keeps a process alive to run their crons.
  exports: [WebhookPollerService, TenantWebhookPollerService],
})
export class CallbacksModule {}

import { Module } from "@nestjs/common";
import { DarajaWebhookController } from "./daraja-webhook.controller";
import { WebhookIngestService } from "./webhook-ingest.service";
import { WebhookPollerService } from "./webhook-poller.service";
import { PaymentsModule } from "../payments/payments.module";

@Module({
  imports: [PaymentsModule],
  controllers: [DarajaWebhookController],
  providers: [WebhookIngestService, WebhookPollerService],
})
export class CallbacksModule {}

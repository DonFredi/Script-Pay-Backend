import { Module } from "@nestjs/common";
import { DarajaWebhookController } from "./daraja-webhook.controller";
import { WebhookIngestService } from "./webhook-ingest.service";
import { WebhookPollerService } from "./webhook-poller.service";

@Module({
  controllers: [DarajaWebhookController],
  providers: [WebhookIngestService, WebhookPollerService],
})
export class CallbacksModule {}

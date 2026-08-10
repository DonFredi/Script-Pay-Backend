-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('pending', 'processing', 'processed', 'failed');

-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "status" "WebhookEventStatus" NOT NULL DEFAULT 'pending';

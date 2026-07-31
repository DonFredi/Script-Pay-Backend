-- AlterTable
ALTER TABLE "webhook_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateEnum
CREATE TYPE "TenantWebhookDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED');

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "webhookConfiguredAt" TIMESTAMP(3),
ADD COLUMN     "webhookSecretEncrypted" TEXT,
ADD COLUMN     "webhookUrl" TEXT;

-- CreateTable
CREATE TABLE "tenant_webhook_deliveries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "TenantWebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_webhook_deliveries_status_nextAttemptAt_idx" ON "tenant_webhook_deliveries"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "tenant_webhook_deliveries_tenantId_createdAt_idx" ON "tenant_webhook_deliveries"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "tenant_webhook_deliveries" ADD CONSTRAINT "tenant_webhook_deliveries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tenant_webhook_deliveries" ADD CONSTRAINT "tenant_webhook_deliveries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

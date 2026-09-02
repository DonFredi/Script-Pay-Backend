-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transactions_tenantId_idempotencyKey_key" ON "transactions"("tenantId", "idempotencyKey");


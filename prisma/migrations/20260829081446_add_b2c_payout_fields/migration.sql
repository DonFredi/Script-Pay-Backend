-- CreateEnum
CREATE TYPE "TransactionDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- AlterEnum
ALTER TYPE "TransactionChannel" ADD VALUE 'B2C';

-- AlterEnum
ALTER TYPE "ApiKeyScope" ADD VALUE 'PAYMENTS_DISBURSE';

-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "mpesaInitiatorName" TEXT,
ADD COLUMN     "mpesaPayoutConfiguredAt" TIMESTAMP(3),
ADD COLUMN     "mpesaSecurityCredentialEncrypted" TEXT;

-- AlterTable
ALTER TABLE "transactions" ADD COLUMN     "conversationId" TEXT,
ADD COLUMN     "direction" "TransactionDirection" NOT NULL DEFAULT 'INBOUND',
ADD COLUMN     "originatorConversationId" TEXT,
ADD COLUMN     "payoutOccasion" TEXT,
ADD COLUMN     "payoutRemarks" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "transactions_originatorConversationId_key" ON "transactions"("originatorConversationId");


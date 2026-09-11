-- CreateTable
CREATE TABLE "payout_status_queries" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "queryOriginatorConversationId" TEXT NOT NULL,
    "queryConversationId" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "payout_status_queries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_status_queries_queryOriginatorConversationId_key" ON "payout_status_queries"("queryOriginatorConversationId");

-- CreateIndex
CREATE INDEX "payout_status_queries_tenantId_requestedAt_idx" ON "payout_status_queries"("tenantId", "requestedAt");

-- CreateIndex
CREATE INDEX "payout_status_queries_transactionId_resolvedAt_idx" ON "payout_status_queries"("transactionId", "resolvedAt");

-- AddForeignKey
ALTER TABLE "payout_status_queries" ADD CONSTRAINT "payout_status_queries_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_status_queries" ADD CONSTRAINT "payout_status_queries_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateEnum
CREATE TYPE "ShortcodeType" AS ENUM ('TILL', 'PAYBILL', 'B2C');

-- AlterTable
-- Existing tenant rows are sandbox test data being retired alongside this change
-- (no tenant currently in the database is kept) — see manual-sql/003_tenant_shortcodes.sql's
-- header comment for the re-onboarding step this migration expects to follow it.
ALTER TABLE "tenants" DROP COLUMN "businessShortcode",
DROP COLUMN "mpesaPasskeyEncrypted",
DROP COLUMN "mpesaInitiatorName",
DROP COLUMN "mpesaSecurityCredentialEncrypted",
DROP COLUMN "mpesaPayoutConfiguredAt";

-- CreateTable
CREATE TABLE "tenant_shortcodes" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ShortcodeType" NOT NULL,
    "shortcode" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "mpesaPasskeyEncrypted" TEXT,
    "mpesaInitiatorName" TEXT,
    "mpesaSecurityCredentialEncrypted" TEXT,
    "mpesaPayoutConfiguredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_shortcodes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tenant_shortcodes_tenantId_idx" ON "tenant_shortcodes"("tenantId");

-- AddForeignKey
ALTER TABLE "tenant_shortcodes" ADD CONSTRAINT "tenant_shortcodes_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

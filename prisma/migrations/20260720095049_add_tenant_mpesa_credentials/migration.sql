-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "mpesaConsumerKey" TEXT,
ADD COLUMN     "mpesaConsumerSecretEncrypted" TEXT,
ADD COLUMN     "mpesaCredentialsConfiguredAt" TIMESTAMP(3),
ADD COLUMN     "mpesaPasskeyEncrypted" TEXT;

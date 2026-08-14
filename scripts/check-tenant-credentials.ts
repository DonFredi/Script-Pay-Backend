/**
 * check-tenant-credentials.ts
 *
 * Run this BEFORE deploying the CREDENTIALS_ENCRYPTION_KEY fix, to see which
 * tenants (if any) already have Daraja credentials saved under the old,
 * unvalidated key. Those tenants will need to re-submit their credentials
 * via POST /v1/tenants/:id/mpesa-credentials after the new key goes live,
 * because ciphertext encrypted under one AES-256-GCM key cannot be decrypted
 * with a different key — it will throw, not silently return wrong data.
 *
 * Usage:
 *   npx ts-node scripts/check-tenant-credentials.ts
 *
 * (Or compile and run with node if ts-node isn't installed — see fallback below.)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const tenants = await prisma.tenant.findMany({
    select: {
      id: true,
      name: true,
      businessShortcode: true,
      status: true,
      mpesaConsumerKey: true,
      mpesaConsumerSecretEncrypted: true,
      mpesaPasskeyEncrypted: true,
    },
  });

  const withCredentials = tenants.filter(
    (t) => t.mpesaConsumerKey && t.mpesaConsumerSecretEncrypted && t.mpesaPasskeyEncrypted,
  );
  const withoutCredentials = tenants.filter((t) => !t.mpesaConsumerKey);

  console.log(`\nTotal tenants: ${tenants.length}`);
  console.log(`Tenants WITH M-Pesa credentials already set: ${withCredentials.length}`);
  console.log(`Tenants WITHOUT M-Pesa credentials set: ${withoutCredentials.length}\n`);

  if (withCredentials.length === 0) {
    console.log("✅ No tenants have credentials saved yet — the key fix is safe to deploy with no follow-up needed.\n");
    return;
  }

  console.log("⚠️  These tenants have credentials saved and MUST re-submit them after the key fix deploys:\n");
  for (const t of withCredentials) {
    console.log(`  - ${t.name} (id: ${t.id}, shortcode: ${t.businessShortcode}, status: ${t.status})`);
  }
  console.log(
    "\nNext step: notify these tenants (or their assigned admin) to re-call\n" +
      "POST /v1/tenants/:id/mpesa-credentials with their real Daraja consumer\n" +
      "secret + passkey once CREDENTIALS_ENCRYPTION_KEY is set correctly in production.\n",
  );
}

main()
  .catch((err) => {
    console.error("Failed to check tenant credentials:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

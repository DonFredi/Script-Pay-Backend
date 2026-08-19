import { PrismaClient } from "@prisma/client";
import "dotenv/config";
/**
 * promote-to-admin.ts
 *
 * Promotes an existing user to SUPER_ADMIN. Deliberately a local script, not an
 * HTTP endpoint — a "become admin" API route is a permanent attack surface on a
 * live payments platform no matter how it's guarded. This runs directly against
 * DATABASE_URL from your own .env, so only someone with real database access can
 * ever use it.
 *
 * Usage:
 *   npx ts-node scripts/promote-to-admin.ts your-email@example.com
 *
 * The user must already exist (sign up through the app first) — this only changes
 * their role, it does not create an account.
 */


const prisma = new PrismaClient();

async function main() {
  const email = process.argv[2];

  if (!email) {
    console.error("Usage: npx ts-node scripts/promote-to-admin.ts <email>");
    process.exitCode = 1;
    return;
  }

  const user = await prisma.user.findUnique({ where: { email } });

  if (!user) {
    console.error(`No user found with email: ${email}\nSign up through the app first, then run this script.`);
    process.exitCode = 1;
    return;
  }

  if (user.role === "SUPER_ADMIN") {
    console.log(`${email} is already SUPER_ADMIN — nothing to do.`);
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { role: "SUPER_ADMIN" },
  });

  console.log(`✅ ${email} promoted to SUPER_ADMIN.`);
  console.log("They must log out and back in — their current access token (if any) still has the old role baked in.");
}

main()
  .catch((err) => {
    console.error("Failed to promote user:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
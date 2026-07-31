import { z } from "zod";

/**
 * An optional URL/string env var that's present-but-empty (e.g. `SENTRY_DSN=` left
 * blank when copying from .env.example) must be treated the same as "not set at
 * all." Zod's `.optional()` only accepts `undefined`, not `""` — without this,
 * an unfilled optional field in .env fails validation instead of being skipped.
 */
const optionalUrl = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());
const optionalString = (min = 1) => z.preprocess((v) => (v === "" ? undefined : v), z.string().min(min).optional());

/**
 * Every environment variable the app depends on is declared here.
 * The app refuses to boot if any REQUIRED value is missing or malformed —
 * this converts "undefined env var" from a 2am production bug into a startup failure in CI.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().url(),

  MPESA_CONSUMER_KEY: z.string().min(1),
  MPESA_CONSUMER_SECRET: z.string().min(1),
  MPESA_PASSKEY: z.string().min(1),
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CALLBACK_BASE_URL: z.string().url(),
  MPESA_SHORTCODE: z.string().min(1).default("174379"),
  API_KEY_HASH_PEPPER: z.string().min(32, "must be a long random secret, not a guessable phrase"),

  // Signs/verifies the backend's OWN access tokens. This exact value must also be
  // set in the frontend's middleware environment (Edge runtime) — it's a shared
  // secret between the two codebases, used with HS256. Generate with: openssl rand -hex 32
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(900), // 15 minutes
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),

  RESEND_API_KEY: z.string().min(1),
  EMAIL_FROM: z.string().email(),
  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().default(30),

  FRONTEND_ORIGIN: z.string().url(), // for CORS + building email links (verify-email, reset-password)

  REDIS_URL: z.string().url(), // backs the BullMQ queue used for webhook processing + reconciliation jobs

  SENTRY_DSN: optionalUrl(),
  SLACK_WEBHOOK_URL: optionalUrl(),
  CREDENTIALS_ENCRYPTION_KEY: z.string().min(1),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    // Fail loudly and specifically — never let a malformed/missing env var surface later as a mystery bug.
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Invalid environment configuration:\n  ${issues}`);
  }
  return result.data;
}

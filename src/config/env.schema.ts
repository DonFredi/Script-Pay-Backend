import { z } from "zod";

/**
 * An optional URL/string env var that's present-but-empty (e.g. `SENTRY_DSN=` left
 * blank when copying from .env.example) must be treated the same as "not set at
 * all." Zod's `.optional()` only accepts `undefined`, not `""` — without this,
 * an unfilled optional field in .env fails validation instead of being skipped.
 */
const optionalUrl = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional());
const optionalString = (min = 1) => z.preprocess((v) => (v === "" ? undefined : v), z.string().min(min).optional());
const optionalEmail = () => z.preprocess((v) => (v === "" ? undefined : v), z.string().email().optional());

/**
 * Comma-separated list of allowed CORS origins (e.g. local dev + deployed frontend
 * at once), returned as a string[] ready to pass straight into app.enableCors({ origin }).
 *
 * Deliberately REQUIRED, not optional: an unset origin previously fell through to
 * enableCors({ origin: undefined, credentials: true }), which the underlying `cors`
 * package resolves as Access-Control-Allow-Origin: * — and browsers reject wildcard
 * origin combined with credentials: true outright. That produced a bare, headerless
 * "CORS error" on every request with no indication in server logs of what was wrong.
 * Failing at boot instead of at request-time avoids re-debugging this from scratch.
 */
const originList = () =>
  z
    .string()
    .min(1, "required — comma-separated list, e.g. http://localhost:3000,https://app.scriptpay.com")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((urls) => urls.length > 0 && urls.every((u) => z.string().url().safeParse(u).success), {
      message:
        "FRONTEND_ORIGIN must be a comma-separated list of valid URLs (e.g. http://localhost:3000,https://app.scriptpay.com)",
    });

/**
 * Must decode to exactly 32 bytes — that's what AES-256-GCM (used by
 * CredentialsEncryptionService) requires as a key. Validating this at boot means a
 * misconfigured key fails loudly on startup instead of on the first tenant credential
 * decrypt/encrypt call in production. Generate a valid value with: openssl rand -base64 32
 */
const base64Key32Bytes = (envVarName: string) =>
  z.string().refine(
    (v) => {
      try {
        return Buffer.from(v, "base64").length === 32;
      } catch {
        return false;
      }
    },
    { message: `${envVarName} must be a base64-encoded 32-byte key — generate with: openssl rand -base64 32` },
  );

/**
 * Every environment variable the app depends on is declared here.
 * The app refuses to boot if any REQUIRED value is missing or malformed —
 * this converts "undefined env var" from a 2am production bug into a startup failure in CI.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().url(),

  // Second connection, for PrismaPrivilegedService — code paths that can't resolve
  // to a single tenant before querying (see that file's own doc comment). Optional:
  // unset falls back to DATABASE_URL, which is the correct behavior before the RLS
  // rollout's live cutover (both connections are the same owner-role connection,
  // which already bypasses RLS regardless — see 001_row_level_security.sql). Once
  // that cutover happens, this must point at the app_privileged (BYPASSRLS) role,
  // never at app_runtime.
  PRIVILEGED_DATABASE_URL: optionalUrl(),

  MPESA_CONSUMER_KEY: z.string().min(1),
  MPESA_CONSUMER_SECRET: z.string().min(1),
  MPESA_PASSKEY: z.string().min(1),
  MPESA_ENV: z.enum(["sandbox", "production"]).default("sandbox"),
  MPESA_CALLBACK_BASE_URL: z.string().url(),
  MPESA_SHORTCODE: z.string().min(1).default("174379"),
  API_KEY_HASH_PEPPER: z.string().min(32, "must be a long random secret, not a guessable phrase"),

  // Daraja never signs its webhook payloads, so this is the only thing that tells a
  // real Safaricom callback apart from anyone who discovers the URL and POSTs a
  // forged one. Embedded as a `?token=` query param in the CallBackURL/ResultURL/
  // QueueTimeOutURL/ConfirmationURL registered with Safaricom (see DarajaClient's
  // buildWebhookUrl) and checked by DarajaWebhookSecretGuard on every inbound
  // callback. IP-allowlisting Safaricom's published ranges at the load balancer is
  // still recommended as defense in depth — this guard doesn't replace that.
  // Generate with: openssl rand -hex 32
  DARAJA_WEBHOOK_SECRET: z.string().min(32),

  // Signs/verifies the backend's OWN access tokens. This exact value must also be
  // set in the frontend's middleware environment (Edge runtime) — it's a shared
  // secret between the two codebases, used with HS256. Generate with: openssl rand -hex 32
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().default(900), // 15 minutes
  JWT_REFRESH_TTL_DAYS: z.coerce.number().default(30),

  // Encrypts tenants' Daraja consumer secret + passkey at rest (AES-256-GCM). Previously
  // this was read directly from process.env in CredentialsEncryptionService, bypassing
  // this fail-fast validation entirely — an unset or malformed key would silently produce
  // an empty/wrong encryption key instead of refusing to boot. Never treat this as optional.
  CREDENTIALS_ENCRYPTION_KEY: base64Key32Bytes("CREDENTIALS_ENCRYPTION_KEY"),

  EMAIL_VERIFICATION_TTL_HOURS: z.coerce.number().default(24),
  PASSWORD_RESET_TTL_MINUTES: z.coerce.number().default(30),
  RESEND_API_KEY: optionalString(),
  EMAIL_FROM: optionalString(),

  // FRONTEND_ORIGIN: every origin the API should accept cross-origin requests from
  // (CORS allow-list — can be several, e.g. local dev + deployed frontend).
  FRONTEND_ORIGIN: originList(),

  // PUBLIC_APP_URL: the ONE canonical frontend URL used when building links inside
  // outbound emails (verification, password reset). Deliberately separate from
  // FRONTEND_ORIGIN — an email link should never resolve to localhost, even if
  // localhost is (correctly) in the CORS allow-list for local dev/testing.
  PUBLIC_APP_URL: z
    .string()
    .url("required — the canonical frontend URL used in email links, e.g. https://script-pay.vecel.app"),

  SENTRY_DSN: optionalUrl(),
  SLACK_WEBHOOK_URL: optionalUrl(),
  // Redundant channel for severity: "critical" alerts only — Slack being down or
  // misconfigured shouldn't mean a critical failure only ever reaches a log line.
  // Optional: with this unset, critical alerts still go to Slack (if configured)
  // and to logs, same as before.
  ALERTS_EMAIL_TO: optionalEmail(),

  // Product name used in outbound email subject lines (verification, password
  // reset). Optional — unset behaves exactly like today (defaults to "ScriptPay"
  // in EmailService itself, not here, since process.env isn't rewritten with
  // zod defaults after validateEnv() runs — see main.ts). Exists so a
  // differently-branded deployment of this codebase doesn't have to edit source
  // to change it, matching the frontend's branding externalization.
  PLATFORM_NAME: optionalString(),
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

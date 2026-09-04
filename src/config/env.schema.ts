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
 * Shared by the type check AND the url check on PRIVILEGED_DATABASE_URL below — see
 * the comment there for why attaching it to only one of them isn't enough.
 */
const PRIVILEGED_DATABASE_URL_HELP =
  "PRIVILEGED_DATABASE_URL must be set, and must point at the app_privileged (BYPASSRLS) role. " +
  "Never point it at app_runtime: that role is subject to FORCE ROW LEVEL SECURITY, so every " +
  "privileged query would return zero rows instead of erroring — no logins, no API keys, no " +
  "callback processing, and nothing in the logs. If RLS has not been applied to this database " +
  "at all, set it explicitly to the same value as DATABASE_URL.";

/**
 * Every environment variable the app depends on is declared here.
 * The app refuses to boot if any REQUIRED value is missing or malformed —
 * this converts "undefined env var" from a 2am production bug into a startup failure in CI.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(4000),

  DATABASE_URL: z.string().url(),

  // Read by prisma/schema.prisma's `directUrl` for migrations — Prisma Migrate needs
  // advisory locks, which Supabase's transaction-mode pooler (DATABASE_URL, port
  // 6543) doesn't support. Declared here so it's covered by the same fail-fast boot
  // check as everything else; it was previously the one connection string that
  // wasn't, so a missing or malformed value only surfaced as a migration failure
  // mid-deploy. Optional because the app itself never reads it — only the migrate
  // step does — so a running instance without it is fine, but a malformed one is not.
  DIRECT_URL: optionalUrl(),

  // Second connection, for PrismaPrivilegedService — code paths that cannot resolve
  // to a single tenant before querying (see that file's own doc comment).
  //
  // REQUIRED, and it was not always. This used to be optional and fall back to
  // DATABASE_URL, which was correct before the RLS cutover: both were the same
  // owner-role connection, and an owner bypasses RLS anyway, so the fallback was a
  // no-op. After the cutover it is the opposite of a no-op. DATABASE_URL now points
  // at app_runtime, which is subject to FORCE ROW LEVEL SECURITY — so a deployment
  // that simply forgot this one variable would get an "privileged" client that is
  // silently RLS-enforced, and every query it exists to serve would return ZERO ROWS
  // rather than raising: login-by-email finds no user ("Invalid email or password"
  // for everyone), ApiKeyGuard finds no key (every tenant integration 401s), and both
  // pollers find no work (Daraja callbacks never processed, money never credited).
  //
  // Nothing would error. The platform would just stop working, in a way that reads as
  // a data problem rather than a config one. Requiring it turns that into a refusal to
  // boot. A deployment that genuinely wants both connections identical — a local dev
  // database with no RLS applied — must now say so by setting this explicitly to the
  // same value, which is a deliberate choice rather than an omission.
  // The message is attached to BOTH the type check and the url check on purpose. A
  // message passed only to .url() never fires for the case it was written for: when
  // the variable is absent entirely, zod raises the base string type error first and
  // reports "expected string, received undefined", which tells an operator nothing
  // about what to set or why it matters.
  PRIVILEGED_DATABASE_URL: z
    .string({ error: PRIVILEGED_DATABASE_URL_HELP })
    .url(PRIVILEGED_DATABASE_URL_HELP),

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

  // Which mechanism fires the background pollers — see modules/jobs/job-scheduling.ts.
  // "in-process" (default) uses the @nestjs/schedule crons and needs a process that
  // stays alive. "external" silences those crons and expects a scheduler to POST the
  // /internal/jobs/* routes instead, which is what any host that suspends an idle
  // instance (a Render free instance sleeps after 15 minutes) requires.
  JOB_SCHEDULER: z.enum(["in-process", "external"]).default("in-process"),

  // Shared secret for those /internal/jobs/* routes, sent as the
  // x-internal-jobs-secret header. Optional here because a deployment on
  // JOB_SCHEDULER=in-process never calls them — but InternalJobsSecretGuard fails
  // CLOSED when it is unset, so leaving it blank disables the endpoints rather than
  // exposing them. Required in practice whenever JOB_SCHEDULER=external.
  // Generate with: openssl rand -hex 32
  INTERNAL_JOBS_SECRET: optionalString(32),

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

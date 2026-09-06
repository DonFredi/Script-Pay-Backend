import { Injectable, Logger } from "@nestjs/common";
import { Resend } from "resend";

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  private readonly resend?: Resend;
  private readonly from = process.env.EMAIL_FROM;
  // PUBLIC_APP_URL, not FRONTEND_ORIGIN — FRONTEND_ORIGIN is a comma-separated CORS
  // allow-list (can include localhost for dev) and is the wrong value to build a
  // user-facing email link from. See env.schema.ts for the distinction.
  private readonly appUrl = process.env.PUBLIC_APP_URL;
  private readonly platformName = process.env.PLATFORM_NAME || "ScriptPay";

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    } else {
      this.logger.warn("RESEND_API_KEY not configured. Email functionality is disabled.");
    }
  }

  /**
   * Every send goes through here, because Resend's SDK has two distinct failure
   * modes and the obvious code only handles one of them.
   *
   * `emails.send()` RESOLVES with `{ data: null, error }` when Resend rejects the
   * request at the API level — an unverified sending domain, a revoked key, a
   * rate limit, a malformed recipient — and only *throws* on a transport-level
   * failure. Every call site here used to `await` the promise inside a try/catch
   * and inspect neither the returned error nor the resolved value, so a refused
   * email produced no log line whatsoever: byte-for-byte indistinguishable from a
   * delivered one, in the logs and everywhere else. That is exactly how you ship
   * a system whose password resets silently reach nobody. See docs/decisions.md
   * entry 38.
   *
   * Deliberately still never throws. A notification that fails must not fail the
   * operation that triggered it — a signup whose verification mail bounces is
   * still a valid signup, and a tenant activation whose API-key email bounces has
   * still activated the tenant. The boolean is returned for callers that want to
   * react; ignoring it leaves today's behaviour unchanged apart from the log.
   */
  private async deliver(
    payload: { from: string; to: string; subject: string; html: string },
    description: string,
  ): Promise<boolean> {
    const client = this.resend;
    if (!client) return false;

    try {
      const { error } = await client.emails.send(payload);
      if (error) {
        // error.name/.message, not the whole object: Resend echoes the payload back
        // on some validation errors, and these payloads carry raw API keys and
        // webhook secrets that must never reach a log line.
        this.logger.error(`Failed to send ${description}: ${error.name} — ${error.message}`);
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(`Failed to send ${description}`, error as Error);
      return false;
    }
  }

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    if (!this.resend || !this.from || !this.appUrl) {
      this.logger.warn(`Verification email skipped because email is not configured. User: ${to}`);
      return;
    }

    const link = `${this.appUrl}/auth/verify-email?token=${encodeURIComponent(token)}`;

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `Verify your ${this.platformName} email`,
        html: `<p>Confirm your email address.</p>
               <p><a href="${link}">Verify my email</a></p>`,
      },
      `verification email to ${to}`,
    );
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    if (!this.resend || !this.from || !this.appUrl) {
      this.logger.warn(`Password reset email skipped because email is not configured. User: ${to}`);
      return;
    }

    const link = `${this.appUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `Reset your ${this.platformName} password`,
        html: `<p><a href="${link}">Reset my password</a></p>`,
      },
      `password reset email to ${to}`,
    );
  }

  /**
   * Sent once, at the moment a tenant's first API key is auto-provisioned
   * (TenantsService.updateStatus, on activation) — the raw key is never
   * retrievable again after this, same as if the tenant had generated it
   * themselves via POST /v1/api-keys. No appUrl needed, unlike the two above.
   */
  async sendApiKeyProvisionedEmail(to: string, rawKey: string): Promise<void> {
    if (!this.resend || !this.from) {
      this.logger.warn(`API key email skipped because email is not configured. To: ${to}`);
      return;
    }

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `Your ${this.platformName} API key`,
        html: `<p>Your account is now active. Here is your API key for integrating with ${this.platformName} —
               store it securely, it will not be shown again.</p>
               <p><code>${rawKey}</code></p>`,
      },
      `API key email to ${to}`,
    );
  }

  /**
   * Sent to a tenant's TENANT_ADMIN(s) on every manual key issuance —
   * POST /v1/api-keys, called either by the tenant's own admin (self-service
   * rotation) or by a SUPER_ADMIN on their behalf. Separate from
   * sendApiKeyProvisionedEmail above because this isn't necessarily the
   * tenant's first key or tied to activation; same one-time-reveal contract.
   */
  async sendApiKeyRotatedEmail(to: string, rawKey: string): Promise<void> {
    if (!this.resend || !this.from) {
      this.logger.warn(`API key email skipped because email is not configured. To: ${to}`);
      return;
    }

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `A new ${this.platformName} API key was issued`,
        html: `<p>A new API key was issued for your ${this.platformName} account. Store it securely —
               it will not be shown again. If you didn't request this, revoke it immediately from your
               dashboard and contact support.</p>
               <p><code>${rawKey}</code></p>`,
      },
      `API key rotation email to ${to}`,
    );
  }

  /**
   * Platform-staff (SUPER_ADMIN) visibility into tenant key issuance —
   * metadata only, deliberately never the raw key. Staff aren't the party
   * the key authenticates as; this is an audit push, not a delivery channel.
   */
  async sendApiKeyStaffNotice(
    to: string,
    tenantName: string,
    keyPrefix: string,
    scopes: string[],
    actorEmail: string,
  ): Promise<void> {
    if (!this.resend || !this.from) return;

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `API key issued for ${tenantName}`,
        html: `<p>A new API key (prefix <code>${keyPrefix}</code>, scopes: ${scopes.join(", ")}) was issued for
               tenant <strong>${tenantName}</strong> by ${actorEmail}. The raw key itself is not included here —
               it was delivered directly to the tenant's admin(s).</p>`,
      },
      `API key staff notice to ${to}`,
    );
  }

  /**
   * Sent to a tenant's TENANT_ADMIN(s) whenever their webhook signing secret
   * is (re)generated via POST /v1/tenants/webhook-config. That endpoint is
   * called with the tenant's own API key, not a dashboard session, so this
   * email is the only place a human on the tenant side sees the new secret.
   */
  async sendWebhookSecretRotatedEmail(to: string, webhookSecret: string, webhookUrl: string): Promise<void> {
    if (!this.resend || !this.from) {
      this.logger.warn(`Webhook secret email skipped because email is not configured. To: ${to}`);
      return;
    }

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `Your ${this.platformName} webhook secret was rotated`,
        html: `<p>Your webhook signing secret was regenerated for delivery to <code>${webhookUrl}</code>.
               Store it securely — it will not be shown again, and any signature verified against the old
               secret will start failing immediately.</p>
               <p><code>${webhookSecret}</code></p>`,
      },
      `webhook secret email to ${to}`,
    );
  }

  /** Platform-staff notice mirroring sendApiKeyStaffNotice — metadata only, never the secret. */
  async sendWebhookSecretStaffNotice(to: string, tenantName: string, webhookUrl: string): Promise<void> {
    if (!this.resend || !this.from) return;

    await this.deliver(
      {
        from: this.from,
        to,
        subject: `Webhook secret rotated for ${tenantName}`,
        html: `<p>The webhook signing secret for tenant <strong>${tenantName}</strong> was rotated, delivering to
               <code>${webhookUrl}</code>. The secret itself is not included here — it was delivered directly to
               the tenant's admin(s).</p>`,
      },
      `webhook secret staff notice to ${to}`,
    );
  }
}

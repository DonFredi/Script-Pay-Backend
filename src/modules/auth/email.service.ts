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

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    if (!this.resend || !this.from || !this.appUrl) {
      this.logger.warn(`Verification email skipped because email is not configured. User: ${to}`);
      return;
    }

    const link = `${this.appUrl}/auth/verify-email?token=${encodeURIComponent(token)}`;

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `Verify your ${this.platformName} email`,
        html: `<p>Confirm your email address.</p>
               <p><a href="${link}">Verify my email</a></p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${to}`, error as Error);
    }
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    if (!this.resend || !this.from || !this.appUrl) {
      this.logger.warn(`Password reset email skipped because email is not configured. User: ${to}`);
      return;
    }

    const link = `${this.appUrl}/auth/reset-password?token=${encodeURIComponent(token)}`;

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `Reset your ${this.platformName} password`,
        html: `<p><a href="${link}">Reset my password</a></p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}`, error as Error);
    }
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

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `Your ${this.platformName} API key`,
        html: `<p>Your account is now active. Here is your API key for integrating with ${this.platformName} —
               store it securely, it will not be shown again.</p>
               <p><code>${rawKey}</code></p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send API key email to ${to}`, error as Error);
    }
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

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `A new ${this.platformName} API key was issued`,
        html: `<p>A new API key was issued for your ${this.platformName} account. Store it securely —
               it will not be shown again. If you didn't request this, revoke it immediately from your
               dashboard and contact support.</p>
               <p><code>${rawKey}</code></p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send API key email to ${to}`, error as Error);
    }
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

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `API key issued for ${tenantName}`,
        html: `<p>A new API key (prefix <code>${keyPrefix}</code>, scopes: ${scopes.join(", ")}) was issued for
               tenant <strong>${tenantName}</strong> by ${actorEmail}. The raw key itself is not included here —
               it was delivered directly to the tenant's admin(s).</p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send API key staff notice to ${to}`, error as Error);
    }
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

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `Your ${this.platformName} webhook secret was rotated`,
        html: `<p>Your webhook signing secret was regenerated for delivery to <code>${webhookUrl}</code>.
               Store it securely — it will not be shown again, and any signature verified against the old
               secret will start failing immediately.</p>
               <p><code>${webhookSecret}</code></p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send webhook secret email to ${to}`, error as Error);
    }
  }

  /** Platform-staff notice mirroring sendApiKeyStaffNotice — metadata only, never the secret. */
  async sendWebhookSecretStaffNotice(to: string, tenantName: string, webhookUrl: string): Promise<void> {
    if (!this.resend || !this.from) return;

    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: `Webhook secret rotated for ${tenantName}`,
        html: `<p>The webhook signing secret for tenant <strong>${tenantName}</strong> was rotated, delivering to
               <code>${webhookUrl}</code>. The secret itself is not included here — it was delivered directly to
               the tenant's admin(s).</p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send webhook secret staff notice to ${to}`, error as Error);
    }
  }
}

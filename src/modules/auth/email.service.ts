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
}

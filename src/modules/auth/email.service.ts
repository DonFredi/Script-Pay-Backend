import { Injectable, Logger } from "@nestjs/common";
import { Resend } from "resend";

/**
 * Firebase previously handled verification/reset email delivery and token
 * generation entirely on its own. Now that this backend owns passwords directly,
 * it also owns sending these emails — Resend was already a dependency in the
 * frontend's original package.json (used for the contact form), reused here.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly resend = new Resend(process.env.RESEND_API_KEY);
  private readonly from = process.env.EMAIL_FROM as string;
  private readonly frontendOrigin = process.env.FRONTEND_ORIGIN as string;

  async sendVerificationEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendOrigin}/auth/verify-email?token=${encodeURIComponent(token)}`;
    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: "Verify your ScriptPay email",
        html: `<p>Confirm your email address to finish setting up your ScriptPay account.</p>
               <p><a href="${link}">Verify my email</a></p>
               <p>This link expires in ${process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 24} hours.</p>`,
      });
    } catch (error) {
      // Never let email delivery failure break signup itself — the person can
      // still use resend-verification later. Log loudly so it's visible in ops.
      this.logger.error(`Failed to send verification email to ${to}`, error as Error);
    }
  }

  async sendPasswordResetEmail(to: string, token: string): Promise<void> {
    const link = `${this.frontendOrigin}/auth/reset-password?token=${encodeURIComponent(token)}`;
    try {
      await this.resend.emails.send({
        from: this.from,
        to,
        subject: "Reset your ScriptPay password",
        html: `<p>Someone requested a password reset for this account. If this wasn't you, ignore this email.</p>
               <p><a href="${link}">Reset my password</a></p>
               <p>This link expires in ${process.env.PASSWORD_RESET_TTL_MINUTES ?? 30} minutes.</p>`,
      });
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${to}`, error as Error);
    }
  }
}

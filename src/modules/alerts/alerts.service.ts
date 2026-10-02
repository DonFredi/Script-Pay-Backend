import { Injectable, Logger } from "@nestjs/common";
import { Resend } from "resend";

export interface AlertPayload {
  title: string;
  /**
   * Inserted into the Slack message and the alert email's HTML UNESCAPED — keep it a
   * static string. Anything user-supplied (a tenant's name, say) belongs in `context`,
   * which is escaped for email and rendered inside a code block in Slack.
   */
  detail: string;
  /** "info" is for events a human should see but that aren't failures (e.g. a new sign-up). */
  severity: "info" | "warning" | "critical";
  /**
   * Also email ALERTS_EMAIL_TO. Critical alerts always do; set this for a non-critical
   * one that must still reach a person when Slack isn't configured.
   */
  email?: boolean;
  context?: Record<string, unknown>;
}

/**
 * Two independent channels, not a fallback chain: Slack is the primary
 * (fast, human-readable) and email is a redundant second channel for
 * severity: "critical" only — a Slack outage or a bad webhook URL shouldn't
 * mean a critical failure only ever reaches a log line nobody's watching.
 * Both are optional; with neither configured, alerts still log loudly.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;
  private readonly alertsEmailTo = process.env.ALERTS_EMAIL_TO;
  private readonly emailFrom = process.env.EMAIL_FROM;
  private readonly platformName = process.env.PLATFORM_NAME || "ScriptPesa";
  private readonly resend?: Resend;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
  }

  async send(alert: AlertPayload): Promise<void> {
    await this.sendSlack(alert);

    if ((alert.severity === "critical" || alert.email) && this.alertsEmailTo) {
      await this.sendEmail(
        this.alertsEmailTo,
        `[${this.platformName}] ${alert.title}`,
        `<p>${alert.detail}</p>${
          alert.context ? `<pre>${this.escapeHtml(JSON.stringify(alert.context, null, 2))}</pre>` : ""
        }`,
      );
    }
  }

  private async sendSlack(alert: AlertPayload): Promise<void> {
    if (!this.slackWebhookUrl) {
      this.logger.warn(`[ALERT - Slack not configured] ${alert.severity.toUpperCase()}: ${alert.title}`, alert);
      return;
    }

    try {
      const response = await fetch(this.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `${{ critical: "🔴", warning: "🟠", info: "🔵" }[alert.severity]} *${alert.title}*\n${alert.detail}${
            alert.context ? `\n\`\`\`${JSON.stringify(alert.context, null, 2)}\`\`\`` : ""
          }`,
        }),
      });

      if (!response.ok) {
        this.logger.error(`Slack webhook returned ${response.status} — alert not delivered`, alert);
      }
    } catch (error) {
      // An alert delivery failure must never throw and interrupt the business logic
      // that triggered it — log it and move on, don't let alerting become a new outage.
      this.logger.error("Failed to deliver Slack alert", error as Error);
    }
  }

  async sendEmail(to: string, subject: string, body: string): Promise<void> {
    if (!this.resend || !this.emailFrom) {
      this.logger.warn(`Alert email skipped because email is not configured. To: ${to}, Subject: ${subject}`);
      return;
    }

    try {
      // Resend RESOLVES with `{ data: null, error }` on an API-level rejection
      // (unverified sending domain, revoked key, rate limit) and only throws on a
      // transport failure — so awaiting without reading `error` silently discards
      // exactly the failures most likely to happen in production. This is the alert
      // channel of last resort; it going quietly missing is the worst case there is.
      // See EmailService.deliver and docs/decisions.md entry 38.
      const { error } = await this.resend.emails.send({ from: this.emailFrom, to, subject, html: body });
      if (error) {
        this.logger.error(`Failed to send alert email to ${to}: ${error.name} — ${error.message}`);
      }
    } catch (error) {
      // Same reasoning as sendSlack: never let alert delivery itself throw.
      this.logger.error(`Failed to send alert email to ${to}`, error as Error);
    }
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

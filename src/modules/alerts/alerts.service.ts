import { Injectable, Logger } from "@nestjs/common";
import { Resend } from "resend";

export interface AlertPayload {
  title: string;
  detail: string;
  severity: "warning" | "critical";
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
  private readonly resend?: Resend;

  constructor() {
    if (process.env.RESEND_API_KEY) {
      this.resend = new Resend(process.env.RESEND_API_KEY);
    }
  }

  async send(alert: AlertPayload): Promise<void> {
    await this.sendSlack(alert);

    if (alert.severity === "critical" && this.alertsEmailTo) {
      await this.sendEmail(
        this.alertsEmailTo,
        `[ScriptPay] ${alert.title}`,
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
          text: `${alert.severity === "critical" ? "🔴" : "🟠"} *${alert.title}*\n${alert.detail}${
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
      await this.resend.emails.send({ from: this.emailFrom, to, subject, html: body });
    } catch (error) {
      // Same reasoning as sendSlack: never let alert delivery itself throw.
      this.logger.error(`Failed to send alert email to ${to}`, error as Error);
    }
  }

  private escapeHtml(value: string): string {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
}

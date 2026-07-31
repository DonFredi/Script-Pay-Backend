import { Injectable, Logger } from "@nestjs/common";

export interface AlertPayload {
  title: string;
  detail: string;
  severity: "warning" | "critical";
  context?: Record<string, unknown>;
}

/**
 * Deliberately dependency-light: a Slack Incoming Webhook is just an HTTP POST,
 * so no SDK is needed. If SLACK_WEBHOOK_URL isn't configured, alerts are logged
 * instead of silently discarded — this makes "alerting isn't set up yet" visible
 * in logs during development rather than invisible.
 *
 * Email is stubbed as a clearly-marked extension point — wire in Resend (already
 * a frontend dependency; add it here too) or another provider when needed.
 */
@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);
  private readonly slackWebhookUrl = process.env.SLACK_WEBHOOK_URL;

  async send(alert: AlertPayload): Promise<void> {
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

  // Extension point — implement when an email provider (Resend, SES, etc.) is chosen.
  async sendEmail(_to: string, _subject: string, _body: string): Promise<void> {
    this.logger.warn("sendEmail() called but no email provider is configured yet — see AlertsService");
  }
}

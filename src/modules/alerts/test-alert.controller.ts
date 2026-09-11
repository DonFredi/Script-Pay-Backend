import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { AccessTokenGuard } from "../auth/access-token.guard";
import { CsrfGuard } from "../../common/guards/csrf.guard";
import { RolesGuard } from "../../common/guards/roles.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { Roles } from "../../common/decorators/roles.decorator";
import { CurrentUser, type AuthenticatedUser } from "../../common/decorators/current-user.decorator";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { StrictPaymentThrottle } from "../../common/throttle-tiers";
import { AuditLogService } from "../audit-log/audit-log.service";
import { AlertsService } from "./alerts.service";
import { testAlertSchema, type TestAlertDto } from "./test-alert.dto";

/**
 * Exists because "alerting is configured" was proven wrong twice already
 * without anyone finding out until real money sat stuck for days:
 * docs/decisions.md entry 37 (no channel configured at all — escalations
 * reached a log line) and entry 38 (Resend was silently swallowing every send
 * failure, so even a "configured" email channel wasn't actually delivering).
 * Both were only found by manually testing the send path, not by reading the
 * code or the env vars — this route makes that manual test something a
 * SUPER_ADMIN can run on demand instead of writing a one-off script.
 *
 * This does NOT prove the alert reached anyone — only that AlertsService.send
 * ran without throwing and logged whatever Slack/Resend actually returned.
 * The operator still has to go look at Slack/their inbox and confirm it
 * arrived; a 200 here means "attempted," not "delivered."
 */
@Controller("v1/alerts")
@UseGuards(AccessTokenGuard, CsrfGuard, RolesGuard, TenantAwareThrottlerGuard)
@Roles("SUPER_ADMIN")
export class TestAlertController {
  constructor(
    private readonly alerts: AlertsService,
    private readonly auditLog: AuditLogService,
  ) {}

  @Post("test")
  @StrictPaymentThrottle()
  async sendTestAlert(
    @Body(new ZodValidationPipe(testAlertSchema)) dto: TestAlertDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const triggeredAt = new Date().toISOString();

    await this.alerts.send({
      title: "Test alert — verifying delivery pipeline",
      detail:
        `Triggered manually by ${user.email} at ${triggeredAt} to confirm alerting actually reaches a human, ` +
        "not just a log line. If you're reading this in Slack or your inbox, delivery works for this channel.",
      severity: dto.severity,
      context: { triggeredBy: user.id, triggeredAt },
    });

    await this.auditLog.record({
      actorType: "user",
      actorId: user.id,
      action: "alerts.test_triggered",
      metadata: { severity: dto.severity, triggeredAt },
    });

    // Tells the caller what SHOULD have happened, based on which env vars are
    // set — not proof of delivery, since AlertsService swallows send failures
    // by design (an alert must never throw and become a new outage). Check
    // Slack/the inbox to confirm the "configured" channel actually delivered.
    return {
      attempted: true,
      slackConfigured: Boolean(process.env.SLACK_WEBHOOK_URL),
      emailConfigured:
        dto.severity === "critical" &&
        Boolean(process.env.ALERTS_EMAIL_TO && process.env.RESEND_API_KEY && process.env.EMAIL_FROM),
      note:
        dto.severity === "warning"
          ? "warning-severity alerts never reach email (docs/decisions.md entry 37) — check Slack only."
          : "check both Slack and the configured ALERTS_EMAIL_TO inbox.",
    };
  }
}

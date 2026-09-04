import { Controller, HttpCode, Logger, Post, UseGuards } from "@nestjs/common";
import { ThrottlerGuard } from "@nestjs/throttler";
import { InternalJobsSecretGuard } from "../../common/guards/internal-jobs-secret.guard";
import { ReadThrottle } from "../../common/throttle-tiers";
import { WebhookPollerService } from "../callbacks/webhook-poller.service";
import { TenantWebhookPollerService } from "../callbacks/tenant-webhook-poller.service";
import { DriftDetectorService } from "../reconciliation/drift-detector.service";

/**
 * HTTP triggers for the background jobs, for deployments where nothing keeps a
 * process alive to run `@nestjs/schedule` crons — a Render free instance that sleeps
 * after 15 minutes, or any serverless host. Set `JOB_SCHEDULER=external` to silence
 * the in-process crons and point an outside scheduler (cron-job.org, Supabase
 * pg_cron, UptimeRobot) at these paths.
 *
 * Each route calls exactly the method its cron wrapper calls, so the two trigger
 * mechanisms cannot drift apart. Every job is already idempotent and batch-bounded:
 * they select a capped set of due rows and re-select whatever they miss on the next
 * run, so an extra call costs a query and nothing else, and a missed call is picked
 * up by the following one.
 *
 * They are NOT safe to run concurrently with each other, which is why
 * JOB_SCHEDULER is an either/or rather than a hint — see job-scheduling.ts. Each
 * service's `isPolling` flag makes an overlapping call on the same instance a no-op,
 * but that flag is per-process and the pollers claim no rows.
 *
 * Every route is a POST, including the ones that mostly read: they change state, and
 * a GET would invite a crawler or a link preview to settle transactions.
 */
@Controller("internal/jobs")
@UseGuards(ThrottlerGuard, InternalJobsSecretGuard)
@ReadThrottle()
export class InternalJobsController {
  private readonly logger = new Logger(InternalJobsController.name);

  constructor(
    private readonly webhookPoller: WebhookPollerService,
    private readonly tenantWebhookPoller: TenantWebhookPollerService,
    private readonly driftDetector: DriftDetectorService,
  ) {}

  /**
   * Processes inbound Daraja callbacks sitting unprocessed in webhook_events.
   * The most time-sensitive of the three — until this runs, a customer's payment
   * has been received by Safaricom but the tenant has not been credited.
   * Suggested cadence: every minute.
   */
  @Post("process-webhooks")
  @HttpCode(200)
  async processWebhooks() {
    this.logger.log("Processing inbound webhook events (external trigger)");
    await this.webhookPoller.pollUnprocessedEvents();
    return { job: "process-webhooks", ok: true };
  }

  /**
   * Delivers outbound settlement notifications to tenants' own webhook URLs.
   * Carries its own backoff schedule, so calling this more often than the backoff
   * only re-checks what is actually due. Suggested cadence: every minute.
   */
  @Post("deliver-tenant-webhooks")
  @HttpCode(200)
  async deliverTenantWebhooks() {
    this.logger.log("Delivering pending tenant webhooks (external trigger)");
    await this.tenantWebhookPoller.pollPendingDeliveries();
    return { job: "deliver-tenant-webhooks", ok: true };
  }

  /**
   * The reconciliation safety net: re-queries collections stuck in PROCESSING and
   * escalates stuck payouts. Deliberately coarser than the other two — it exists to
   * catch what the callback path lost, and querying Safaricom about a transaction
   * that is merely a few minutes old just produces "still processing".
   * Suggested cadence: every 5 to 15 minutes.
   */
  @Post("detect-drift")
  @HttpCode(200)
  async detectDrift() {
    this.logger.log("Running drift detection (external trigger)");
    await this.driftDetector.runDetection();
    return { job: "detect-drift", ok: true };
  }
}

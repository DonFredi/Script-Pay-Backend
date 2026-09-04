/**
 * Which mechanism actually fires the background pollers.
 *
 * `in-process` (the default, and the behaviour this codebase has always had) runs
 * them from `@nestjs/schedule` crons inside the API process. That requires a
 * process that stays alive, which is true on an always-on host and false on any
 * platform that suspends an idle instance — a Render free instance sleeps after 15
 * minutes, a serverless function is frozen between requests. On those, the crons
 * simply never fire: inbound Daraja callbacks pile up unprocessed in webhook_events,
 * nothing is ever settled, and no ledger entry is written.
 *
 * `external` turns the in-process crons off and expects an outside scheduler to
 * drive the same work over HTTP (see InternalJobsController). The two must never be
 * active at once: the pollers claim no rows (see docs/decisions.md — poller row
 * claiming is still outstanding), so two concurrent runs of the same batch can both
 * transition a transaction and both write its ledger pair, crediting a tenant twice
 * for one payment. Each service's `isPolling` flag only guards overlap within a
 * single process, which is why this switch is a hard either/or rather than a hint.
 */
export type JobScheduler = "in-process" | "external";

export function jobScheduler(): JobScheduler {
  return process.env.JOB_SCHEDULER === "external" ? "external" : "in-process";
}

/**
 * Read by every `@Cron`-decorated wrapper. Returning false makes the wrapper a
 * no-op while leaving the underlying method callable — which is what lets
 * InternalJobsController invoke exactly the same code path the cron would have.
 */
export function inProcessCronEnabled(): boolean {
  return jobScheduler() === "in-process";
}

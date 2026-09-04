-- External job scheduler, using Supabase Cron (pg_cron) + pg_net.
--
-- WHY THIS EXISTS
-- The three background pollers normally run from @nestjs/schedule crons inside the
-- API process. That needs a process that stays alive. A Render free instance sleeps
-- after 15 minutes of inactivity, so those crons simply never fire: inbound Daraja
-- callbacks pile up unprocessed in webhook_events, nothing is settled, no ledger
-- entry is written, and payout reservations are never released.
--
-- Setting JOB_SCHEDULER=external on the API turns those in-process crons OFF and
-- exposes the same three jobs as POST routes under /internal/jobs/*. This file
-- drives them from Postgres instead, which keeps running regardless of what the web
-- instance is doing.
--
-- A second effect matters as much as the scheduling on a free instance: a request
-- every minute keeps the service awake. A sleeping instance takes ~50 seconds to
-- answer, which is longer than Safaricom waits for a webhook callback.
--
-- PREREQUISITES
--   1. The API is deployed and GET /health returns {"status":"ok"}.
--   2. JOB_SCHEDULER=external is set on the API. If it is not, the in-process crons
--      are ALSO running, and the two together can double-process a batch — the
--      pollers claim no rows, so two concurrent runs can both settle a transaction
--      and both write its ledger pair, crediting a tenant twice for one payment.
--      This is an either/or, never both.
--   3. INTERNAL_JOBS_SECRET is set on the API. The guard fails closed, so an unset
--      secret means every call below is rejected with 403 rather than running.
--
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor), as the project owner.

-- ---------------------------------------------------------------------------
-- 1. Extensions
-- ---------------------------------------------------------------------------
-- Both can also be enabled from Dashboard -> Database -> Extensions.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------
-- 2. Store the shared secret in Vault, not in the job definition
-- ---------------------------------------------------------------------------
-- cron.job.command is plain text in a table any database session can read. Putting
-- the secret straight into the SQL below would leave a credential that can trigger
-- money-moving jobs sitting in cleartext. Vault keeps it encrypted at rest and the
-- jobs look it up at run time.
--
-- Replace the placeholder with the SAME value as the API's INTERNAL_JOBS_SECRET.
-- Run this ONCE. If you need to rotate it later, see the bottom of this file.
select vault.create_secret(
  'REPLACE_WITH_INTERNAL_JOBS_SECRET',
  'internal_jobs_secret',
  'Shared secret for ScriptPay /internal/jobs/* triggers'
);

-- ---------------------------------------------------------------------------
-- 3. Schedule the three jobs
-- ---------------------------------------------------------------------------
-- Cadence reasoning:
--   process-webhooks        every minute. The most time-sensitive of the three —
--                           until it runs, a customer has paid and the tenant has
--                           not been credited.
--   deliver-tenant-webhooks every minute. Carries its own retry backoff, so running
--                           it often only re-checks what is genuinely due.
--   detect-drift            every 10 minutes. It is the safety net for callbacks
--                           that were lost, and asking Safaricom about a payment a
--                           few minutes old just returns "still processing".
--
-- timeout_milliseconds is deliberately just under the one-minute interval: a cold
-- free instance can take ~50s to answer the first request, and a timeout shorter
-- than that would abort exactly the call that was waking it up.
--
-- net.http_post is asynchronous — it queues the request and returns a request id
-- immediately. The job therefore succeeds even if the HTTP call later fails, which
-- is why section 5 checks the responses rather than only the cron run history.

select cron.schedule(
  'scriptpay-process-webhooks',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://script-pay-backend.onrender.com/internal/jobs/process-webhooks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-jobs-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_jobs_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

select cron.schedule(
  'scriptpay-deliver-tenant-webhooks',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://script-pay-backend.onrender.com/internal/jobs/deliver-tenant-webhooks',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-jobs-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_jobs_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

select cron.schedule(
  'scriptpay-detect-drift',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://script-pay-backend.onrender.com/internal/jobs/detect-drift',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-internal-jobs-secret',
      (select decrypted_secret from vault.decrypted_secrets where name = 'internal_jobs_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 55000
  );
  $$
);

-- ---------------------------------------------------------------------------
-- 4. Confirm the jobs exist
-- ---------------------------------------------------------------------------
-- select jobid, jobname, schedule, active from cron.job where jobname like 'scriptpay-%';

-- ---------------------------------------------------------------------------
-- 5. Confirm they are actually reaching the API
-- ---------------------------------------------------------------------------
-- cron.job_run_details only says whether the SQL ran, and queuing an async request
-- always succeeds. The HTTP result is what matters, so check both.
--
-- Did the SQL run?
-- select d.runid, j.jobname, d.status, d.start_time, d.return_message
-- from cron.job_run_details d
-- join cron.job j on j.jobid = d.jobid
-- where j.jobname like 'scriptpay-%'
-- order by d.start_time desc
-- limit 20;
--
-- Did the HTTP call succeed? Expect status_code 200 and {"job":"...","ok":true}.
-- A 403 means the secret here and INTERNAL_JOBS_SECRET on the API disagree.
-- select id, status_code, content, created
-- from net._http_response
-- order by created desc
-- limit 20;

-- ---------------------------------------------------------------------------
-- Rotating the secret
-- ---------------------------------------------------------------------------
-- Update the API's INTERNAL_JOBS_SECRET first, then run this. Between the two the
-- jobs will 403, which is harmless — the next run after both sides match picks up
-- whatever was missed, since every job re-selects the rows it did not process.
--
-- select vault.update_secret(
--   (select id from vault.secrets where name = 'internal_jobs_secret'),
--   'NEW_SECRET_VALUE'
-- );

-- ---------------------------------------------------------------------------
-- Removing the schedule
-- ---------------------------------------------------------------------------
-- Do this if you ever move the API to an always-on host and switch back to
-- JOB_SCHEDULER=in-process. Leaving both active is the double-processing hazard
-- described at the top.
--
-- select cron.unschedule('scriptpay-process-webhooks');
-- select cron.unschedule('scriptpay-deliver-tenant-webhooks');
-- select cron.unschedule('scriptpay-detect-drift');

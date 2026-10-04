# Operations Runbook — ScriptPay Backend

What to do when something goes wrong with live money. Each section is: **how
you find out → what to check → what to do**. Routes, alert titles and timings
here are verified against source as of 2026-10-04; if one disagrees with the
code, the code wins — fix this file.

Everything below that says "as SUPER_ADMIN" means a dashboard session for a
`SUPER_ADMIN` user (cookie auth + `X-CSRF-Token` on mutating requests). Base
URL: `https://script-pay-backend.onrender.com`.

> **Fill in before go-live** — anything marked `TODO(owner)` needs a real
> answer from the business, not from the code.

---

## 0. Contacts and ownership

| Role | Who | How to reach |
|---|---|---|
| On-call (first responder for alerts) | TODO(owner) | TODO |
| Can act as `SUPER_ADMIN` (resolve payouts, suspend tenants) | TODO(owner) | TODO |
| Safaricom account manager / Daraja support | TODO(owner) | TODO — also note the M-PESA org portal login holder |
| Render account owner | TODO(owner) | |
| Supabase project owner | TODO(owner) | |

Alerts go to **email only** (`ALERTS_EMAIL_TO`). Slack is deliberately not
used. Email delivery has failed silently twice before (decisions.md entries
37, 38) — after any change to email config, and at least monthly, fire
`POST /v1/alerts/test` as SUPER_ADMIN and confirm it actually lands.

---

## 1. Alert reference

Every alert the backend sends, and which section handles it:

| Alert title | Severity | Go to |
|---|---|---|
| Payout stuck in PROCESSING — manual reconciliation needed | **critical** | §2 |
| B2C payout timed out in Safaricom's queue — needs review | **critical** | §2 |
| B2C payout failed at Safaricom | warning | §4 |
| B2C payout initiation failed | warning | §4 / §6 |
| STK push failed at Safaricom | warning | usually customer-side (wrong PIN, cancelled) — no action unless it spikes |
| STK push initiation failed | warning | §6 |
| Webhook processing failed after all retries | **critical** | §7 |
| Tenant webhook delivery failed after all retries | **critical** | §8 |
| Ambiguous C2B shortcode match — payment not processed | **critical** | §9 |

---

## 2. A payout is stuck in `PROCESSING`

**How you find out:** "Payout stuck in PROCESSING" email (sent once per payout,
5 minutes after initiation with no result), or "B2C payout timed out in
Safaricom's queue". A merchant may also report that money is "held".

**Why it matters:** the payout's amount stays reserved in the tenant's ledger
— they cannot spend it — until it is resolved. The platform will **not**
resolve it on its own (decisions.md entries 18, 41): Stage 1 auto-recovery
queries Safaricom's Transaction Status API and records the answer, but does
not yet act on it. A queue timeout is **not** a failure — Safaricom may still
pay it.

**Check:**
1. `GET /v1/transactions/:id` — note `msisdn`, `amountMinorUnits`,
   `originatorConversationId`, `createdAt`.
2. Look the payout up in Safaricom's **M-PESA org portal** for that shortcode
   (by time/amount/recipient). This is the source of truth.
3. Optionally `GET /v1/audit-logs?action=daraja.b2c_timeout` (or the tenant's
   full log) for what Safaricom told us.

**Do (as SUPER_ADMIN):**
- Safaricom **paid it** →
  `PATCH /v1/reconciliation/payouts/:id/resolve`
  `{ "resolution": "SETTLED", "mpesaReceiptNumber": "<receipt from portal>", "reason": "<what you checked>" }`
- Safaricom **did not pay it** →
  `{ "resolution": "FAILED", "reason": "<what you checked>" }` — releases the reservation.
- **Can't tell yet** → leave it. Never mark `FAILED` on a guess: if Safaricom
  pays later, the tenant would have been refunded money that actually left.

Resolution goes through the same state machine as a real callback (ledger
entries, tenant webhook, audit log). Only `SUPER_ADMIN` can do it — not the
tenant, by design (decisions.md entry 40).

**Target:** same business day. TODO(owner): confirm SLA.

---

## 3. "Customer paid, merchant sees nothing" (collection)

**How you find out:** a merchant or their customer reports it.

**Check:**
1. Ask for the M-Pesa receipt (SMS code), phone number, amount and time.
2. `GET /v1/transactions?direction=INBOUND` (SUPER_ADMIN must add
   `?tenantId=`) and find it by phone/time.
3. By status:
   - `PROCESSING` and under ~20 min old → **wait**. DriftDetector queries
     Safaricom for any collection stuck past 15 minutes and fixes it itself
     (runs every 5–15 min via the external scheduler).
   - `PROCESSING` and much older → the drift job may not be running — see §7.
   - `FAILED` but the customer has a receipt → escalate: compare against the
     M-PESA statement and Safaricom support; record what you find in the
     ticket. There is no manual "mark collection settled" route.
   - **No transaction at all** and it was a direct Paybill/Till payment (not
     STK) → `GET /v1/audit-logs?action=daraja.c2b_unmatched`. If it's there,
     the shortcode isn't attached to an active tenant (§9). If it isn't,
     Safaricom never called us — check the shortcode's C2B URLs (§10).

---

## 4. A payout failed at Safaricom

**How you find out:** "B2C payout failed at Safaricom" / "B2C payout initiation
failed". The reason is stored on the transaction as `failureReason` and shown
to the merchant.

Funds are released automatically — nothing to resolve. Common reasons:

| Safaricom message | Meaning | Action |
|---|---|---|
| Credit Party customer type … can't be supported | Recipient can't receive this payout. **In sandbox: any real phone** — only `254708374149` works | Sandbox: use the test number. Production: recipient must be a registered M-Pesa customer |
| The initiator information is invalid / not allowed to initiate | Wrong initiator name, or initiator lacks the B2C role | Tenant fixes it in the M-PESA org portal, then `PATCH /v1/tenant-shortcodes/:id` |
| The security credential is locked | Too many wrong attempts | Regenerate the credential in the portal, update the shortcode |
| Insufficient funds / balance | The tenant's **Safaricom** B2C float is short (see §5) | Tenant tops up float at Safaricom |
| HTML page / 503 on auth | Safaricom-side outage or throttling | §6 |

---

## 5. Float and balances

Two different balances exist and they can disagree:

- **ScriptPay ledger** (`GET /v1/ledger/balance`) — computed from `LedgerEntry`.
  The payout balance check uses this.
- **Safaricom B2C float** — the real money in the tenant's B2C shortcode
  account at Safaricom. ScriptPay cannot see it.

A payout can pass the ledger check and still fail at Safaricom for low float.
That fails safely (§4), but it's a bad merchant experience.

**Routine:** TODO(owner) — decide how often (suggest daily, per active
tenant) to compare ledger balance against the M-PESA statement, who does it,
and how a tenant tops up float (bank → B2C account / utility → working
account transfer). Write the steps here once agreed.

---

## 6. Safaricom is down or rejecting requests

**Signs:** many "initiation failed" alerts at once; `failureReason` mentions
a 503, an HTML fault page, or "Failed to authenticate with Daraja".

**Do:**
1. Confirm it's not one tenant's credentials (one tenant failing vs all).
2. If it's all tenants: it's Safaricom. Nothing needs replaying — failed
   initiations are already `FAILED` and released. Tell affected merchants
   their customers should retry later. TODO(owner): message template.
3. Payouts that were already accepted may come back stuck → §2.

---

## 7. The backend or its background jobs are down

**Signs:** `GET /health` not returning `200 {"status":"ok"}`; collections
staying `PROCESSING`; no tenant webhooks; "Webhook processing failed after
all retries".

**Check in this order:**
1. **`GET /health`.** `503` = the app is up but Postgres is unreachable →
   check Supabase. No response → check Render.
2. **Render deploy history.** A failed deploy leaves the *previous* deploy
   live, so a broken env var can sit unnoticed (decisions.md entry 33). Look
   at the latest deploy's status and logs, and confirm env vars in the Render
   dashboard — especially `PRIVILEGED_DATABASE_URL`. A silent "every login
   fails / every API key rejected / nothing processed" is almost always this.
3. **Supabase Cron.** Production runs `JOB_SCHEDULER=external`: if the cron
   jobs calling `/internal/jobs/*` stop, Safaricom callbacks are **stored but
   never processed**. Confirm the jobs are enabled and recent runs succeeded
   (setup: `prisma/manual-sql/005_external_job_scheduler.sql`). You can
   trigger one by hand with
   `POST /internal/jobs/process-webhooks` + `x-internal-jobs-secret` header.
4. **Free-tier cold start.** Render's free tier suspends an idle instance;
   the first request after idle is slow and a Safaricom callback can be
   lost (decisions.md entry 36). Lost STK callbacks are recovered by the drift
   job; lost payout callbacks end up in §2.

Callbacks Safaricom sent while the backend was fully down are not re-sent —
the drift job (collections) and §2 (payouts) are how they get recovered.

---

## 8. A merchant isn't receiving our webhooks

**Signs:** "Tenant webhook delivery failed after all retries".

The transaction itself is fine — only the notification to the merchant's
server failed. Check the URL they configured (`POST /v1/tenants/webhook-config`),
tell them their endpoint was failing, and point them at
`GET /v1/transactions/:id` to sync status. TODO(owner): decide whether we
offer manual re-delivery.

---

## 9. Ambiguous or unmatched C2B payment

- **"Ambiguous C2B shortcode match" (critical):** a real customer payment
  matched more than one active tenant and was **not credited to anyone**.
  Should be impossible — it means database uniqueness triggers were bypassed.
  Find the duplicate shortcode rows, decide which tenant really owns the
  shortcode with Safaricom's records, remove the wrong one, and escalate the
  missed payment to an engineer.
- **`daraja.c2b_unmatched` in the audit log:** the shortcode isn't on any
  active tenant (tenant still `pending_kyc`, suspended, or shortcode not
  registered). The money is at Safaricom in that shortcode's account; fix the
  tenant setup. Past unmatched payments are not auto-credited.

---

## 10. Changing the backend's domain or callback URL

STK and B2C callback URLs follow `MPESA_CALLBACK_BASE_URL` automatically. C2B
URLs are stored at Safaricom and do **not**: after changing the domain, call
`POST /v1/tenant-shortcodes/:id/register-c2b-url` for every Paybill/Till
shortcode, or direct Paybill/Till payments keep going to the old host.

---

## 11. Security incidents

| Incident | Do |
|---|---|
| Merchant API key leaked | `DELETE /v1/api-keys/:id`, then `POST /v1/api-keys` with the same scopes (SUPER_ADMIN adds `?tenantId=`). The raw key is shown once. |
| Merchant's Daraja credentials leaked | Merchant rotates them in the Daraja portal / M-PESA org portal; then `POST /v1/tenants/:id/app-credentials` (consumer key/secret) and/or `PATCH /v1/tenant-shortcodes/:id` (passkey, initiator, security credential). |
| Tenant behaving suspiciously | `PATCH /v1/tenants/:id/status` `{ "status": "suspended" }` blocks money moving in both directions immediately. `removed` is the permanent version (SUPER_ADMIN only). |
| A user's session was stolen | Automatic: reusing an already-rotated refresh token revokes **all** that user's sessions. Have the user reset their password. |
| Platform secret leaked (`JWT_ACCESS_SECRET`, `DARAJA_WEBHOOK_SECRET`, `INTERNAL_JOBS_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`) | Escalate to an engineer — each has its own consequences. `JWT_ACCESS_SECRET` must change in the frontend too. Changing `DARAJA_WEBHOOK_SECRET` breaks callbacks for in-flight transactions and needs §10. `CREDENTIALS_ENCRYPTION_KEY` **cannot** just be swapped: every stored tenant credential would need re-encrypting. |

Every one of these actions is audit-logged; note the incident in the ticket
with the time and what you changed.

---

## 12. Onboarding a merchant

1. Merchant signs up and onboards (`POST /v1/tenants/onboard`) → staff get a
   sign-up alert email. Tenant starts as `pending_kyc` and cannot move money.
2. **KYC** — TODO(owner): what documents, who approves.
3. Merchant adds Daraja app credentials (`POST /v1/tenants/:id/app-credentials`)
   and shortcodes (`POST /v1/tenant-shortcodes`). Both are verified against
   Safaricom before saving, so typos fail immediately.
4. SUPER_ADMIN sets `PATCH /v1/tenants/:id/status` `{ "status": "active" }` —
   this auto-issues their first API key (collections only) and emails it to
   their admins.
5. **Payouts are opt-in:** issue a separate key with `PAYMENTS_DISBURSE`.
6. **Test with real money:** one small STK collection (e.g. KES 10) and one
   small payout to a phone you control. Confirm both settle and the merchant
   gets their webhook. Don't go live without this.

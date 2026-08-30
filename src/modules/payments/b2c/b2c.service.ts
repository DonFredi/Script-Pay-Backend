import { Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { DarajaClient } from "../../../infrastructure/daraja/daraja.client";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { AlertsService } from "../../alerts/alerts.service";
import { TenantsService } from "../../tenants/tenants.service";
import { LedgerService } from "../../ledger/ledger.service";
import { maskMsisdn } from "../../../common/utils/mask-msisdn";
import type { InitiateB2cDto } from "./initiate-b2c.dto";

/**
 * Who asked for this payout. Both entry points share one service, but they are
 * genuinely different actors and the audit trail has to say which: a tenant's own
 * backend holding a PAYMENTS_DISBURSE key, or a logged-in TENANT_ADMIN clicking a
 * button. Collapsing them to "system" — as an earlier version of this did for the
 * dashboard case — loses exactly the attribution an audit log exists to provide.
 */
export interface PayoutActor {
  type: "api_key" | "user";
  id: string | null;
}

@Injectable()
export class B2cService {
  private readonly logger = new Logger(B2cService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly daraja: DarajaClient,
    private readonly auditLog: AuditLogService,
    private readonly alerts: AlertsService,
    private readonly tenantsService: TenantsService,
    private readonly ledger: LedgerService,
  ) {}

  /**
   * Outbound counterpart to StkPushService.initiate, and it follows that method's
   * structure deliberately: the Daraja HTTP call happens OUTSIDE any open Postgres
   * transaction, because holding one across a multi-second external call is its own
   * bug (pool pressure, held locks) regardless of what the call is doing.
   *
   * The reservation is the one part that must be transactional, and it is — a single
   * withTenantContext block that locks, checks the balance, creates the row and
   * writes the debit together. Everything after it is best-effort bookkeeping around
   * an in-flight payout.
   *
   * The reservation lives here rather than in TransactionStateMachine on purpose:
   * initiation is a tenant-scoped request with a known tenantId, so it belongs on the
   * RLS-enforced connection under withTenantContext. TransactionStateMachine runs on
   * PrismaPrivilegedService precisely because its callers (the pollers) have no single
   * tenant — routing a request path through it would quietly widen that exception.
   * StkPushService sets the same precedent: it creates its own transaction row and
   * only the CALLBACK-driven transitions go through the state machine.
   */
  async initiate(tenantId: string, dto: InitiateB2cDto, actor: PayoutActor) {
    // Idempotency: a caller that retries (network timeout, double-click before the
    // throttle catches it) with the same key gets back the payout already created
    // for it instead of a second real disbursement. Checked up front as a fast path;
    // the create below is still the actual source of truth (see the P2002 catch),
    // since two concurrent requests with the same key can both pass this check.
    if (dto.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(tenantId, dto.idempotencyKey);
      if (existing) {
        this.logger.log(
          `Idempotent replay for payout key=${dto.idempotencyKey} -> existing transaction ${existing.id}`,
        );
        return { transactionId: existing.id, status: existing.status };
      }
    }

    // Generated before anything else so it exists even if every step below fails.
    // This is the id the result callback will correlate on — unlike STK Push, where
    // the correlation key only arrives in Daraja's response and a timed-out request
    // therefore leaves an unmatchable row.
    const originatorConversationId = randomUUID();

    // Step 1: reserve. Lock, check, create and debit in ONE transaction — a balance
    // verified in a different transaction than the debit it authorizes verifies
    // nothing, since a concurrent payout can commit in between.
    let transaction;
    try {
      transaction = await this.prisma.withTenantContext(tenantId, async (tx) => {
        const availableBefore = await this.ledger.assertSufficientBalance(tx, tenantId, dto.amountMinorUnits);

        const created = await tx.transaction.create({
          data: {
            tenantId,
            channel: "B2C",
            direction: "OUTBOUND",
            status: "PENDING",
            amountMinorUnits: dto.amountMinorUnits,
            msisdn: dto.msisdn,
            originatorConversationId,
            idempotencyKey: dto.idempotencyKey,
            payoutRemarks: dto.remarks,
            payoutOccasion: dto.occasion,
            metadata: dto.metadata as any,
          },
        });

        await tx.ledgerEntry.createMany({
          data: this.ledger.reservationEntries({
            tenantId,
            transactionId: created.id,
            amountMinorUnits: dto.amountMinorUnits,
          }),
        });

        this.logger.log(
          `Reserved ${dto.amountMinorUnits} minor units for payout ${created.id} ` +
            `(tenant ${tenantId}, balance before: ${availableBefore})`,
        );

        return created;
      });
    } catch (error: unknown) {
      // Two concurrent requests can both pass the pre-check above and race into this
      // create — the loser hits the unique constraint on (tenantId, idempotencyKey)
      // rather than creating a genuine duplicate payout. Only treat it as a replay
      // when a key was actually sent; otherwise this is a real, unrelated failure.
      if (dto.idempotencyKey && isUniqueConstraintViolation(error)) {
        const existing = await this.findByIdempotencyKey(tenantId, dto.idempotencyKey);
        if (existing) {
          this.logger.log(
            `Idempotent replay (race) for payout key=${dto.idempotencyKey} -> existing transaction ${existing.id}`,
          );
          return { transactionId: existing.id, status: existing.status };
        }
      }
      throw error;
    }

    try {
      // Step 2: call Daraja, outside the transaction above.
      const credentials = await this.tenantsService.getMpesaCredentialsForPayout(tenantId);

      const darajaResponse = await this.daraja.initiateB2C(credentials, {
        originatorConversationId,
        amount: dto.amountMinorUnits / 100,
        msisdn: dto.msisdn,
        commandId: dto.commandId,
        remarks: dto.remarks,
        occasion: dto.occasion,
      });

      // Step 3: accepted into Safaricom's queue. NOT settled — the money has not
      // moved yet, and only the result callback can say whether it does.
      await this.prisma.withTenantContext(tenantId, (tx) =>
        tx.transaction.update({
          where: { id: transaction.id },
          data: { status: "PROCESSING", conversationId: darajaResponse.ConversationID },
        }),
      );

      await this.auditLog.record({
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: "daraja.b2c_initiated",
        targetType: "Transaction",
        targetId: transaction.id,
        metadata: {
          originatorConversationId,
          conversationId: darajaResponse.ConversationID,
          amountMinorUnits: dto.amountMinorUnits,
          msisdn: maskMsisdn(dto.msisdn),
          commandId: dto.commandId,
        },
      });

      return { transactionId: transaction.id, status: "PROCESSING" };
    } catch (error) {
      this.logger.error(`B2C initiation failed for payout ${transaction.id}`, error as Error);

      // Daraja never accepted the request, so no result callback is coming and the
      // reservation would otherwise strand the tenant's funds in payout_reserved
      // permanently. Release it here, using the SAME balanced pair the callback path
      // uses (LedgerService.releaseEntries) so the two can never disagree about what
      // releasing a reservation means.
      await this.releaseReservation(tenantId, transaction.id, "daraja_initiation_error");

      await this.auditLog.record({
        tenantId,
        actorType: actor.type,
        actorId: actor.id,
        action: "daraja.b2c_failed",
        targetType: "Transaction",
        targetId: transaction.id,
        metadata: { errorMessage: (error as Error).message, amountMinorUnits: dto.amountMinorUnits },
      });

      await this.alerts.send({
        title: "B2C payout initiation failed",
        detail: `Payout ${transaction.id} for tenant ${tenantId} never reached Daraja. Reserved funds have been released.`,
        severity: "warning",
        context: { transactionId: transaction.id, tenantId, errorMessage: (error as Error).message },
      });

      throw error;
    }
  }

  /**
   * Fails the payout and returns its reserved funds to the spendable balance, both in
   * one transaction — a release that commits without the status change (or vice
   * versa) leaves the ledger and the transaction disagreeing about whether the money
   * is spent.
   *
   * PENDING -> FAILED is a legal transition, and this only ever runs on a row still
   * PENDING: it is reached solely from the initiation catch block, before anything
   * has moved the row to PROCESSING.
   */
  private async releaseReservation(tenantId: string, transactionId: string, failureReason: string) {
    await this.prisma.withTenantContext(tenantId, async (tx) => {
      const transaction = await tx.transaction.update({
        where: { id: transactionId },
        data: { status: "FAILED", failureReason },
      });

      await tx.ledgerEntry.createMany({
        data: this.ledger.releaseEntries({
          tenantId,
          transactionId,
          amountMinorUnits: transaction.amountMinorUnits,
        }),
      });
    });
  }

  private async findByIdempotencyKey(tenantId: string, idempotencyKey: string) {
    return this.prisma.withTenantContext(tenantId, (tx) =>
      tx.transaction.findUnique({
        where: { tenantId_idempotencyKey: { tenantId, idempotencyKey } },
      }),
    );
  }
}

// Same duck-typed check as WebhookIngestService — Prisma's unique-constraint
// violation code, without depending on importing the Prisma error class.
function isUniqueConstraintViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2002";
}

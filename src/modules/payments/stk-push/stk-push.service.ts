import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DarajaClient } from "../../../infrastructure/daraja/daraja.client";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { AlertsService } from "../../alerts/alerts.service";
import type { InitiateStkPushDto } from "./initiate-stk-push.dto";
import { TenantsService } from "../../tenants/tenants.service";
import { maskMsisdn } from "../../../common/utils/mask-msisdn";

@Injectable()
export class StkPushService {
  private readonly logger = new Logger(StkPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly daraja: DarajaClient,
    private readonly auditLog: AuditLogService,
    private readonly alerts: AlertsService,
    private readonly tenantsService: TenantsService,
  ) {}

  async initiate(tenantId: string, dto: InitiateStkPushDto) {
    // Each DB write below runs under its own short withTenantContext call, rather
    // than one transaction spanning the whole method — the Daraja HTTP call in
    // between can take seconds, and holding a Postgres transaction open across an
    // external network call for that long is its own bug (connection pool pressure,
    // held locks) independent of tenant isolation.

    // Step 1: Create transaction FIRST
    const transaction = await this.prisma.withTenantContext(tenantId, (tx) =>
      tx.transaction.create({
        data: {
          tenantId,
          channel: "STK_PUSH",
          status: "PENDING",
          amountMinorUnits: dto.amountMinorUnits,
          msisdn: dto.msisdn,
          metadata: dto.metadata as any,
        },
      }),
    );

    try {
      // Step 2: Get credentials and call Daraja ONCE. dto.channel picks which of the
      // tenant's collection-type shortcodes (PAYBILL/TILL) this collects on — see
      // TenantsService.getMpesaCredentialsForPayment.
      const credentials = await this.tenantsService.getMpesaCredentialsForPayment(tenantId, dto.channel);

      const darajaResponse = await this.daraja.initiateStkPush(credentials, {
        amount: dto.amountMinorUnits / 100,
        msisdn: dto.msisdn,
        accountReference: dto.accountReference,
        transactionDesc: dto.transactionDesc,
        transactionType: dto.channel === "TILL" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
      });

      // Step 3: Update transaction with Daraja response
      await this.prisma.withTenantContext(tenantId, (tx) =>
        tx.transaction.update({
          where: { id: transaction.id },
          data: {
            status: "PROCESSING",
            merchantRequestId: darajaResponse.MerchantRequestID,
            checkoutRequestId: darajaResponse.CheckoutRequestID,
          },
        }),
      );

      // Step 4: Audit log
      await this.auditLog.record({
        tenantId,
        actorType: "system",
        action: "daraja.stk_push_initiated",
        targetType: "Transaction",
        targetId: transaction.id,
        metadata: {
          checkoutRequestId: darajaResponse.CheckoutRequestID,
          amountMinorUnits: dto.amountMinorUnits,
          msisdn: maskMsisdn(dto.msisdn),
        },
      });

      return { transactionId: transaction.id, status: "PROCESSING" };
    } catch (error) {
      this.logger.error(`STK push initiation failed for transaction ${transaction.id}`, error as Error);

      // Same reasoning as B2cService.releaseReservation: StkPushSection polls onto
      // this exact field to show the merchant what went wrong, so it needs the real
      // Daraja rejection reason, not a generic bucket label.
      await this.prisma.withTenantContext(tenantId, (tx) =>
        tx.transaction.update({
          where: { id: transaction.id },
          data: { status: "FAILED", failureReason: (error as Error).message ?? "daraja_initiation_error" },
        }),
      );

      await this.auditLog.record({
        tenantId,
        actorType: "system",
        action: "daraja.stk_push_failed",
        targetType: "Transaction",
        targetId: transaction.id,
        metadata: { errorMessage: (error as Error).message, amountMinorUnits: dto.amountMinorUnits },
      });

      await this.alerts.send({
        title: "STK push initiation failed",
        detail: `Transaction ${transaction.id} for tenant ${tenantId} failed to reach Daraja.`,
        severity: "warning",
        context: { transactionId: transaction.id, tenantId, errorMessage: (error as Error).message },
      });

      throw error;
    }
  }
}

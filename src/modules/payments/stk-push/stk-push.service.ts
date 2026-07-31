import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DarajaClient } from "../../../infrastructure/daraja/daraja.client";
import { AuditLogService } from "../../audit-log/audit-log.service";
import { AlertsService } from "../../alerts/alerts.service";
import type { InitiateStkPushDto } from "./initiate-stk-push.dto";
import { TenantsService } from "src/modules/tenants/tenants.service";

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
    // Write PENDING to our own DB FIRST, before calling Safaricom. If Daraja's response
    // is lost to a network error, we still have a record to reconcile against later —
    // "did we ever try this payment" should never depend on a third party's response reaching us.

    const credentials = await this.tenantsService.getMpesaCredentialsForPayment(tenantId);
    const darajaResponse = await this.daraja.initiateStkPush(credentials, {
      amount: dto.amountMinorUnits / 100,
      msisdn: dto.msisdn,
      accountReference: dto.accountReference,
      transactionDesc: dto.transactionDesc,
      transactionType: dto.channel === "TILL" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
    });
    const transaction = await this.prisma.transaction.create({
      data: {
        tenantId,
        channel: "STK_PUSH",
        status: "PENDING",
        amountMinorUnits: dto.amountMinorUnits,
        msisdn: dto.msisdn,
        metadata: dto.metadata as any,
      },
    });

    try {
      const credentials = await this.tenantsService.getMpesaCredentialsForPayment(tenantId);

      const darajaResponse = await this.daraja.initiateStkPush(credentials, {
        amount: dto.amountMinorUnits / 100,
        msisdn: dto.msisdn,
        accountReference: dto.accountReference,
        transactionDesc: dto.transactionDesc,
        transactionType: dto.channel === "TILL" ? "CustomerBuyGoodsOnline" : "CustomerPayBillOnline",
      });
      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: {
          status: "PROCESSING",
          merchantRequestId: darajaResponse.MerchantRequestID,
          checkoutRequestId: darajaResponse.CheckoutRequestID,
        },
      });

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

      await this.prisma.transaction.update({
        where: { id: transaction.id },
        data: { status: "FAILED", failureReason: "daraja_initiation_error" },
      });

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

/** Never log a full phone number in audit trails/alerts — mask the middle digits. */
function maskMsisdn(msisdn: string): string {
  return msisdn.length >= 8 ? `${msisdn.slice(0, 6)}****${msisdn.slice(-2)}` : "****";
}

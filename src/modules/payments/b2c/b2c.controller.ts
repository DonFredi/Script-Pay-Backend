import { Body, Controller, Headers, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { ApiKeyGuard } from "../../../common/guards/api-key.guard";
import { TenantAwareThrottlerGuard } from "../../../common/guards/tenant-aware-throttler.guard";
import { RequireScopes } from "../../../common/decorators/api-key-scopes.decorator";
import { StrictPaymentThrottle } from "../../../common/throttle-tiers";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { initiateB2cSchema, type InitiateB2cDto } from "./initiate-b2c.dto";
import { B2cService } from "./b2c.service";

/**
 * Tenant-to-platform payout initiation, called by a merchant's own backend via
 * x-api-key — hence ApiKeyGuard, not AccessTokenGuard, exactly as on
 * stk-push.controller.ts.
 *
 * Guard ORDER matters: ApiKeyGuard runs first and sets request.tenantId, which
 * TenantAwareThrottlerGuard then reads to rate-limit per-tenant rather than per-IP.
 * Reversing this pair breaks tenant-aware throttling silently.
 *
 * PAYMENTS_DISBURSE, never PAYMENTS_INITIATE: every API key already in the database
 * carries PAYMENTS_INITIATE (it is in the set auto-provisioned on tenant activation),
 * so gating payouts behind it would hand every existing key the ability to drain its
 * tenant's balance the moment this route shipped. A distinct scope means the
 * capability only exists on keys somebody deliberately issued with it.
 */
@Controller("v1/payments/b2c")
@UseGuards(ApiKeyGuard, TenantAwareThrottlerGuard)
export class B2cController {
  constructor(private readonly b2cService: B2cService) {}

  @Post()
  @RequireScopes("PAYMENTS_DISBURSE")
  @StrictPaymentThrottle()
  async initiate(
    @Body(new ZodValidationPipe(initiateB2cSchema)) body: InitiateB2cDto,
    @Req() request: Request & { tenantId: string; apiKeyId?: string },
    // Standard REST idempotency-key convention, in addition to the body field — the
    // usual way an external integration dedupes its own retried HTTP calls.
    @Headers("idempotency-key") idempotencyKeyHeader?: string,
  ) {
    // tenantId comes from the guard, never the body — a caller must not be able to
    // name the account a payout is drawn from.
    return this.b2cService.initiate(
      request.tenantId,
      { ...body, idempotencyKey: body.idempotencyKey ?? idempotencyKeyHeader },
      { type: "api_key", id: request.apiKeyId ?? null },
    );
  }
}

import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { ApiKeyGuard } from "../../../common/guards/api-key.guard";
import { TenantAwareThrottlerGuard } from "../../../common/guards/tenant-aware-throttler.guard";
import { RequireScopes } from "../../../common/decorators/api-key-scopes.decorator";
import { StrictPaymentThrottle } from "../../../common/throttle-tiers";
import { ZodValidationPipe } from "../../../common/pipes/zod-validation.pipe";
import { initiateStkPushSchema, type InitiateStkPushDto } from "./initiate-stk-push.dto";
import { StkPushService } from "./stk-push.service";

/**
 * This endpoint is called by TENANTS via API key (merchant-to-platform), not by
 * dashboard users via Firebase session — hence ApiKeyGuard, not AccessTokenGuard.
 *
 * Guard ORDER matters: ApiKeyGuard runs first and sets request.tenantId, which
 * TenantAwareThrottlerGuard then reads to rate-limit per-tenant rather than per-IP.
 * Reversing this order would break tenant-aware throttling silently.
 */
@Controller("v1/payments/stk-push")
@UseGuards(ApiKeyGuard, TenantAwareThrottlerGuard)
export class StkPushController {
  constructor(private readonly stkPushService: StkPushService) {}

  @Post()
  @RequireScopes("PAYMENTS_INITIATE")
  @StrictPaymentThrottle()
  async initiate(
    @Body(new ZodValidationPipe(initiateStkPushSchema)) body: InitiateStkPushDto,
    @Req() request: Request & { tenantId: string },
  ) {
    return this.stkPushService.initiate(request.tenantId, body);
  }
}

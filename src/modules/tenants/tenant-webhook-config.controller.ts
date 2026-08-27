import { Body, Controller, Post, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { ApiKeyGuard } from "../../common/guards/api-key.guard";
import { TenantAwareThrottlerGuard } from "../../common/guards/tenant-aware-throttler.guard";
import { RequireScopes } from "../../common/decorators/api-key-scopes.decorator";
import { StrictPaymentThrottle } from "../../common/throttle-tiers";
import { ZodValidationPipe } from "../../common/pipes/zod-validation.pipe";
import { setWebhookConfigSchema, type SetWebhookConfigDto } from "./tenant-webhook-config.dto";
import { TenantsService } from "./tenants.service";

/**
 * Called by a tenant's own backend via x-api-key, not a dashboard user — registering
 * where ScriptPay delivers settlement notifications is an integration concern, the
 * same category of call as initiating an STK push, so it gets the same guard choice
 * as stk-push.controller.ts for the same reason (merchant-to-platform, not a human
 * clicking through the dashboard).
 */
@Controller("v1/tenants/webhook-config")
@UseGuards(ApiKeyGuard, TenantAwareThrottlerGuard)
export class TenantWebhookConfigController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Post()
  @RequireScopes("WEBHOOKS_MANAGE")
  @StrictPaymentThrottle() // registering/rotating a webhook endpoint is rare and security-sensitive, same ceiling as API key issuance
  async configure(
    @Body(new ZodValidationPipe(setWebhookConfigSchema)) dto: SetWebhookConfigDto,
    @Req() request: Request & { tenantId: string; apiKeyId?: string },
  ) {
    return this.tenantsService.configureWebhook(request.tenantId, dto.webhookUrl, request.apiKeyId ?? null);
  }
}

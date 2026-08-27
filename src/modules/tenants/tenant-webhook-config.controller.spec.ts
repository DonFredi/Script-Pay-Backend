import { TenantWebhookConfigController } from "./tenant-webhook-config.controller";
import { TenantsService } from "./tenants.service";

describe("TenantWebhookConfigController", () => {
  let controller: TenantWebhookConfigController;
  let tenantsService: TenantsService;

  beforeEach(() => {
    tenantsService = { configureWebhook: jest.fn() } as any;
    controller = new TenantWebhookConfigController(tenantsService);
  });

  it("configures the webhook under the tenant resolved by ApiKeyGuard (request.tenantId), never from the request body", async () => {
    const dto = { webhookUrl: "https://example.com/webhooks/scriptpay" };
    const request = { tenantId: "tenant-1", apiKeyId: "key-1" } as any;
    jest.spyOn(tenantsService, "configureWebhook").mockResolvedValueOnce({
      webhookUrl: dto.webhookUrl,
      webhookSecret: "whsec_abc",
    });

    const result = await controller.configure(dto, request);

    expect(tenantsService.configureWebhook).toHaveBeenCalledWith("tenant-1", dto.webhookUrl, "key-1");
    expect(result).toEqual({ webhookUrl: dto.webhookUrl, webhookSecret: "whsec_abc" });
  });

  it("passes null actor when the guard didn't attach an apiKeyId (defensive — should always be set in practice)", async () => {
    const dto = { webhookUrl: "https://example.com/webhooks/scriptpay" };
    const request = { tenantId: "tenant-1" } as any;
    jest.spyOn(tenantsService, "configureWebhook").mockResolvedValueOnce({} as any);

    await controller.configure(dto, request);

    expect(tenantsService.configureWebhook).toHaveBeenCalledWith("tenant-1", dto.webhookUrl, null);
  });
});

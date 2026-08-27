import { Test, TestingModule } from "@nestjs/testing";
import { createHmac } from "node:crypto";
import { TenantWebhookPollerService } from "./tenant-webhook-poller.service";
import { PrismaPrivilegedService } from "../prisma/prisma-privileged.service";
import { CredentialsEncryptionService } from "../tenants/credentials-encryption.service";
import { AlertsService } from "../alerts/alerts.service";

function delivery(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "del-1",
    tenantId: "tenant-1",
    attempts: 0,
    payload: { transactionId: "tx-1", status: "SETTLED" },
    tenant: { webhookUrl: "https://example.com/webhooks/scriptpay", webhookSecretEncrypted: "enc-secret" },
    ...overrides,
  };
}

describe("TenantWebhookPollerService", () => {
  let service: TenantWebhookPollerService;
  let prisma: PrismaPrivilegedService;
  let encryption: CredentialsEncryptionService;
  let alerts: AlertsService;
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TenantWebhookPollerService,
        {
          provide: PrismaPrivilegedService,
          useValue: { tenantWebhookDelivery: { findMany: jest.fn(), update: jest.fn() } },
        },
        { provide: CredentialsEncryptionService, useValue: { decrypt: jest.fn((v: string) => v.replace("enc-", "plain-")) } },
        { provide: AlertsService, useValue: { send: jest.fn() } },
      ],
    }).compile();

    service = module.get(TenantWebhookPollerService);
    prisma = module.get(PrismaPrivilegedService);
    encryption = module.get(CredentialsEncryptionService);
    alerts = module.get(AlertsService);
  });

  it("delivers a due PENDING row, signs it with the tenant's decrypted secret, and marks it DELIVERED", async () => {
    const row = delivery();
    jest.spyOn(prisma.tenantWebhookDelivery, "findMany").mockResolvedValueOnce([row] as any);
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

    await service.pollPendingDeliveries();

    const expectedBody = JSON.stringify(row.payload);
    const expectedSignature = createHmac("sha256", "plain-secret").update(expectedBody).digest("hex");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.com/webhooks/scriptpay",
      expect.objectContaining({
        method: "POST",
        body: expectedBody,
        headers: expect.objectContaining({ "X-ScriptPay-Signature": `sha256=${expectedSignature}` }),
      }),
    );
    expect(prisma.tenantWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: "del-1" },
      data: { status: "DELIVERED", deliveredAt: expect.any(Date) },
    });
    expect(encryption.decrypt).toHaveBeenCalledWith("enc-secret");
  });

  it("marks a delivery FAILED without attempting a request if the tenant's webhook was unconfigured after enqueue", async () => {
    const row = delivery({ tenant: { webhookUrl: null, webhookSecretEncrypted: null } });
    jest.spyOn(prisma.tenantWebhookDelivery, "findMany").mockResolvedValueOnce([row] as any);

    await service.pollPendingDeliveries();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(prisma.tenantWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: "del-1" },
      data: { status: "FAILED", lastError: "tenant webhook is no longer configured" },
    });
  });

  it("backs off and stays PENDING on a non-2xx response, below the attempt ceiling", async () => {
    const row = delivery({ attempts: 1 });
    jest.spyOn(prisma.tenantWebhookDelivery, "findMany").mockResolvedValueOnce([row] as any);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    await service.pollPendingDeliveries();

    expect(prisma.tenantWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: "del-1" },
      data: { attempts: 2, lastError: "HTTP 500", nextAttemptAt: expect.any(Date) },
    });
    expect(alerts.send).not.toHaveBeenCalled();
  });

  it("marks FAILED and fires a critical alert once the attempt ceiling is reached", async () => {
    const row = delivery({ attempts: 4 }); // this will be the 5th, final attempt
    jest.spyOn(prisma.tenantWebhookDelivery, "findMany").mockResolvedValueOnce([row] as any);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await service.pollPendingDeliveries();

    expect(prisma.tenantWebhookDelivery.update).toHaveBeenCalledWith({
      where: { id: "del-1" },
      data: { status: "FAILED", attempts: 5, lastError: "ECONNREFUSED" },
    });
    expect(alerts.send).toHaveBeenCalledWith(
      expect.objectContaining({ severity: "critical", context: expect.objectContaining({ deliveryId: "del-1" }) }),
    );
  });

  it("does not overlap two concurrent polls", async () => {
    let resolveFirst!: (value: unknown[]) => void;
    const pending = new Promise<unknown[]>((resolve) => (resolveFirst = resolve));
    jest.spyOn(prisma.tenantWebhookDelivery, "findMany").mockReturnValueOnce(pending as any);

    const firstPoll = service.pollPendingDeliveries();
    const secondPoll = service.pollPendingDeliveries();

    resolveFirst([]);
    await Promise.all([firstPoll, secondPoll]);

    expect(prisma.tenantWebhookDelivery.findMany).toHaveBeenCalledTimes(1);
  });
});
